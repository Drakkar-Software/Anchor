"use client"

import { type StoreApi , useStore } from "zustand"

import type { TableStore } from "../types.js"

export type QueueStatusResult = {
  pendingCount: number
  queueSize: number
}

/**
 * React hook that returns the pending mutation count and offline queue size
 * for a single table store.
 *
 * @example
 * const { pendingCount, queueSize } = useQueueStatus(stores.todos)
 */
export function useQueueStatus(
  store: StoreApi<TableStore<any, any, any>>,
): QueueStatusResult {
  const records = useStore(store, (s) => s.records)

  let pendingCount = 0

  for (const row of records.values()) {
    if (row._anchor_pending) {pendingCount++}
  }

  return { pendingCount, queueSize: store.getState().getQueueSize() }
}
