import type {
  FilterDescriptor,
  SortDescriptor,
  TableStoreState,
  TrackedRow,
} from "../types.js"
import { matchRow } from "./matchRow.js"

/**
 * Every row the store holds, in `order`.
 *
 * This projection existed four times, character-identical, in `useQuery`,
 * `useSuspenseQuery`, `useRecords` and privately inside `createTableStore` —
 * which is how three of them kept a behaviour the fourth had already outgrown.
 */
export function selectAllRows<Row>(
  state: Pick<TableStoreState<Row>, "records" | "order">,
): TrackedRow<Row>[] {
  const result: TrackedRow<Row>[] = []

  for (const id of state.order) {
    const record = state.records.get(id)

    if (record) {result.push(record)}
  }

  return result
}

/**
 * The rows belonging to one query.
 *
 * `matchRow` supplies membership and the query's own `sort` supplies position.
 * Nothing is read from the query's registry entry, on purpose: the entry is
 * metadata, and this is what makes an optimistic insert, a realtime event and a
 * store rehydrated from disk all appear in the right query without any of the
 * ~30 writers of `records`/`order` having to know that queries exist.
 *
 * Sorting locally is not an optimisation — `order` is one array shared by the
 * whole table, so without it a screen sorted newest-first would render in
 * whatever order the last unrelated query happened to leave behind, and stay
 * that way until its own next fetch.
 *
 * The limitation this accepts: `limit`/`offset` are NOT applied. A limited
 * query renders whatever an unlimited sibling has already loaded into the same
 * store, because no local information can say which page a row belongs to.
 * Documented rather than half-solved.
 */
export function selectQueryRows<Row>(
  state: Pick<TableStoreState<Row>, "records" | "order">,
  filters?: FilterDescriptor<any>[],
  sort?: SortDescriptor<any>[],
): TrackedRow<Row>[] {
  const rows: TrackedRow<Row>[] = []

  for (const id of state.order) {
    const record = state.records.get(id)

    if (!record) {continue}

    if (filters?.length && !matchRow(record as Record<string, unknown>, filters)) {continue}

    rows.push(record)
  }

  return sort?.length ? sortRows(rows, sort) : rows
}

/**
 * Orders rows by a query's `SortDescriptor`s.
 *
 * Deliberately simple, and it does not try to reproduce a Postgres collation:
 * numbers compare numerically, everything else compares as a string, which is
 * correct for the ids, ISO timestamps and dates a Supabase column returns. The
 * rows already arrived in the server's order, so this exists to keep them in it
 * once they are mixed into a shared array with another query's — not to invent
 * an ordering the server never produced.
 *
 * PostgREST's default is NULLS LAST, so that is the default here too.
 */
export function sortRows<Row>(
  rows: TrackedRow<Row>[],
  sort: SortDescriptor<any>[],
): TrackedRow<Row>[] {
  return Array.from(rows).sort((a, b) => {
    for (const rule of sort) {
      const av = (a as Record<string, unknown>)[rule.column]
      const bv = (b as Record<string, unknown>)[rule.column]
      const aNull = av === null || av === undefined
      const bNull = bv === null || bv === undefined

      // Null placement is absolute: `nullsFirst` decides it outright and
      // `ascending` does not flip it, so this returns before the sign flip.
      if (aNull || bNull) {
        if (aNull && bNull) {continue}

        const nullsFirst = rule.nullsFirst ?? false

        return aNull === nullsFirst ? -1 : 1
      }

      const result = compareValues(av, bv)

      if (result !== 0) {return rule.ascending === false ? -result : result}
    }

    return 0
  })
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {return a - b}

  const as = String(a)
  const bs = String(b)

  return as < bs ? -1 : as > bs ? 1 : 0
}
