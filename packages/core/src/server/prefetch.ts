import type { SupabaseClient } from "@supabase/supabase-js"

import { fromSupabaseError } from "../errors.js"
import { applyFilters, applySort,fromTable } from "../query/queryExecutor.js"
import type { FetchOptions, FilterDescriptor, SortDescriptor } from "../types.js"

export type PrefetchResult<Row> = {
  data: Row[]
  error: Error | null
  fetchedAt: number
}

/**
 * Deserialize prefetched data on the client side.
 */
export function deserializePrefetchResult<Row>(serialized: string): PrefetchResult<Row> {
  try {
    const parsed = JSON.parse(serialized) as {
      data: Row[]
      error: string | null
      fetchedAt: number
    }

    return {
      data: parsed.data,
      error: parsed.error ? new Error(parsed.error) : null,
      fetchedAt: parsed.fetchedAt,
    }
  } catch {
    return {
      data: [],
      error: new Error("Failed to deserialize prefetch result: invalid JSON"),
      fetchedAt: Date.now(),
    }
  }
}

/**
 * Server-side data prefetch for React Server Components.
 * Fetches data from Supabase without creating a Zustand store.
 * The result can be passed to client components for hydration.
 *
 * @example
 * ```tsx
 * // app/todos/page.tsx (Server Component)
 * import { prefetch } from '@drakkar.software/anchor/server'
 *
 * export default async function TodosPage() {
 *   const { data, error } = await prefetch(supabase, 'todos', {
 *     sort: [{ column: 'created_at', ascending: false }],
 *     limit: 50,
 *   })
 *   if (error) return <div>Error: {error.message}</div>
 *   return <TodoList initialData={data} />
 * }
 * ```
 */
export async function prefetch<Row = Record<string, unknown>>(
  supabase: SupabaseClient,
  table: string,
  options?: FetchOptions<Row> & { schema?: string },
): Promise<PrefetchResult<Row>> {
  try {
    let builder = fromTable(supabase, table, options?.schema)
      .select(options?.select ?? "*", {
        count: options?.count,
      })

    if (options?.filters?.length) {
      builder = applyFilters(builder, options.filters as FilterDescriptor[])
    }

    if (options?.sort?.length) {
      builder = applySort(builder, options.sort as SortDescriptor[])
    }

    if (options?.offset != null) {
      const limit = options.limit ?? 1000

      builder = builder.range(options.offset, options.offset + limit - 1)
    } else if (options?.limit != null) {
      builder = builder.limit(options.limit)
    }

    const { data, error } = await builder

    if (error) {
      return { data: [], error: fromSupabaseError(error), fetchedAt: Date.now() }
    }

    return { data: (data ?? []) as Row[], error: null, fetchedAt: Date.now() }
  } catch (error) {
    return {
      data: [],
      error: error instanceof Error ? error : new Error(String(error)),
      fetchedAt: Date.now(),
    }
  }
}

/**
 * Serialize prefetched data for client-side hydration.
 * Converts to a format that can be passed through RSC serialization boundary.
 */
export function serializePrefetchResult<Row>(result: PrefetchResult<Row>): string {
  return JSON.stringify({
    data: result.data,
    error: result.error ? result.error.message : null,
    fetchedAt: result.fetchedAt,
  })
}
