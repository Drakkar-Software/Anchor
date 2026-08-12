"use client"

import { useEffect, useCallback, useRef } from "react"
import { useStore } from "zustand"
import { useShallow } from "zustand/react/shallow"
import type { StoreApi } from "zustand"
import type { TableStore, TrackedRow, FetchOptions } from "../types.js"
import { queryKey, isKeyable } from "../query/queryKey.js"
import { selectQueryRows } from "../query/selectRows.js"

type UseQueryResult<Row> = {
  data: TrackedRow<Row>[]
  isLoading: boolean
  error: Error | null
  /** Total rows matching this query, when `count` was requested. */
  count: number | null
  refetch: () => Promise<TrackedRow<Row>[]>
  isHydrated: boolean
}

type UseQueryOptions<Row> = FetchOptions<Row> & {
  deps?: unknown[]
  enabled?: boolean
  refetchInterval?: number
  staleTime?: number
}

/**
 * Declarative data-fetching hook, scoped to its own query.
 *
 * Two components reading one table with different filters used to collide four
 * ways, all of which came from the store keeping a single global answer: the
 * second component's fetch was suppressed by the first's `lastFetchedAt`, the
 * in-flight promise handed it the first's rows, the response rebuilt `order`
 * for everyone, and `isLoading`/`error` were the table's rather than the
 * query's. Everything this hook reads is now keyed by `queryKey(options)`.
 *
 * A `queryFn` cannot be keyed — it is an opaque function — so a query using one
 * falls back to the table's own flags, which is what every query did before.
 *
 * @param options.staleTime - Time in ms before THIS query is considered stale
 *   and refetched on mount. Defaults to 5000 (5s). Set to 0 to always refetch.
 */
export function useQuery<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
  options?: UseQueryOptions<Row>,
): UseQueryResult<Row> {
  const enabled = options?.enabled ?? true
  const deps = options?.deps ?? []
  const refetchInterval = options?.refetchInterval
  const staleTime = options?.staleTime ?? 5000
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Resolved against the store's own defaults, because that is what `fetch`
  // files the entry under. Keying on the caller's raw options would look up an
  // entry that never exists on any store configured with `defaultFilters`.
  const resolved = store.getState().resolveFetchOptions(stripHookOptions(options))
  const keyable = isKeyable(resolved)
  const key = keyable ? queryKey(resolved) : null
  const { filters, sort } = resolved

  const entry = useStore(store, (s) => (key === null ? undefined : s.queries.get(key)))
  const storeIsLoading = useStore(store, (s) => s.isLoading)
  const storeError = useStore(store, (s) => s.error)
  const isHydrated = useStore(store, (s) => s.isHydrated)

  const data = useStore(
    store,
    useShallow((state: TableStore<Row, InsertRow, UpdateRow>) =>
      selectQueryRows<Row>(state, filters, sort),
    ),
  )

  const fetch = useCallback(async () => {
    return store.getState().fetch(stripHookOptions(optionsRef.current))
  }, [store])

  // Tell the store this query is on screen, so `refetch()` — which the app
  // lifecycle fires on every foreground — replays what is mounted rather than
  // every filter combination the store has ever been handed. Refcounted, so
  // React 18's double-invoked effects cancel out.
  useEffect(() => {
    if (!enabled || key === null) return
    const opts = stripHookOptions(optionsRef.current)
    store.getState().retainQuery(opts)
    return () => { store.getState().releaseQuery(opts) }
  }, [store, enabled, key])

  // Initial fetch, and again whenever the query itself changes. `key` covers
  // filters, sort, select, limit and offset — the last three of which used to
  // change nothing, because the dependency list held only the first two.
  useEffect(() => {
    if (!enabled) return
    if (key !== null) {
      const lastFetchedAt = store.getState().queries.get(key)?.lastFetchedAt
      if (staleTime > 0 && lastFetchedAt && Date.now() - lastFetchedAt < staleTime) return
    }
    // Error is captured in the query's entry; prevent an unhandled rejection.
    fetch().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fetch, key, ...deps])

  // Refetch interval
  useEffect(() => {
    if (!enabled || !refetchInterval) return
    const interval = setInterval(() => { fetch().catch(() => {}) }, refetchInterval)
    return () => clearInterval(interval)
  }, [enabled, refetchInterval, fetch])

  return {
    data,
    // Before this query has an entry — and always, for an unkeyable `queryFn` —
    // there is nothing query-scoped to report, so the table's flags stand in.
    isLoading: entry ? entry.isLoading : storeIsLoading,
    error: entry ? entry.error : storeError,
    count: entry?.count ?? null,
    refetch: fetch,
    isHydrated,
  }
}

/** The four options that belong to the hook, not to the fetch. */
function stripHookOptions<Row>(options?: UseQueryOptions<Row>): FetchOptions<Row> {
  const {
    deps: _deps,
    enabled: _enabled,
    refetchInterval: _refetchInterval,
    staleTime: _staleTime,
    ...fetchOptions
  } = options ?? {}
  return fetchOptions
}
