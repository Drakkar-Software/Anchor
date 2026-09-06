"use client"

import type { SupabaseClient } from "@supabase/supabase-js"
import { useCallback, useEffect,useRef, useState } from "react"

import {
  buildCursorQuery,
  type CursorPaginationOptions,
  type PaginationState,
  processCursorResults,
} from "../query/pagination.js"
import { applyFilters, applySort, fromTable } from "../query/queryExecutor.js"
import type { FilterDescriptor, SortDescriptor } from "../types.js"

export type UseInfiniteQueryOptions<Row> = {
  /** Column to paginate on (must be sortable, e.g. created_at, id) */
  cursorColumn: string & keyof Row

  /** Whether the query is enabled (default: true) */
  enabled?: boolean

  /** Additional filters to apply */
  filters?: FilterDescriptor<Row>[]

  /** Number of items per page (default: 20) */
  pageSize?: number

  /** Schema for non-public tables */
  schema?: string

  /** Select specific columns */
  select?: string

  /** Additional sort rules (cursor column sort is added automatically) */
  sort?: SortDescriptor<Row>[]

  /** Table name */
  table: string
}

export type UseInfiniteQueryResult<Row> = {
  /** All loaded pages flattened into a single array */
  data: Row[]

  /** Error from the last operation */
  error: Error | null

  /** Whether there are more pages to load */
  hasMore: boolean

  /** Whether the initial page is loading */
  isLoading: boolean

  /** Whether a subsequent page is loading */
  isLoadingMore: boolean

  /** Load the next page */
  loadMore: () => Promise<void>

  /** All pages as separate arrays */
  pages: Row[][]

  /** Current pagination state */
  pagination: PaginationState | null

  /** Reset and refetch from the beginning */
  reset: () => Promise<void>
}

/**
 * Infinite scroll / load-more hook built on cursor pagination.
 *
 * @example
 * ```tsx
 * const { data, loadMore, hasMore, isLoadingMore } = useInfiniteQuery(supabase, {
 *   table: 'posts',
 *   cursorColumn: 'created_at',
 *   pageSize: 20,
 * })
 * ```
 */
export function useInfiniteQuery<Row extends Record<string, unknown>>(
  supabase: SupabaseClient,
  options: UseInfiniteQueryOptions<Row>,
): UseInfiniteQueryResult<Row> {
  const {
    cursorColumn,
    enabled = true,
    filters = [],
    pageSize = 20,
    schema,
    select,
    sort = [],
    table,
  } = options

  const [pages, setPages] = useState<Row[][]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [pagination, setPagination] = useState<PaginationState | null>(null)
  const cursorRef = useRef<unknown>(undefined)
  const hasInitiallyFetched = useRef(false)
  const filtersRef = useRef(filters)
  const sortRef = useRef(sort)

  useEffect(() => {
    filtersRef.current = filters
    sortRef.current = sort
  }, [filters, sort])

  const fetchPage = useCallback(async (cursor: unknown, isInitial: boolean) => {
    if (isInitial) {
      setIsLoading(true)
    } else {
      setIsLoadingMore(true)
    }

    setError(null)

    try {
      const cursorOpts: CursorPaginationOptions<Row> = {
        cursor: cursor ?? undefined,
        cursorColumn,
        direction: "forward",
        pageSize,
      }

      const { filters: cursorFilters, limit, sort: cursorSort } = buildCursorQuery(cursorOpts)
      const currentFilters = filtersRef.current
      const currentSort = sortRef.current

      let query = fromTable(supabase, table, schema)
        .select(select ?? "*")

      // Apply user filters + cursor filters
      query = applyFilters(query, [...currentFilters as FilterDescriptor[], ...cursorFilters as FilterDescriptor[]])

      // Apply user sort + cursor sort (cursor sort takes precedence for pagination correctness)
      query = applySort(query, [...currentSort as SortDescriptor[], ...cursorSort as SortDescriptor[]])
      query = query.limit(limit)

      const { data, error: queryError } = await query

      if (queryError) {
        throw new Error((queryError).message ?? String(queryError))
      }

      const rows = (data ?? []) as Row[]
      const result = processCursorResults(rows, cursorOpts)

      cursorRef.current = result.pagination.cursor
      setPagination(result.pagination)

      if (isInitial) {
        setPages([result.data])
      } else {
        setPages((prev) => [...prev, result.data])
      }
    } catch (error_) {
      setError(error_ instanceof Error ? error_ : new Error(String(error_)))
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [supabase, table, schema, cursorColumn, pageSize, select])

  // Auto-fetch first page (must not run during render — React can replay it)
  useEffect(() => {
    if (!enabled || hasInitiallyFetched.current) {return}

    hasInitiallyFetched.current = true
    void fetchPage(undefined, true)
  }, [enabled, fetchPage])

  const loadMore = useCallback(async () => {
    if (isLoadingMore || isLoading || !pagination?.hasNextPage) {return}

    await fetchPage(cursorRef.current, false)
  }, [fetchPage, isLoadingMore, isLoading, pagination?.hasNextPage])

  const reset = useCallback(async () => {
    setPages([])
    cursorRef.current = undefined
    setPagination(null)
    await fetchPage(undefined, true)
  }, [fetchPage])

  const data = pages.flat()

  return {
    data,
    error,
    hasMore: pagination?.hasNextPage ?? false,
    isLoading,
    isLoadingMore,
    loadMore,
    pages,
    pagination,
    reset,
  }
}
