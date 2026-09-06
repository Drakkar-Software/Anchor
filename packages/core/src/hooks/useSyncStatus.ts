"use client"

import { useCallback, useRef,useSyncExternalStore } from "react"
import type { StoreApi } from "zustand"

import type { NetworkStatusAdapter,TableStore } from "../types.js"

export type SyncStatus = "synced" | "syncing" | "offline" | "error"

export type SyncStatusResult = {
  failedCount: number
  isSyncing: boolean
  lastSyncedAt: number | null
  pendingCount: number
  status: SyncStatus
}

/**
 * Pure computation of sync status from multiple stores.
 * Exported for direct use and testing without React.
 */
export function computeSyncStatus(
  stores: StoreApi<TableStore<any, any, any>>[],
  network?: NetworkStatusAdapter,
): SyncStatusResult {
  let pendingCount = 0
  let failedCount = 0
  let isSyncing = false
  let oldestFetch: number | null = null
  let hasError = false

  for (const store of stores) {
    const state = store.getState()

    if (state.isLoading) {isSyncing = true}

    if (state.error) {
      hasError = true
      failedCount++
    }

    for (const row of state.records.values()) {
      if (row._anchor_pending) {pendingCount++}
    }

    if (state.lastFetchedAt !== null && (oldestFetch === null || state.lastFetchedAt < oldestFetch)) {
        oldestFetch = state.lastFetchedAt
      }
  }

  const isOffline = network ? !network.isOnline() : false

  let status: SyncStatus = "synced"

  if (hasError) {status = "error"}
  else if (isOffline) {status = "offline"}
  else if (isSyncing || pendingCount > 0) {status = "syncing"}

  return { failedCount, isSyncing, lastSyncedAt: oldestFetch, pendingCount, status }
}

/**
 * React hook that aggregates sync status across multiple table stores.
 *
 * @example
 * const { status, pendingCount } = useSyncStatus([stores.todos, stores.users])
 * // status: "synced" | "syncing" | "offline" | "error"
 */
export function useSyncStatus(
  stores: StoreApi<TableStore<any, any, any>>[],
  options?: { network?: NetworkStatusAdapter },
): SyncStatusResult {
  const network = options?.network

  const cachedRef = useRef<SyncStatusResult>({
    failedCount: 0,
    isSyncing: false,
    lastSyncedAt: null,
    pendingCount: 0,
    status: "synced",
  })

  // `stores` is the dependency list itself: same store instances keep
  // `subscribe` stable even when the caller allocates a fresh array literal.
  const subscribe = useCallback((onStoreChange: () => void) => {
    const unsubs = stores.map((s) => s.subscribe(onStoreChange))

    return () => { unsubs.forEach((u) => { u(); }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `stores` IS the dependency array (instance identity)
  }, stores)

  const getSnapshot = () => {
    const next = computeSyncStatus(stores, network)
    const prev = cachedRef.current

    if (
      prev.pendingCount === next.pendingCount &&
      prev.isSyncing === next.isSyncing &&
      prev.lastSyncedAt === next.lastSyncedAt &&
      prev.failedCount === next.failedCount &&
      prev.status === next.status
    ) {
      return prev
    }

    cachedRef.current = next

    return next
  }

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
