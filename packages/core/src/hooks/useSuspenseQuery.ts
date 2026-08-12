"use client"

import { useStore } from "zustand"
import { useShallow } from "zustand/react/shallow"
import type { StoreApi } from "zustand"
import type { TableStore, TrackedRow, FetchOptions } from "../types.js"
import { queryKey, isKeyable } from "../query/queryKey.js"
import { selectQueryRows } from "../query/selectRows.js"

/**
 * Keyed by store AND by query.
 *
 * Keying by store alone meant two suspense boundaries reading one table with
 * different filters shared one promise: the second waited on the first's fetch
 * and then rendered its rows. The outer `WeakMap` still lets a discarded store
 * be collected along with all of its promises.
 */
const suspenseCache = new WeakMap<StoreApi<any>, Map<string, Promise<unknown>>>()

/** Slot for a `queryFn` read, which has no key of its own. */
const UNKEYED = "\u0001unkeyed"

function promisesFor(store: StoreApi<any>): Map<string, Promise<unknown>> {
  let map = suspenseCache.get(store)
  if (!map) {
    map = new Map()
    suspenseCache.set(store, map)
  }
  return map
}

/**
 * React Suspense-compatible query hook.
 * Throws a promise while data is loading (for use with Suspense boundaries).
 * Returns data directly when available.
 */
export function useSuspenseQuery<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
  options?: FetchOptions<Row>,
): TrackedRow<Row>[] {
  const resolved = store.getState().resolveFetchOptions(options)
  // An opaque `queryFn` cannot be keyed, so it registers no entry. Reading the
  // table's own state for it is what every query did before per-query scoping;
  // looking up an entry that will never exist would suspend forever and refetch
  // on every render.
  const keyable = isKeyable(resolved)
  const key = keyable ? queryKey(resolved) : null
  const { filters, sort } = resolved

  // Call hooks unconditionally FIRST (Rules of Hooks)
  const data = useStore(
    store,
    useShallow((s: TableStore<Row, InsertRow, UpdateRow>) =>
      selectQueryRows<Row>(s, filters, sort),
    ),
  )

  // THEN do Suspense throw logic
  const state = store.getState()
  const entry = key === null ? undefined : state.queries.get(key)
  const settledAt = key === null ? state.lastFetchedAt : entry?.lastFetchedAt
  const failure = key === null ? state.error : entry?.error

  // Errors terminate the cycle, so this has to come BEFORE the suspend branch.
  // A failed fetch never stamps `lastFetchedAt` — deliberately, so `staleTime`
  // cannot treat a refusal as fresh data — which meant a query the server
  // rejects took the suspend branch on every render, refetched, threw a fresh
  // promise, and hammered the endpoint while the error boundary never saw it.
  if (failure) {
    throw failure
  }

  // If THIS query hasn't been fetched yet (initial load or loading in progress)
  if (!settledAt) {
    const promises = promisesFor(store)
    // One shared slot for the unkeyable case, matching the pre-2.1.0 behaviour
    // of a single promise per store.
    const cacheKey = key ?? UNKEYED
    let promise = promises.get(cacheKey)
    if (!promise) {
      const loading = key === null ? state.isLoading : entry?.isLoading
      if (loading) {
        // A fetch of this same query is in progress — wait for it.
        promise = new Promise<void>((resolve) => {
          const unsub = store.subscribe((s) => {
            const next = s as TableStore<Row, InsertRow, UpdateRow>
            const current = key === null ? undefined : next.queries.get(key)
            const done =
              key === null
                ? !next.isLoading || next.lastFetchedAt
                : !current?.isLoading || current?.lastFetchedAt
            if (done) {
              unsub()
              resolve()
            }
          })
        })
      } else {
        // No fetch in progress — trigger one
        promise = store.getState().fetch(options)
      }
      promise.catch(() => {})
      promises.set(cacheKey, promise)
      // Clear cache so retries can trigger a new fetch.
      // Also set a safety timeout in case the fetch hangs indefinitely.
      const timeout = setTimeout(() => promises.delete(cacheKey), 30_000)
      promise.finally(() => {
        clearTimeout(timeout)
        promises.delete(cacheKey)
      })
    }
    throw promise
  }

  return data
}
