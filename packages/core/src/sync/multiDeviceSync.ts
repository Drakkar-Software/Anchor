import type { SupabaseClient } from "@supabase/supabase-js"
import type { StoreApi } from "zustand"
import type {
  TableStore,
  TrackedRow,
  ConflictConfig,
  ConflictContext,
} from "../types.js"
import { resolveConflict } from "../mutation/conflictResolution.js"
import { buildPkFilter } from "../utils/compositeKey.js"

export type MultiDeviceSyncOptions = {
  /** Unique device identifier (auto-generated if not provided) */
  deviceId?: string
  /** Realtime channel name (default: "anchor:device-sync") */
  channelName?: string
  /** Conflict resolution config */
  conflict?: ConflictConfig
  /** Debounce outgoing broadcasts in ms (default: 1000) */
  debounceMs?: number
  /** Subset of table names to sync (default: all) */
  tables?: string[]
  /**
   * Each synced table's real primary key, by table name — needed to build a
   * correct `ConflictContext.primaryKey` when `conflict` is set. A table not
   * listed here defaults to `"id"`, which was this function's only behavior
   * before this option existed: every conflict context reported `{ id }`
   * regardless of the table's actual key, silently wrong for any table whose
   * store was configured with a different `primaryKey`.
   */
  primaryKeys?: Record<string, string | string[]>
}

type BroadcastPayload = {
  deviceId: string
  table: string
  records: [string | number, Record<string, unknown>][]
  order: (string | number)[]
  timestamp: number
}

/**
 * Sync store state across devices using Supabase Realtime broadcast.
 * Returns a cleanup function.
 */
export function setupMultiDeviceSync(
  supabase: SupabaseClient,
  stores: Record<string, StoreApi<TableStore<any, any, any>>>,
  options?: MultiDeviceSyncOptions,
): () => void {
  const deviceId =
    options?.deviceId ??
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2))
  const channelName = options?.channelName ?? "anchor:device-sync"
  const debounceMs = options?.debounceMs ?? 1000
  const syncTables = options?.tables
    ? new Set(options.tables)
    : null

  const channel = supabase.channel(channelName)
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const unsubscribers: (() => void)[] = []
  let receiving = false
  // Track previous snapshots per table for delta computation
  const prevSnapshots = new Map<string, Map<string | number, Record<string, unknown>>>()

  // Handle incoming broadcasts
  channel.on("broadcast", { event: "sync" }, (payload: { payload: BroadcastPayload }) => {
    const data = payload.payload
    if (data.deviceId === deviceId) return // Ignore own broadcasts

    const tableName = data.table
    const store = stores[tableName]
    if (!store) return
    if (syncTables && !syncTables.has(tableName)) return

    receiving = true
    try {
      store.setState((prev: any) => {
        const records = new Map(prev.records)
        const order = [...prev.order] as (string | number)[]
        const orderSet = new Set(order)
        const idsToRemove: (string | number)[] = []

        for (const [id, remoteRow] of data.records) {
          const existing = records.get(id) as TrackedRow<any> | undefined

          // Don't overwrite pending mutations
          if (existing?._anchor_pending) continue

          if (existing && options?.conflict) {
            const context: ConflictContext = {
              table: tableName,
              primaryKey: buildPkFilter(options?.primaryKeys?.[tableName] ?? "id", id),
              hasPendingMutations: false,
              pendingMutations: [],
            }
            const resolved = resolveConflict(existing, remoteRow as any, options.conflict, context)
            if (resolved === null) {
              records.delete(id)
              idsToRemove.push(id)
              orderSet.delete(id)
            } else {
              records.set(id, resolved as any)
            }
          } else {
            records.set(id, remoteRow as any)
            if (!orderSet.has(id)) {
              order.push(id)
              orderSet.add(id)
            }
          }
        }

        // Batch-filter removed IDs from order (avoids O(n) indexOf per deletion)
        const finalOrder = idsToRemove.length > 0
          ? order.filter((id) => !idsToRemove.includes(id))
          : order

        return { ...prev, records, order: finalOrder }
      })
    } finally {
      receiving = false
    }
  })

  channel.subscribe()

  // Watch for store changes and broadcast only the delta
  for (const [tableName, store] of Object.entries(stores)) {
    if (syncTables && !syncTables.has(tableName)) continue

    // Initialize snapshot
    prevSnapshots.set(tableName, new Map(store.getState().records as Map<string | number, Record<string, unknown>>))

    const unsub = store.subscribe(() => {
      if (receiving) return // Don't broadcast received changes

      // Debounce per table
      const existing = timers.get(tableName)
      if (existing) clearTimeout(existing)

      timers.set(
        tableName,
        setTimeout(() => {
          timers.delete(tableName)
          const state = store.getState()
          const currentRecords = state.records as Map<string | number, Record<string, unknown>>
          const prev = prevSnapshots.get(tableName) ?? new Map()

          // Compute delta: only changed or new records
          const delta: [string | number, Record<string, unknown>][] = []
          for (const [id, row] of currentRecords) {
            if (prev.get(id) !== row) {
              delta.push([id, row])
            }
          }

          // Skip broadcast if nothing changed
          if (delta.length === 0) {
            prevSnapshots.set(tableName, new Map(currentRecords))
            return
          }

          const payload: BroadcastPayload = {
            deviceId,
            table: tableName,
            records: delta,
            order: state.order,
            timestamp: Date.now(),
          }
          channel.send({
            type: "broadcast",
            event: "sync",
            payload,
          })

          prevSnapshots.set(tableName, new Map(currentRecords))
        }, debounceMs),
      )
    })

    unsubscribers.push(unsub)
  }

  return () => {
    for (const unsub of unsubscribers) unsub()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    supabase.removeChannel(channel)
  }
}
