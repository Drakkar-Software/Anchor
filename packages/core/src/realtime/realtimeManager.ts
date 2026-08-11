import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js"
import type { SyncLogger, RealtimeEvent, FilterDescriptor } from "../types.js"
import { noopLogger } from "../types.js"
import { toRealtimeFilter } from "./realtimeFilter.js"

type SubscriptionStatus = "disconnected" | "connecting" | "connected" | "error"

type TableSubscription = {
  table: string
  schema: string
  channel: RealtimeChannel
  status: SubscriptionStatus
  cleanup: () => void
}

type SubscribeOptions<Row> = {
  table: string
  schema?: string
  primaryKey: string
  events?: RealtimeEvent[]
  filter?: string | FilterDescriptor[]
  /**
   * Restrict the postgres_changes payload to these columns (server-side
   * projection). Must include `primaryKey` — Anchor's records/order maps are
   * keyed on it, and a payload missing it cannot be applied to the store.
   */
  select?: string[]
  onInsert: (row: Row) => void
  onUpdate: (row: Row) => void
  onDelete: (oldRow: Partial<Row>) => void
  onStatus: (status: SubscriptionStatus) => void
}

type RealtimeManagerOptions = {
  supabase: SupabaseClient
  logger?: SyncLogger
}

/**
 * Manages Supabase Realtime channel subscriptions per table.
 */
export class RealtimeManager {
  private supabase: SupabaseClient
  private subscriptions = new Map<string, TableSubscription>()
  private logger: SyncLogger

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
      table,
      schema = "public",
      primaryKey,
      events = ["*"],
      filter,
      select,
      onInsert,
      onUpdate,
      onDelete,
      onStatus,
    } = options

    // select is a server-side column projection: a payload missing the
    // primary key cannot be applied to records/order, so require it up front
    // rather than corrupting store state on the first event.
    if (select && !select.includes(primaryKey)) {
      throw new Error(
        `[anchor] realtime subscribe(${table}): "select" must include the primary key ("${primaryKey}") — ` +
          `payloads without it cannot be keyed into the store.`,
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
        eventFilter["filter"] = resolvedFilter
      }
      if (select) {
        eventFilter["select"] = select
      }

      channel.on(
        "postgres_changes" as any,
        eventFilter as any,
        (payload: any) => {
          const eventType = payload.eventType as string

          this.logger.realtimeEvent(table, eventType)

          switch (eventType) {
            case "INSERT":
              onInsert(payload.new as Row)
              break
            case "UPDATE":
              onUpdate(payload.new as Row)
              break
            case "DELETE":
              onDelete(payload.old as Partial<Row>)
              break
          }
        },
      )
    }

    const cleanup = () => {
      this.supabase.removeChannel(channel)
      onStatus("disconnected")
    }

    // Store subscription BEFORE subscribing (callback may fire synchronously)
    const sub: TableSubscription = {
      table,
      schema,
      channel,
      status: "connecting",
      cleanup,
    }
    this.subscriptions.set(table, sub)

    // Subscribe to the channel
    channel.subscribe((status: string) => {
      let mappedStatus: SubscriptionStatus
      switch (status) {
        case "SUBSCRIBED":
          mappedStatus = "connected"
          break
        case "CHANNEL_ERROR":
          mappedStatus = "error"
          break
        case "CLOSED":
          mappedStatus = "disconnected"
          break
        default:
          mappedStatus = "connecting"
      }
      sub.status = mappedStatus
      onStatus(mappedStatus)
    })

    return () => this.unsubscribe(table)
  }

  unsubscribe(table: string): void {
    const sub = this.subscriptions.get(table)
    if (sub) {
      sub.cleanup()
      this.subscriptions.delete(table)
    }
  }

  /**
   * Pause all realtime subscriptions (unsubscribes channels but remembers them).
   * Use on sign-out or app background. Call resume() to resubscribe.
   */
  pause(): void {
    for (const [, sub] of this.subscriptions) {
      this.supabase.removeChannel(sub.channel)
      sub.status = "disconnected"
    }
  }

  destroy(): void {
    const tables = [...this.subscriptions.keys()]
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
