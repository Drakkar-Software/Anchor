"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import type { StoreApi } from "zustand"
import type { TableStore } from "../types.js"

export type UseLinkedQueryResult<T> = {
  data: T | undefined
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

// Module-level cache: persists { data, lastFetchedAt } across component unmount/remount.
// Keyed by queryKey option — survives back-navigation, avoids re-fetching fresh data.
const queryCache = new Map<string, { lastFetchedAt: number; data: unknown }>()

/**
 * Custom async query that auto-refetches when linked stores mutate.
 *
 * Use for queries with joins or complex selects that can't use `useQuery`
 * directly but should still react to optimistic mutations on related stores.
 *
 * @example
 * ```tsx
 * const { data, isLoading } = useLinkedQuery(
 *   () => fetchOfferApplications(supabase, offerId),
 *   {
 *     stores: [stores.applications],
 *     deps: [offerId],
 *     enabled: !!offerId,
 *   },
 * )
 * ```
 *
 * @example List → detail with instant cache (stale-while-revalidate)
 * ```tsx
 * // List hook — populates the store as a side-effect
 * const { data: offers } = useLinkedQuery(
 *   () => fetchOffers(supabase),
 *   { stores: [stores.offers], mergeToStore: stores.offers },
 * )
 *
 * // Detail hook — reads from the store immediately, refreshes in background
 * const { data: offer } = useLinkedQuery(
 *   () => fetchOffer(supabase, id),
 *   {
 *     stores: [stores.offers],
 *     deps: [id],
 *     initialData: () => stores.offers.getState().records.get(id),
 *   },
 * )
 * ```
 */
export function useLinkedQuery<T>(
  queryFn: () => Promise<T>,
  options?: {
    stores?: StoreApi<TableStore<any, any, any>>[]
    deps?: unknown[]
    enabled?: boolean
    /**
     * Seed the initial data before the first fetch resolves.
     * Accepts a value or a getter function called once on mount.
     * When initial data is provided, `isLoading` starts as `false` and the
     * network fetch still fires in the background (stale-while-revalidate).
     */
    initialData?: T | (() => T | undefined)
    /**
     * Write successful query results back into this store via `mergeRecords()`.
     * Only applies when the result is an array — no-op otherwise.
     * Enables list queries to populate the store so detail queries can use
     * `initialData` to serve cached records instantly.
     */
    mergeToStore?: StoreApi<TableStore<any, any, any>>
    /**
     * Time in ms before data is considered stale. When data is fresh (fetched
     * within this window), mount- and dep-change-triggered refetches are skipped
     * and `isLoading` stays `false` — serving the existing data as stale-while-
     * revalidate. Defaults to `0` (always refetch, existing behaviour).
     *
     * Refetches triggered by a linked store mutation always bypass this guard
     * so optimistic writes stay reactive.
     *
     * Combine with `queryKey` for cross-remount SWR (e.g. back-navigation).
     * Without `queryKey`, the timer resets on component unmount.
     */
    staleTime?: number
    /**
     * Stable string key for cross-remount staleTime tracking. When provided
     * with `staleTime > 0`, the fetch timestamp and cached data survive
     * component unmount so back-navigation doesn't re-fetch within the
     * staleTime window. Must be unique across all `useLinkedQuery` calls —
     * include entity type and any filter params (e.g. `"offers:${userId}"`).
     */
    queryKey?: string
  },
): UseLinkedQueryResult<T> {
  const enabled = options?.enabled ?? true
  const deps = options?.deps ?? []
  const linkedStores = options?.stores ?? []
  const mergeToStore = options?.mergeToStore
  const staleTime = options?.staleTime ?? 0
  const cacheKey = options?.queryKey

  const cachedEntry = cacheKey ? queryCache.get(cacheKey) : undefined

  const resolveInitialData = (): T | undefined => {
    const raw = options?.initialData
    return typeof raw === "function" ? (raw as () => T | undefined)() : raw
  }

  // initialData takes priority over cache; cache is the fallback for cross-remount SWR
  const initialValue = resolveInitialData() ?? (cachedEntry?.data as T | undefined)
  const hasInitialData = initialValue !== undefined

  const [data, setData] = useState<T | undefined>(initialValue)
  const [isLoading, setIsLoading] = useState(enabled && !hasInitialData)
  const [error, setError] = useState<Error | null>(null)

  const queryFnRef = useRef(queryFn)
  queryFnRef.current = queryFn
  const generationRef = useRef(0)
  const mergeToStoreRef = useRef(mergeToStore)
  mergeToStoreRef.current = mergeToStore
  // Flag to suppress store subscription during own mergeToStore writes
  const isMergingRef = useRef(false)
  // Tracks whether we already have data to display (suppresses isLoading during background SWR refetch)
  const hasDataRef = useRef(hasInitialData)
  // Timestamp of last successful fetch — seeded from module-level cache for cross-remount SWR
  const lastFetchedAtRef = useRef<number | null>(cachedEntry?.lastFetchedAt ?? null)
  // Tracks storeVersion at last effect execution to detect store-mutation-driven refetches
  const prevStoreVersionRef = useRef(0)

  // Track store mutation version — increments when any linked store's records change
  const [storeVersion, setStoreVersion] = useState(0)

  useEffect(() => {
    if (linkedStores.length === 0) return

    // Capture initial records refs to avoid refetching on mount
    const prevRecords = linkedStores.map((s) => s.getState().records)

    const unsubs = linkedStores.map((store, i) =>
      store.subscribe((state) => {
        if (state.records !== prevRecords[i]) {
          prevRecords[i] = state.records
          // Skip version bump when this hook's own mergeToStore caused the change
          if (!isMergingRef.current) {
            setStoreVersion((v) => v + 1)
          }
        }
      }),
    )
    return () => unsubs.forEach((u) => u())
    // Re-subscribe only when the store array identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedStores.length, ...linkedStores])

  const refetch = useCallback(async () => {
    const gen = ++generationRef.current
    if (!hasDataRef.current) {
      setIsLoading(true)
    }
    setError(null)
    try {
      const result = await queryFnRef.current()
      if (gen === generationRef.current) {
        setData(result)
        hasDataRef.current = result !== undefined
        const now = Date.now()
        lastFetchedAtRef.current = now
        if (cacheKey) {
          queryCache.set(cacheKey, { lastFetchedAt: now, data: result })
        }
        if (mergeToStoreRef.current && Array.isArray(result)) {
          isMergingRef.current = true
          mergeToStoreRef.current.getState().mergeRecords(result)
          isMergingRef.current = false
        }
      }
    } catch (err) {
      if (gen === generationRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      if (gen === generationRef.current) {
        setIsLoading(false)
      }
    }
    // cacheKey is stable (comes from options literal), safe to include
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey])

  // Fetch on mount, when deps change, or when linked stores mutate
  useEffect(() => {
    if (!enabled) {
      setIsLoading(false)
      return
    }
    const storeVersionChanged = prevStoreVersionRef.current !== storeVersion
    prevStoreVersionRef.current = storeVersion
    if (
      !storeVersionChanged &&
      staleTime > 0 &&
      lastFetchedAtRef.current !== null &&
      Date.now() - lastFetchedAtRef.current < staleTime
    ) {
      return
    }
    refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refetch, staleTime, storeVersion, ...deps])

  return { data, isLoading, error, refetch }
}
