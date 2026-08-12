import { describe, it, expect } from "vitest"
import { queryKey, isKeyable, EMPTY_QUERY_KEY } from "./queryKey.js"

describe("queryKey", () => {
  it("gives one key to no options and to empty options", () => {
    expect(queryKey()).toBe(EMPTY_QUERY_KEY)
    expect(queryKey({})).toBe(EMPTY_QUERY_KEY)
    expect(queryKey({ filters: [] })).toBe(EMPTY_QUERY_KEY)
  })

  it("separates two different filter sets", () => {
    const a = queryKey({ filters: [{ column: "done", op: "eq", value: true }] })
    const b = queryKey({ filters: [{ column: "done", op: "eq", value: false }] })
    expect(a).not.toBe(b)
    expect(a).not.toBe(EMPTY_QUERY_KEY)
  })

  it("ignores the ORDER of filters, because they are ANDed", () => {
    const a = queryKey({
      filters: [
        { column: "done", op: "eq", value: true },
        { column: "owner", op: "eq", value: 7 },
      ],
    })
    const b = queryKey({
      filters: [
        { column: "owner", op: "eq", value: 7 },
        { column: "done", op: "eq", value: true },
      ],
    })
    expect(a).toBe(b)
  })

  it("ignores the key order INSIDE a descriptor", () => {
    const a = queryKey({ filters: [{ column: "done", op: "eq", value: true }] })
    const b = queryKey({ filters: [{ value: true, op: "eq", column: "done" } as never] })
    expect(a).toBe(b)
  })

  it("is value-based, so a fresh object every render is the same key", () => {
    const build = () => queryKey({ filters: [{ column: "journey_id", op: "eq", value: "j1" }] })
    // The failure this prevents is not a wrong result: with an identity-based
    // key and the key as an effect dependency, it is an infinite fetch loop.
    expect(build()).toBe(build())
  })

  it("respects the ORDER of sorts, because they are positional", () => {
    const a = queryKey({
      sort: [
        { column: "date", ascending: true },
        { column: "id", ascending: true },
      ],
    })
    const b = queryKey({
      sort: [
        { column: "id", ascending: true },
        { column: "date", ascending: true },
      ],
    })
    expect(a).not.toBe(b)
  })

  it("separates ascending from descending, and nullsFirst from not", () => {
    expect(queryKey({ sort: [{ column: "d", ascending: true }] })).not.toBe(
      queryKey({ sort: [{ column: "d", ascending: false }] }),
    )
    expect(queryKey({ sort: [{ column: "d", nullsFirst: true }] })).not.toBe(
      queryKey({ sort: [{ column: "d" }] }),
    )
  })

  it("separates select, limit and offset — each changes which rows come back", () => {
    expect(queryKey({ select: "id" })).not.toBe(queryKey({ select: "id, title" }))
    expect(queryKey({ limit: 10 })).not.toBe(queryKey({ limit: 20 }))
    expect(queryKey({ offset: 0 })).not.toBe(queryKey({ offset: 10 }))
  })

  it("EXCLUDES count and cacheStrategy — same rows, different bookkeeping", () => {
    const base = { filters: [{ column: "done", op: "eq" as const, value: true }] }
    expect(queryKey({ ...base, count: "exact" })).toBe(queryKey(base))
    // `clearAndFetch` forces cacheStrategy: "replace", so a fork here would
    // split one logical query into two entries and two requests in practice.
    expect(queryKey({ ...base, cacheStrategy: "replace" })).toBe(
      queryKey({ ...base, cacheStrategy: "merge" }),
    )
  })

  it("does not let two different option sets concatenate into one key", () => {
    // Everything lands in one string, so the separator has to be a character
    // that cannot appear inside a part.
    expect(queryKey({ select: "id" })).not.toBe(queryKey({ sort: [{ column: "id" }] }))
    expect(queryKey({ limit: 1 })).not.toBe(queryKey({ offset: 1 }))
  })

  it("handles array, date, null and object filter values", () => {
    expect(queryKey({ filters: [{ column: "id", op: "in", value: [1, 2] }] })).not.toBe(
      queryKey({ filters: [{ column: "id", op: "in", value: [2, 1] }] }),
    )
    expect(queryKey({ filters: [{ column: "at", op: "is", value: null }] })).not.toBe(
      queryKey({ filters: [{ column: "at", op: "is", value: "null" }] }),
    )
    const d = new Date("2026-08-12T00:00:00.000Z")
    expect(queryKey({ filters: [{ column: "at", op: "gte", value: d }] })).toBe(
      queryKey({ filters: [{ column: "at", op: "gte", value: new Date(d) }] }),
    )
    // Object values (textSearch's config) are order-insensitive too.
    expect(
      queryKey({ filters: [{ column: "t", op: "textSearch", value: { query: "a", type: "plain" } }] }),
    ).toBe(
      queryKey({ filters: [{ column: "t", op: "textSearch", value: { type: "plain", query: "a" } }] }),
    )
  })
})

describe("isKeyable", () => {
  it("rejects a queryFn, which cannot be keyed by value", () => {
    expect(isKeyable()).toBe(true)
    expect(isKeyable({ filters: [] })).toBe(true)
    expect(isKeyable({ queryFn: (b) => b })).toBe(false)
  })
})
