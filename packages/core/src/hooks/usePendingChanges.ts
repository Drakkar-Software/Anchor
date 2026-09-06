"use client"

import { type StoreApi , useStore } from "zustand"

import type { TableStore, TrackedRow } from "../types.js"

export type PendingChange<Row = Record<string, unknown>> = {
  id: string | number
  mutationType: "insert" | "update" | "delete"
  row: TrackedRow<Row>
}

/**
 * React hook that returns all rows with pending optimistic mutations
 * from a single table store.
 *
 * @example
 * const pending = usePendingChanges(stores.todos)
 * // [{ id: 1, row: { ... }, mutationType: "update" }]
 */
export function usePendingChanges<Row extends Record<string, unknown>>(
  store: StoreApi<TableStore<Row, any, any>>,
): PendingChange<Row>[] {
  const records = useStore(store, (s) => s.records)

  const pending: PendingChange<Row>[] = []

  for (const [id, row] of records.entries()) {
    if (row._anchor_pending) {
      pending.push({ id, mutationType: row._anchor_pending, row })
    }
  }

  return pending
}
