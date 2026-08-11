import type { StoreApi } from "zustand"
import type {
  TableStore,
  TrackedRow,
  ConflictConfig,
  ConflictContext,
  RealtimeEvent,
  QueuedMutation,
  FilterDescriptor,
} from "../types.js"
import { RealtimeManager } from "./realtimeManager.js"
import { resolveConflict } from "../mutation/conflictResolution.js"

type BindRealtimeOptions<Row> = {
  table: string
  schema?: string
  primaryKey: string
  events?: RealtimeEvent[]
  filter?: string | FilterDescriptor[]
  /** Restrict the postgres_changes payload to these columns. Must include `primaryKey`. */
  select?: string[]
  conflict?: ConflictConfig<Row>
  /** Optional getter for pending mutations (from OfflineQueue) to populate ConflictContext */
  getPendingMutations?: (table: string) => QueuedMutation[]
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
  const { table, schema, primaryKey, events, filter, select, conflict, getPendingMutations } = options

  return manager.subscribe<Row>({
    table,
    schema,
    primaryKey,
    events,
    filter,
    select,

    onInsert(row: Row) {
      store.setState((prev: any) => {
        const records = new Map(prev.records) as Map<string | number, TrackedRow<Row>>
        const order = [...prev.order] as (string | number)[]
        const id = (row as Record<string, unknown>)[primaryKey] as
          | string
          | number

        // Don't overwrite pending optimistic inserts
        const existing = records.get(id)
        if (existing?._anchor_pending) return prev

        records.set(id, row as TrackedRow<Row>)
        if (!order.includes(id)) order.push(id)
        return { ...prev, records, order }
      })
    },

    onUpdate(row: Row) {
      store.setState((prev: any) => {
        const records = new Map(prev.records) as Map<string | number, TrackedRow<Row>>
        const id = (row as Record<string, unknown>)[primaryKey] as
          | string
          | number
        const existing = records.get(id)

        // Don't overwrite pending mutations
        if (existing?._anchor_pending) return prev

        if (conflict) {
          const pending = getPendingMutations?.(table)?.filter(
            (m) => m.primaryKey[primaryKey] === id,
          ) ?? []
          const context: ConflictContext = {
            table,
            primaryKey: { [primaryKey]: id },
            hasPendingMutations: pending.length > 0,
            pendingMutations: pending,
          }
          const resolved = resolveConflict(existing as TrackedRow<Row> | undefined, row, conflict, context)
          if (resolved === null) {
            records.delete(id)
            const order = (prev.order as (string | number)[]).filter((o) => o !== id)
            return { ...prev, records, order }
          }
          records.set(id, resolved as TrackedRow<Row>)
        } else {
          records.set(id, row as TrackedRow<Row>)
        }

        // Ensure row is in order (may be new to this store)
        const order = [...prev.order] as (string | number)[]
        if (!order.includes(id)) order.push(id)
        return { ...prev, records, order }
      })
    },

    onDelete(oldRow: Partial<Row>) {
      store.setState((prev: any) => {
        const id = (oldRow as Record<string, unknown>)[primaryKey] as
          | string
          | number
          | undefined

        // Guard: PK may be missing if REPLICA IDENTITY is not FULL
        if (id == null) return prev

        const records = new Map(prev.records) as Map<string | number, TrackedRow<Row>>

        // Don't remove rows with pending mutations
        const existing = records.get(id)
        if (existing?._anchor_pending) return prev

        records.delete(id)
        const order = (prev.order as (string | number)[]).filter((o) => o !== id)
        return { ...prev, records, order }
      })
    },

    onStatus(status) {
      store.setState({ realtimeStatus: status } as any)
    },
  })
}
