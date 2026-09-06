import type { FilterDescriptor, FilterOperator, SortDescriptor } from "../types.js"

// ─── Type-safe Filter Helpers ────────────────────────────────────────

export function asc<Row, K extends string & keyof Row>(
  column: K,
  options?: { nullsFirst?: boolean },
): SortDescriptor<Row> {
  return { ascending: true, column, nullsFirst: options?.nullsFirst }
}

/** Contained by (array): column <@ value */
export function containedBy<Row, K extends string & keyof Row>(
  column: K,
  value: unknown,
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "containedBy", value)
}

/** Contains (jsonb/array/range): column @> value */
export function contains<Row, K extends string & keyof Row>(
  column: K,
  value: unknown,
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "contains", value)
}

export function desc<Row, K extends string & keyof Row>(
  column: K,
  options?: { nullsFirst?: boolean },
): SortDescriptor<Row> {
  return { ascending: false, column, nullsFirst: options?.nullsFirst }
}

/** Equal: column = value */
export function eq<Row, K extends string & keyof Row>(
  column: K,
  value: Row[K],
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "eq", value)
}

/** Greater than: column > value */
export function gt<Row, K extends string & keyof Row>(
  column: K,
  value: Row[K],
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "gt", value)
}

/** Greater than or equal: column >= value */
export function gte<Row, K extends string & keyof Row>(
  column: K,
  value: Row[K],
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "gte", value)
}

/** Pattern match (case-insensitive): column ILIKE pattern */
export function ilike<Row, K extends string & keyof Row>(
  column: K,
  pattern: string,
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "ilike", pattern)
}

/** IN check: column IN (values) */
export function inValues<Row, K extends string & keyof Row>(
  column: K,
  values: Row[K][],
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "in", values)
}

/** IS check: column IS value (null, true, false) */
export function is<Row, K extends string & keyof Row>(
  column: K,
  value: null | boolean,
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "is", value)
}

/** Pattern match (case-sensitive): column LIKE pattern */
export function like<Row, K extends string & keyof Row>(
  column: K,
  pattern: string,
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "like", pattern)
}

/** Less than: column < value */
export function lt<Row, K extends string & keyof Row>(
  column: K,
  value: Row[K],
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "lt", value)
}

/** Less than or equal: column <= value */
export function lte<Row, K extends string & keyof Row>(
  column: K,
  value: Row[K],
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "lte", value)
}

/**
 * Match: shorthand for multiple eq filters.
 *
 * Deliberately returns N `eq` descriptors rather than one `op: "match"`, which
 * is why `applyFilters`' `case "match"` is unreachable from here. PostgREST's
 * own `.match()` is sugar for the same N equality predicates, so the two are
 * identical server-side — and the expansion is strictly better locally, because
 * `matchRow` can evaluate `eq` against a row it already holds. A single
 * `op: "match"` descriptor used to be opaque to it and included every row.
 *
 * The `"match"` operator is still honoured end to end for a hand-built
 * descriptor; it is just not what this helper emits.
 */
export function match<Row>(
  query: Partial<Row>,
): FilterDescriptor<Row>[] {
  return Object.entries(query as Record<string, unknown>).map(
    ([column, value]) =>
      ({
        column: column as string & keyof Row,
        op: "eq" as const,
        value,
      }),
  )
}

/** Not equal: column != value */
export function neq<Row, K extends string & keyof Row>(
  column: K,
  value: Row[K],
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "neq", value)
}

/** Overlaps (array/range): column && value */
export function overlaps<Row, K extends string & keyof Row>(
  column: K,
  value: unknown,
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "overlaps", value)
}

// ─── Sort Helpers ────────────────────────────────────────────────────

/** Full-text search: column @@ to_tsquery(query) */
export function textSearch<Row, K extends string & keyof Row>(
  column: K,
  query: string,
  options?: { config?: string; type?: "plain" | "phrase" | "websearch"; },
): FilterDescriptor<Row> {
  return createFilter<Row>(column, "textSearch", { query, ...options })
}

function createFilter<Row>(
  column: string & keyof Row,
  op: FilterOperator,
  value: unknown,
): FilterDescriptor<Row> {
  return { column, op, value }
}
