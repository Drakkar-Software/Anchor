import type { FilterDescriptor } from "../types.js"

/**
 * Does this row satisfy these filters, judged locally?
 *
 * `applyFilters` in `queryExecutor.ts` translates the same `FilterDescriptor`s
 * into a PostgREST builder — it asks the server. This asks the rows already in
 * memory, which is what a per-query read needs in three situations the server
 * cannot answer for: an optimistic insert that has not been sent, a realtime
 * event that arrived between fetches, and a store rehydrated from disk while
 * offline.
 *
 * Two rules decide the behaviour at the edges, and getting either wrong is a
 * visible bug rather than a subtle one:
 *
 * - **An operator this cannot evaluate locally includes the row.** `textSearch`
 *   is Postgres' own text search, `match`/`not`/`or`/`filter` carry PostgREST
 *   syntax rather than a value. Guessing "no" would hide rows the server would
 *   have returned; guessing "yes" shows a row the next fetch may remove. Extra
 *   is recoverable, missing is not.
 * - **A column absent from a pending row includes the row.** An optimistic
 *   insert holds only the columns the caller passed — no server default, no
 *   `created_at`, no trigger output. Evaluating `undefined >= "2026-08-12"` as
 *   false would make the task a user just created vanish from the screen that
 *   created it, and reappear a second later when the insert confirms.
 */
export function matchRow(
  row: Record<string, unknown>,
  filters?: FilterDescriptor<any>[],
): boolean {
  if (!filters?.length) return true
  return filters.every((f) => matchOne(row, f))
}

function matchOne(row: Record<string, unknown>, filter: FilterDescriptor<any>): boolean {
  const { column, op, value } = filter

  if (!(column in row)) {
    // Present but null is a real value and must be judged; genuinely absent is
    // the pending-row case above.
    return true
  }

  const actual = row[column]

  switch (op) {
    case "eq":
      return actual === value
    case "neq":
      return actual !== value
    case "gt":
      return compare(actual, value) > 0
    case "gte":
      return compare(actual, value) >= 0
    case "lt":
      return compare(actual, value) < 0
    case "lte":
      return compare(actual, value) <= 0
    case "like":
      return likeMatch(actual, value, false)
    case "ilike":
      return likeMatch(actual, value, true)
    case "is":
      // PostgREST's `is` is identity against null/true/false, not equality.
      return actual === value
    case "in":
      return Array.isArray(value) && value.includes(actual as never)
    case "contains":
      // Array column contains every element asked for; jsonb is not attempted.
      return Array.isArray(actual) && Array.isArray(value)
        ? value.every((v) => actual.includes(v))
        : true
    case "containedBy":
      return Array.isArray(actual) && Array.isArray(value)
        ? actual.every((v) => value.includes(v))
        : true
    case "overlaps":
      return Array.isArray(actual) && Array.isArray(value)
        ? actual.some((v) => value.includes(v))
        : true
    default:
      // textSearch, match, not, or, filter — see the doc comment.
      return true
  }
}

/**
 * Postgres compares dates and numbers by value and strings by collation. ISO
 * timestamps — which is what a Supabase date column returns — sort correctly as
 * strings, so string comparison covers the common case without pretending to
 * reproduce a collation.
 */
function compare(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (typeof a === "number" && typeof b === "number") return a - b
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

/** `%` is any run, `_` is one character — the SQL wildcards, not a regex. */
function likeMatch(actual: unknown, pattern: unknown, insensitive: boolean): boolean {
  if (typeof actual !== "string" || typeof pattern !== "string") return true
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const source = `^${escaped.replace(/%/g, ".*").replace(/_/g, ".")}$`
  return new RegExp(source, insensitive ? "i" : "").test(actual)
}
