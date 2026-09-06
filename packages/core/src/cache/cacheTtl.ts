import type { StoreApi } from "zustand"

import type { TableStore } from "../types.js"

export type CacheConfig = {
  /** Time in ms before cached data is completely expired and must be refetched (default: 30 minutes) */
  cacheTTL?: number

  /** Time in ms before cached data is considered stale (default: 5 minutes) */
  staleTTL?: number
}

/**
 * Stale-while-revalidate: return cached data immediately,
 * then refetch in the background if stale.
 */
export async function fetchWithSwr<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
  config?: CacheConfig,
): Promise<void> {
  const staleTTL = config?.staleTTL ?? 5 * 60 * 1000
  const cacheTTL = config?.cacheTTL ?? 30 * 60 * 1000

  const state = store.getState()
  const { lastFetchedAt } = state

  // If cache is completely expired, do a blocking fetch
  if (!lastFetchedAt || Date.now() - lastFetchedAt > cacheTTL) {
    await store.getState().fetch()

    return
  }

  // If stale but not expired, serve cached data and refetch in background
  if (Date.now() - lastFetchedAt > staleTTL) {
    store.getState().fetch().catch((error: unknown) => {
      store.setState({ error: error instanceof Error ? error : new Error(String(error)) } as any)
    })
  }

  // Otherwise, data is fresh — do nothing
}

/**
 * Check if the store's cache has completely expired.
 */
export function isExpired(
  store: StoreApi<TableStore<any, any, any>>,
  cacheTTL = 30 * 60 * 1000,
): boolean {
  const { lastFetchedAt } = store.getState()

  if (!lastFetchedAt) {return true}

  return Date.now() - lastFetchedAt > cacheTTL
}

/**
 * Check if the store's data is stale based on lastFetchedAt and staleTTL.
 */
export function isStale(
  store: StoreApi<TableStore<any, any, any>>,
  staleTTL = 5 * 60 * 1000,
): boolean {
  const { lastFetchedAt } = store.getState()

  if (!lastFetchedAt) {return true}

  return Date.now() - lastFetchedAt > staleTTL
}

/**
 * Set up automatic cache expiration check on an interval.
 * Refetches data when it becomes stale.
 */
export function setupAutoRevalidation(
  store: StoreApi<TableStore<any, any, any>>,
  config?: CacheConfig & { checkInterval?: number },
): () => void {
  const checkInterval = config?.checkInterval ?? 60 * 1000 // Check every minute
  const staleTTL = config?.staleTTL ?? 5 * 60 * 1000

  const interval = setInterval(() => {
    if (isStale(store, staleTTL)) {
      store.getState().fetch().catch((error: unknown) => {
      store.setState({ error: error instanceof Error ? error : new Error(String(error)) } as any)
    })
    }
  }, checkInterval)

  return () => { clearInterval(interval); }
}
