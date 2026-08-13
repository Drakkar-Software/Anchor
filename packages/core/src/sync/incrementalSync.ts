import type { SupabaseClient } from "@supabase/supabase-js"
import type { StoreApi } from "zustand"
import type { TableStore, TrackedRow, ConflictConfig, ConflictContext } from "../types.js"
import { fromTable, applyFilters } from "../query/queryExecutor.js"
import { resolveConflict } from "../mutation/conflictResolution.js"
import { fromSupabaseError } from "../errors.js"

export type IncrementalSyncOptions = {
  /** Column to track for delta sync (default: "updated_at") */
  timestampColumn?: string
  /** Schema name (default: "public") */
  schema?: string
  /** Additional filters to narrow the sync scope */
  filters?: import("../types.js").FilterDescriptor[]
}

/**
 * Perform an incremental (delta) sync for a table store.
 * Only fetches rows where timestampColumn > lastSyncAt.
 * Merges results using the configured conflict resolver.
 */
export async function incrementalSync<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  supabase: SupabaseClient,
  table: string,
  primaryKey: string,
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
  options?: IncrementalSyncOptions & { conflict?: ConflictConfig<Row> },
): Promise<{ fetchedCount: number; mergedCount: number }> {
  const timestampColumn = options?.timestampColumn ?? "updated_at"
  const schema = options?.schema

  const state = store.getState()
  const lastSyncAt = state.lastFetchedAt

  // Build query
  let builder = fromTable(supabase, table, schema).select("*")

  if (lastSyncAt) {
    const lastSyncIso = new Date(lastSyncAt).toISOString()
    // Include rows with NULL timestamp (e.g., server-side defaults not yet set)
    // SQL NULL > anything = NULL (falsy), so these would be silently skipped
    builder = builder.or(`${timestampColumn}.gt.${lastSyncIso},${timestampColumn}.is.null`)
  }

  // Apply user-provided filters
  if (options?.filters && options.filters.length > 0) {
    builder = applyFilters(builder, options.filters)
  }

  builder = builder.order(timestampColumn, { ascending: true })

  const { data, error } = await builder

  if (error) {
    throw fromSupabaseError(error)
  }

  const rows = (data ?? []) as Row[]
  let mergedCount = 0

  if (rows.length > 0) {
    store.setState((prev: any) => {
      const records = new Map(prev.records) as Map<string | number, TrackedRow<Row>>
      const order = [...prev.order] as (string | number)[]
      const orderSet = new Set(order)

      for (const row of rows) {
        const id = (row as Record<string, unknown>)[primaryKey] as string | number
        const existing = records.get(id)

        // Don't overwrite pending mutations
        if (existing?._anchor_pending) continue

        if (existing && options?.conflict) {
          const context: ConflictContext = {
            table,
            primaryKey: { [primaryKey]: id },
            hasPendingMutations: false,
            pendingMutations: [],
          }
          const resolved = resolveConflict(existing, row, options.conflict, context)
          if (resolved === null) {
            records.delete(id)
            const idx = order.indexOf(id)
            if (idx >= 0) order.splice(idx, 1)
            orderSet.delete(id)
            mergedCount++
            continue
          } else {
            records.set(id, resolved as TrackedRow<Row>)
            mergedCount++
          }
        } else {
          const isNew = !records.has(id)
          records.set(id, row as TrackedRow<Row>)
          if (isNew) {
            order.push(id)
            orderSet.add(id)
          }
          mergedCount++
        }
      }

      return {
        ...prev,
        records,
        order,
        lastFetchedAt: Date.now(),
      }
    })
  } else {
    store.setState({ lastFetchedAt: Date.now() } as any)
  }

  return { fetchedCount: rows.length, mergedCount }
}
