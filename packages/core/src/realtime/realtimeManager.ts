import type { RealtimeChannel,SupabaseClient } from "@supabase/supabase-js"

import { type FilterDescriptor,noopLogger,type RealtimeEvent, type SyncLogger  } from "../types.js"
import { toRealtimeFilter } from "./realtimeFilter.js"

type RealtimeManagerOptions = {
  logger?: SyncLogger
  supabase: SupabaseClient
}

type SubscribeOptions<Row> = {
  events?: RealtimeEvent[]
  filter?: string | FilterDescriptor[]
  onDelete: (oldRow: Partial<Row>) => void
  onInsert: (row: Row) => void
  onStatus: (status: SubscriptionStatus) => void
  onUpdate: (row: Row) => void
  primaryKey: string
  schema?: string

  /**
   * Restrict the postgres_changes payload to these columns (server-side
   * projection). Must include `primaryKey` — Anchor's records/order maps are
   * keyed on it, and a payload missing it cannot be applied to the store.
   */
  select?: string[]
  table: string
}

type SubscriptionStatus = "disconnected" | "connecting" | "connected" | "error"

type TableSubscription = {
  channel: RealtimeChannel
  cleanup: () => void

  /** Kept so `resume()` can rebuild the subscription it tore down. */
  options: SubscribeOptions<any>

  /**
   * Whether the channel has already been handed back to supabase-js.
   *
   * `pause()` removed the channel and left the entry in place, so a later
   * `destroy()` — which the auth gate fires on `SIGNED_OUT` — called
   * `removeChannel` a second time on a channel that was already gone.
   */
  paused: boolean
  schema: string
  status: SubscriptionStatus
  table: string
}

/**
 * Manages Supabase Realtime channel subscriptions per table.
 */
export class RealtimeManager {
  private readonly supabase: SupabaseClient

  private readonly subscriptions = new Map<string, TableSubscription>()

  private readonly logger: SyncLogger

  constructor(options: RealtimeManagerOptions) {
    this.supabase = options.supabase
    this.logger = options.logger ?? noopLogger
  }

  /**
   * Subscribe to postgres_changes for a table.
   * Returns an unsubscribe function.
   */
  subscribe<Row>(options: SubscribeOptions<Row>): () => void {
    const {
      events = ["*"],
      filter,
      onDelete,
      onInsert,
      onStatus,
      onUpdate,
      primaryKey,
      schema = "public",
      select,
      table,
    } = options

    // select is a server-side column projection: a payload missing the
    // primary key cannot be applied to records/order, so require it up front
    // rather than corrupting store state on the first event.
    if (select && !select.includes(primaryKey)) {
      throw new Error(
        `[anchor] realtime subscribe(${table}): "select" must include the primary key ("${primaryKey}") — ` +
          "payloads without it cannot be keyed into the store.",
      )
    }

    // Unsubscribe from existing subscription for this table
    this.unsubscribe(table)

    const channelName = `anchor:${schema}:${table}`
    const channel = this.supabase.channel(channelName)

    onStatus("connecting")

    const resolvedFilter =
      typeof filter === "string" || filter === undefined
        ? filter
        : toRealtimeFilter(filter).build()

    // Register postgres_changes listeners
    for (const event of events) {
      const eventFilter: Record<string, string | string[]> = {
        event: event === "*" ? "*" : event,
        schema,
        table,
      }

      if (resolvedFilter) {
        eventFilter.filter = resolvedFilter
      }

      if (select) {
        eventFilter.select = select
      }

      channel.on(
        "postgres_changes" as any,
        eventFilter as any,
        (payload: any) => {
          const eventType = payload.eventType as string

          this.logger.realtimeEvent(table, eventType)

          switch (eventType) {
            case "DELETE": {
              onDelete(payload.old as Partial<Row>)

              break
            }
            case "INSERT": {
              onInsert(payload.new as Row)

              break
            }
            case "UPDATE": {
              onUpdate(payload.new as Row)

              break
            }

            default: {
              break
            }
          }
        },
      )
    }

    const cleanup = () => {
      // Idempotent: `pause()` may already have handed the channel back.
      if (!sub.paused) {void this.supabase.removeChannel(channel)}

      sub.paused = true
      onStatus("disconnected")
    }

    // Store subscription BEFORE subscribing (callback may fire synchronously)
    const sub: TableSubscription = {
      channel,
      cleanup,
      options: options as SubscribeOptions<any>,
      paused: false,
      schema,
      status: "connecting",
      table,
    }

    this.subscriptions.set(table, sub)

    // Subscribe to the channel
    channel.subscribe((status: string, err?: Error) => {
      const mappedStatus = mapStatus(status)

      if (mappedStatus === "error") {
        // `err` used to be dropped, so a channel error reached the store as a
        // bare status with no way to find out why.
        this.logger.realtimeError?.(table, status, err)
      }

      sub.status = mappedStatus
      onStatus(mappedStatus)
    })

    return () => { this.unsubscribe(table); }
  }

  unsubscribe(table: string): void {
    const sub = this.subscriptions.get(table)

    if (sub) {
      sub.cleanup()
      this.subscriptions.delete(table)
    }
  }

  /**
   * Hand every channel back to supabase-js, keeping enough to rebuild them.
   *
   * Use on app background. `resume()` puts them back.
   */
  pause(): void {
    for (const [, sub] of this.subscriptions) {
      if (sub.paused) {continue}

      void this.supabase.removeChannel(sub.channel)
      sub.paused = true
      sub.status = "disconnected"
      sub.options.onStatus("disconnected")
    }
  }

  /**
   * Resubscribe everything `pause()` tore down.
   *
   * `pause()`'s docstring has promised this method since it was written and it
   * did not exist, so `appLifecycle`'s `pauseRealtimeOnBackground` was a
   * one-way door: an app that backgrounded once stayed disconnected until it
   * was relaunched.
   */
  resume(): void {
    for (const sub of this.subscriptions.values()) {
      if (!sub.paused) {continue}

      // `subscribe()` unsubscribes the table first, which would remove a
      // channel already handed back — the entry is dropped rather than reused.
      this.subscriptions.delete(sub.table)
      this.subscribe(sub.options)
    }
  }

  destroy(): void {
    const tables = Array.from(this.subscriptions.keys())

    for (const table of tables) {
      this.unsubscribe(table)
    }
  }

  getStatus(): Map<string, SubscriptionStatus> {
    const result = new Map<string, SubscriptionStatus>()

    for (const [table, sub] of this.subscriptions) {
      result.set(table, sub.status)
    }

    return result
  }
}

/**
 * Map a realtime-js subscribe status onto Anchor's four.
 *
 * `TIMED_OUT` used to fall into the `default` arm and report as `"connecting"`,
 * so a channel that had given up looked identical to one still handshaking —
 * forever, since no further status follows. It is a failure, and the UI needs
 * to be able to say so.
 */
function mapStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "CHANNEL_ERROR":
    case "TIMED_OUT": {
      return "error"
    }
    case "CLOSED": {
      return "disconnected"
    }
    case "SUBSCRIBED": {
      return "connected"
    }

    default: {
      return "connecting"
    }
  }
}
