import type { SupabaseClient } from "@supabase/supabase-js"
import type { StoreApi } from "zustand"

import { buildCursorQuery, type CursorPaginationOptions, type PaginationState , processCursorResults } from "../query/pagination.js"
import type {
  ConflictConfig,
  FilterDescriptor,
  TableStore,
} from "../types.js"
import { incrementalSync,type IncrementalSyncOptions  } from "./incrementalSync.js"

export type PrioritizedStore = {
  priority: number
  store: StoreApi<TableStore<any, any, any>>
}

export type SelectiveSyncOptions<Row = Record<string, unknown>> =
  IncrementalSyncOptions & {
    /** Conflict resolution config */
    conflict?: ConflictConfig<Row>

    /** Additional filters to narrow the sync scope */
    filters?: FilterDescriptor<Row>[]
  }

/**
 * Fetch a single page of data using cursor-based pagination.
 * Wraps buildCursorQuery + processCursorResults for convenience.
 */
export async function fetchPage<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
  options: CursorPaginationOptions<Row>,
): Promise<{ data: Row[]; pagination: PaginationState }> {
  const { filters, limit, sort } = buildCursorQuery(options)
  const rows = await store.getState().fetch({ filters, limit, sort })

  return processCursorResults(rows as Row[], options)
}

/**
 * Incremental sync with additional user-defined filters.
 * Only syncs rows matching the given criteria.
 */
export async function selectiveSync<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  supabase: SupabaseClient,
  table: string,
  primaryKey: string,
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
  options?: SelectiveSyncOptions<Row>,
): Promise<{ fetchedCount: number; mergedCount: number }> {
  // selectiveSync delegates to incrementalSync with filters applied via queryFn
  return await incrementalSync(supabase, table, primaryKey, store, {
    conflict: options?.conflict,
    filters: options?.filters,
    schema: options?.schema,
    timestampColumn: options?.timestampColumn,
  })
}

/**
 * Sync multiple stores in priority order (lower number = higher priority).
 * Fetches sequentially to avoid overwhelming the server.
 */
export async function syncAllByPriority(
  stores: PrioritizedStore[],
): Promise<void> {
  const sorted = Array.from(stores).sort((a, b) => a.priority - b.priority)

  for (const { store } of sorted) {
    // Sequential by design — see docstring (avoid saturating the server).
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await store.getState().fetch().catch(() => {})
  }
}
