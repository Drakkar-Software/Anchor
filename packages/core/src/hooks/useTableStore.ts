"use client"

import { useStore } from "zustand"
import { useShallow } from "zustand/react/shallow"
import type { StoreApi } from "zustand"
import type { TableStore, TrackedRow } from "../types.js"
import { selectAllRows } from "../query/selectRows.js"

/**
 * Hook factory: creates a typed hook for a specific table store.
 *
 * @example
 * const useTodos = createTableHook(stores.todos)
 * // In component:
 * const records = useTodos(s => [...s.records.values()])
 */
export function createTableHook<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
  Extensions extends Record<string, unknown> = Record<string, never>,
>(
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow> & Extensions>,
) {
  type S = TableStore<Row, InsertRow, UpdateRow> & Extensions

  function useTableStore(): S
  function useTableStore<U>(selector: (state: S) => U): U
  function useTableStore<U>(selector?: (state: S) => U) {
    return useStore(store, selector as any)
  }

  return useTableStore
}

/**
 * Hook to get all records as an array from a table store.
 * Uses shallow equality to avoid unnecessary re-renders.
 *
 * Whole-store on purpose: this takes no filters, so there is no query to scope
 * it to. Reach for `useQuery` when a component wants its own slice.
 */
export function useRecords<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
): TrackedRow<Row>[] {
  return useStore(
    store,
    useShallow((state: TableStore<Row, InsertRow, UpdateRow>) => selectAllRows<Row>(state)),
  )
}

/**
 * Hook to get a single record by ID.
 */
export function useRecord<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
  id: string | number,
): TrackedRow<Row> | undefined {
  return useStore(store, (state) => state.records.get(id))
}
