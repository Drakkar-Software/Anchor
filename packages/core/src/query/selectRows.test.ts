import { describe, it, expect } from "vitest"
import { selectAllRows, selectQueryRows, sortRows } from "./selectRows.js"

type Row = { id: number; day: string; title: string }

function state(rows: Row[], order?: number[]) {
  return {
    records: new Map(rows.map((r) => [r.id as string | number, r as any])),
    order: (order ?? rows.map((r) => r.id)) as (string | number)[],
  }
}

const rows: Row[] = [
  { id: 1, day: "2026-08-11", title: "yesterday" },
  { id: 2, day: "2026-08-12", title: "today a" },
  { id: 3, day: "2026-08-12", title: "today b" },
]

const today = [{ column: "day", op: "eq" as const, value: "2026-08-12" }]

describe("selectAllRows", () => {
  it("projects in `order`, not in Map insertion order", () => {
    const s = state(rows, [3, 1, 2])
    expect(selectAllRows<Row>(s).map((r) => r.id)).toEqual([3, 1, 2])
  })

  it("skips an id in `order` with no record behind it", () => {
    const s = state(rows, [1, 99, 2])
    expect(selectAllRows<Row>(s).map((r) => r.id)).toEqual([1, 2])
  })

  it("ignores a record that `order` does not mention", () => {
    // This is the shape of the merge bug: present in `records`, absent from
    // `order`, therefore invisible to every projection in the package.
    const s = state(rows, [1])
    expect(selectAllRows<Row>(s)).toHaveLength(1)
  })
})

describe("selectQueryRows", () => {
  it("returns everything when there are no filters", () => {
    expect(selectQueryRows<Row>(state(rows)).map((r) => r.id)).toEqual([1, 2, 3])
    expect(selectQueryRows<Row>(state(rows), []).map((r) => r.id)).toEqual([1, 2, 3])
  })

  it("returns only the rows matching, in `order`", () => {
    expect(selectQueryRows<Row>(state(rows), today).map((r) => r.id)).toEqual([2, 3])
    expect(selectQueryRows<Row>(state(rows, [3, 2, 1]), today).map((r) => r.id)).toEqual([3, 2])
  })

  it("gives two queries their own slices of one record map", () => {
    const s = state(rows)
    const scoped = selectQueryRows<Row>(s, today)
    const all = selectQueryRows<Row>(s)
    expect(scoped).toHaveLength(2)
    expect(all).toHaveLength(3)
  })

  it("does NOT apply limit or offset — the documented limitation", () => {
    // No local information can say which page a row belongs to, so a limited
    // query renders whatever an unlimited sibling loaded into the same store.
    const s = state(rows)
    expect(selectQueryRows<Row>(s, today)).toHaveLength(2)
  })

  it("applies the query's own sort, so it cannot inherit another query's order", () => {
    // `order` is one array shared by the whole table. Without a local sort, a
    // screen showing newest-first renders in whatever order the last unrelated
    // query left behind, and stays that way until its own next fetch.
    const s = state(rows, [1, 2, 3])
    const desc = selectQueryRows<Row>(s, undefined, [{ column: "id", ascending: false }])
    expect(desc.map((r) => r.id)).toEqual([3, 2, 1])
    const asc = selectQueryRows<Row>(s, undefined, [{ column: "id", ascending: true }])
    expect(asc.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it("keeps `order` when the query has no sort of its own", () => {
    const s = state(rows, [3, 1, 2])
    expect(selectQueryRows<Row>(s).map((r) => r.id)).toEqual([3, 1, 2])
  })
})

describe("sortRows", () => {
  const withNulls = [
    { id: 1, day: "2026-08-12", title: "b" },
    { id: 2, day: null as unknown as string, title: "a" },
    { id: 3, day: "2026-08-11", title: "c" },
  ] as Row[]

  it("falls through to the next descriptor on a tie", () => {
    const tied = [
      { id: 2, day: "2026-08-12", title: "b" },
      { id: 1, day: "2026-08-12", title: "a" },
    ] as Row[]
    expect(
      sortRows(tied, [
        { column: "day", ascending: true },
        { column: "id", ascending: true },
      ]).map((r) => r.id),
    ).toEqual([1, 2])
  })

  it("puts nulls last by default, matching PostgREST", () => {
    expect(sortRows(withNulls, [{ column: "day", ascending: true }]).map((r) => r.id)).toEqual([
      3, 1, 2,
    ])
  })

  it("puts nulls first when asked, and does not let `ascending` flip that", () => {
    expect(
      sortRows(withNulls, [{ column: "day", ascending: true, nullsFirst: true }]).map((r) => r.id),
    ).toEqual([2, 3, 1])
    expect(
      sortRows(withNulls, [{ column: "day", ascending: false, nullsFirst: true }]).map((r) => r.id),
    ).toEqual([2, 1, 3])
  })

  it("compares numbers numerically, not as strings", () => {
    const many = [{ id: 10 }, { id: 9 }, { id: 100 }] as Row[]
    expect(sortRows(many, [{ column: "id", ascending: true }]).map((r) => r.id)).toEqual([
      9, 10, 100,
    ])
  })

  it("does not mutate the array it was given", () => {
    const input = [...rows]
    sortRows(input, [{ column: "id", ascending: false }])
    expect(input.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it("returns a new array each call, so `useShallow` decides re-renders", () => {
    const s = state(rows)
    expect(selectQueryRows<Row>(s, today)).not.toBe(selectQueryRows<Row>(s, today))
    // ...but element identity is stable, which is what shallow equality reads.
    expect(selectQueryRows<Row>(s, today)[0]).toBe(selectQueryRows<Row>(s, today)[0])
  })
})
