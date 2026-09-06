import type { StoreApi } from "zustand"

import { resolveConflict } from "../mutation/conflictResolution.js"
import type {
  ConflictConfig,
  ConflictContext,
  FilterDescriptor,
  QueuedMutation,
  RealtimeEvent,
  TableStore,
  TrackedRow,
} from "../types.js"
import type { RealtimeManager } from "./realtimeManager.js"

type BindRealtimeOptions<Row> = {
  conflict?: ConflictConfig<Row>
  events?: RealtimeEvent[]
  filter?: string | FilterDescriptor[]

  /** Optional getter for pending mutations (from OfflineQueue) to populate ConflictContext */
  getPendingMutations?: (table: string) => QueuedMutation[]
  primaryKey: string
  schema?: string

  /** Restrict the postgres_changes payload to these columns. Must include `primaryKey`. */
  select?: string[]
  table: string
}

/**
 * Wires RealtimeManager events to a table store.
 * Protects pending (optimistic) rows from being overwritten.
 */
export function bindRealtimeToStore<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  manager: RealtimeManager,
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
  options: BindRealtimeOptions<Row>,
): () => void {
  const { conflict, events, filter, getPendingMutations, primaryKey, schema, select, table } = options

  return manager.subscribe<Row>({
    events,
    filter,

    onDelete(oldRow: Partial<Row>) {
      store.setState((prev: any) => {
        const id = (oldRow as Record<string, unknown>)[primaryKey] as
          | string
          | number
          | undefined

        // Guard: PK may be missing if REPLICA IDENTITY is not FULL
        if (id == null) {return prev}

        const records = new Map(prev.records) as Map<string | number, TrackedRow<Row>>

        // Don't remove rows with pending mutations
        const existing = records.get(id)

        if (existing?._anchor_pending) {return prev}

        records.delete(id)

        const order = (prev.order as (string | number)[]).filter((o) => o !== id)

        return { ...prev, order, records }
      })
    },

    onInsert(row: Row) {
      store.setState((prev: any) => {
        const records = new Map(prev.records) as Map<string | number, TrackedRow<Row>>
        const order = Array.from(prev.order) as (string | number)[]
        const id = (row as Record<string, unknown>)[primaryKey] as
          | string
          | number

        // Don't overwrite pending optimistic inserts
        const existing = records.get(id)

        if (existing?._anchor_pending) {return prev}

        records.set(id, row as TrackedRow<Row>)

        if (!order.includes(id)) {order.push(id)}

        return { ...prev, order, records }
      })
    },

    onStatus(status) {
      store.setState({ realtimeStatus: status } as any)
    },

    onUpdate(row: Row) {
      store.setState((prev: any) => {
        const records = new Map(prev.records) as Map<string | number, TrackedRow<Row>>
        const id = (row as Record<string, unknown>)[primaryKey] as
          | string
          | number
        const existing = records.get(id)

        // Don't overwrite pending mutations
        if (existing?._anchor_pending) {return prev}

        if (conflict) {
          const pending = getPendingMutations?.(table).filter(
            (m) => m.primaryKey[primaryKey] === id,
          ) ?? []
          const context: ConflictContext = {
            hasPendingMutations: pending.length > 0,
            pendingMutations: pending,
            primaryKey: { [primaryKey]: id },
            table,
          }
          const resolved = resolveConflict(existing as TrackedRow<Row> | undefined, row, conflict, context)

          if (resolved === null) {
            records.delete(id)

            const order = (prev.order as (string | number)[]).filter((o) => o !== id)

            return { ...prev, order, records }
          }

          records.set(id, resolved as TrackedRow<Row>)
        } else {
          records.set(id, row as TrackedRow<Row>)
        }

        // Ensure row is in order (may be new to this store)
        const order = Array.from(prev.order) as (string | number)[]

        if (!order.includes(id)) {order.push(id)}

        return { ...prev, order, records }
      })
    },

    primaryKey,

    schema,

    select,

    table,
  })
}
