import { describe, expect,it } from "vitest"

import { selectAllRows, selectQueryRows, sortRows } from "./selectRows.js"

type Row = { day: string; id: number; title: string }

function state(rows: Row[], order?: number[]) {
  return {
    order: (order ?? rows.map((r) => r.id)) as (string | number)[],
    records: new Map(rows.map((r) => [r.id as string | number, r as any])),
  }
}

const rows: Row[] = [
  { day: "2026-08-11", id: 1, title: "yesterday" },
  { day: "2026-08-12", id: 2, title: "today a" },
  { day: "2026-08-12", id: 3, title: "today b" },
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
    const desc = selectQueryRows<Row>(s, undefined, [{ ascending: false, column: "id" }])

    expect(desc.map((r) => r.id)).toEqual([3, 2, 1])

    const asc = selectQueryRows<Row>(s, undefined, [{ ascending: true, column: "id" }])

    expect(asc.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it("keeps `order` when the query has no sort of its own", () => {
    const s = state(rows, [3, 1, 2])

    expect(selectQueryRows<Row>(s).map((r) => r.id)).toEqual([3, 1, 2])
  })
})

describe("sortRows", () => {
  const withNulls = [
    { day: "2026-08-12", id: 1, title: "b" },
    { day: null as unknown as string, id: 2, title: "a" },
    { day: "2026-08-11", id: 3, title: "c" },
  ] as Row[]

  it("falls through to the next descriptor on a tie", () => {
    const tied = [
      { day: "2026-08-12", id: 2, title: "b" },
      { day: "2026-08-12", id: 1, title: "a" },
    ] as Row[]

    expect(
      sortRows(tied, [
        { ascending: true, column: "day" },
        { ascending: true, column: "id" },
      ]).map((r) => r.id),
    ).toEqual([1, 2])
  })

  it("puts nulls last by default, matching PostgREST", () => {
    expect(sortRows(withNulls, [{ ascending: true, column: "day" }]).map((r) => r.id)).toEqual([
      3, 1, 2,
    ])
  })

  it("puts nulls first when asked, and does not let `ascending` flip that", () => {
    expect(
      sortRows(withNulls, [{ ascending: true, column: "day", nullsFirst: true }]).map((r) => r.id),
    ).toEqual([2, 3, 1])
    expect(
      sortRows(withNulls, [{ ascending: false, column: "day", nullsFirst: true }]).map((r) => r.id),
    ).toEqual([2, 1, 3])
  })

  it("compares numbers numerically, not as strings", () => {
    const many = [{ id: 10 }, { id: 9 }, { id: 100 }] as Row[]

    expect(sortRows(many, [{ ascending: true, column: "id" }]).map((r) => r.id)).toEqual([
      9, 10, 100,
    ])
  })

  it("does not mutate the array it was given", () => {
    const input = Array.from(rows)

    sortRows(input, [{ ascending: false, column: "id" }])
    expect(input.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it("returns a new array each call, so `useShallow` decides re-renders", () => {
    const s = state(rows)

    expect(selectQueryRows<Row>(s, today)).not.toBe(selectQueryRows<Row>(s, today))

    // ...but element identity is stable, which is what shallow equality reads.
    expect(selectQueryRows<Row>(s, today)[0]).toBe(selectQueryRows<Row>(s, today)[0])
  })
})
