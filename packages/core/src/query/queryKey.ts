import type { FetchOptions } from "../types.js"

/**
 * Separator. A control character rather than a comma or a pipe: both of those
 * occur inside a PostgREST select string and inside an `in` value, and a
 * separator that can appear inside a part is a separator that lets two
 * different option sets concatenate into the same key.
 */
const SEP = "\u0001"

/**
 * A stable identity for one query's *shape*, so a store can keep per-query
 * state instead of one global answer.
 *
 * Three properties matter, and every existing key in this package (raw
 * `JSON.stringify` at `hooks/useQuery.ts`, `rpc/rpcAction.ts`,
 * `mutation/offlineQueue.ts`, `hooks/useRealtime.ts`) has none of them:
 *
 * - **Key-order insensitive.** `{column, op, value}` and `{value, op, column}`
 *   describe the same filter, and `JSON.stringify` disagrees. Both spellings
 *   really occur — one hand-written in a component, one out of a builder.
 * - **Value-based.** A component writing `useQuery(store, {filters: [...]})`
 *   inline creates a fresh object every render. Once the key is a React effect
 *   dependency, an identity-based key is an infinite fetch loop rather than a
 *   wrong result: the loudest failure available, and the easiest to ship.
 * - **Narrow.** Only what changes *which rows come back*: filters, sort,
 *   select, limit, offset. `count` asks for a total alongside the same rows and
 *   `cacheStrategy` decides what to do with them afterwards, so keying on
 *   either would fork one logical query into two entries and two requests —
 *   and `clearAndFetch` forces `cacheStrategy: "replace"`, so that fork would
 *   not even be hypothetical.
 */
export function queryKey(options?: FetchOptions<any>): string {
  const filters = (options?.filters ?? [])
    .map((f) => `${f.column}${SEP}${f.op}${SEP}${stableValue(f.value)}`)
    // Filters are ANDed, so their order does not change the result set. Sorting
    // makes two spellings of one predicate set produce one key.
    .sort()
    .join(SEP)

  // Sort order DOES change the result, so this one stays positional.
  const sort = (options?.sort ?? [])
    .map((s) => `${s.column}${s.ascending === false ? "desc" : "asc"}${s.nullsFirst ? "nf" : ""}`)
    .join(SEP)

  return [
    filters,
    sort,
    options?.select ?? "",
    options?.limit ?? "",
    options?.offset ?? "",
  ].join(SEP)
}

/** The key for a fetch with no options at all — "everything this store holds". */
export const EMPTY_QUERY_KEY = queryKey()

/**
 * `queryFn` is an opaque function: two calls with identical bodies are
 * indistinguishable from two with different ones, so it cannot be keyed by
 * value — and it must not fall back to the no-filters key, or a selective
 * sync's narrow result set becomes the answer for an unfiltered `useQuery`
 * (`sync/selectiveSync.ts` routes `incrementalSync` through exactly that path).
 * Callers check this and skip the registry entirely.
 */
export function isKeyable(options?: FetchOptions<any>): boolean {
  return !options?.queryFn
}

/**
 * Values reach a filter as strings, numbers, dates, arrays (`in`, `overlaps`)
 * and objects (`textSearch`'s `{query, type, config}`). `JSON.stringify` is
 * key-order sensitive for the object case, which is the thing this module
 * exists to avoid, so objects go through sorted entries.
 */
function stableValue(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`
  if (value instanceof Date) return `d${value.getTime()}`
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}:${stableValue(v)}`)
      .join(",")}}`
  }
  return String(value)
}
