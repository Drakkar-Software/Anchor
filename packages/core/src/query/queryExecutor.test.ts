import { describe, it, expect } from "vitest"
import { applyFilters, applySort, executeQuery } from "./queryExecutor.js"

describe("applyFilters", () => {
  it("applies eq filter to a mock builder", () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const builder = new Proxy(
      {},
      {
        get(_target, prop) {
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            return builder
          }
        },
      },
    )

    applyFilters(builder, [
      { column: "name", op: "eq", value: "alice" },
      { column: "age", op: "gt", value: 18 },
      { column: "status", op: "in", value: ["active", "pending"] },
    ])

    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({ method: "eq", args: ["name", "alice"] })
    expect(calls[1]).toEqual({ method: "gt", args: ["age", 18] })
    expect(calls[2]).toEqual({ method: "in", args: ["status", ["active", "pending"]] })
  })

  it("applies textSearch with options", () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const builder = new Proxy(
      {},
      {
        get(_target, prop) {
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            return builder
          }
        },
      },
    )

    applyFilters(builder, [
      {
        column: "body",
        op: "textSearch",
        value: { query: "hello world", type: "websearch", config: "english" },
      },
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("textSearch")
    expect(calls[0]!.args[0]).toBe("body")
    expect(calls[0]!.args[1]).toBe("hello world")
  })

  it("handles all filter operators without error", () => {
    const builder = new Proxy(
      {},
      {
        get() {
          return (..._args: unknown[]) => builder
        },
      },
    )

    const operators = [
      "eq", "neq", "gt", "gte", "lt", "lte",
      "like", "ilike", "is", "in",
      "contains", "containedBy", "overlaps",
      "not", "or", "filter",
    ] as const

    for (const op of operators) {
      expect(() =>
        applyFilters(builder, [{ column: "col", op, value: "val" }]),
      ).not.toThrow()
    }
  })
})

describe("applySort", () => {
  it("applies sort rules to builder", () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const builder = new Proxy(
      {},
      {
        get(_target, prop) {
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            return builder
          }
        },
      },
    )

    applySort(builder, [
      { column: "created_at", ascending: false },
      { column: "name", ascending: true, nullsFirst: true },
    ])

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      method: "order",
      args: ["created_at", { ascending: false, nullsFirst: undefined }],
    })
    expect(calls[1]).toEqual({
      method: "order",
      args: ["name", { ascending: true, nullsFirst: true }],
    })
  })

  it("defaults to ascending and leaves nullsFirst to PostgREST", () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const builder = new Proxy(
      {},
      {
        get(_target, prop) {
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            return builder
          }
        },
      },
    )

    applySort(builder, [{ column: "id" }])

    // `nullsFirst: false` used to be forced here. That is not PostgREST's
    // default and not Postgres': NULLS LAST is the default for ASC but NULLS
    // FIRST is the default for DESC, so forcing `false` moved nulls to the
    // bottom of every descending sort — silently different from the same query
    // run against the database, and enough to change which rows a `limit`
    // keeps. postgrest-js omits the token when the option is `undefined`.
    expect(calls[0]).toEqual({
      method: "order",
      args: ["id", { ascending: true, nullsFirst: undefined }],
    })
  })

  it("still forwards an explicit nullsFirst in both positions", () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const builder: any = new Proxy(
      {},
      {
        get(_target, prop) {
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            return builder
          }
        },
      },
    )

    applySort(builder, [
      { column: "a", ascending: false, nullsFirst: true },
      { column: "b", ascending: false, nullsFirst: false },
    ])

    expect(calls[0]!.args[1]).toEqual({ ascending: false, nullsFirst: true })
    expect(calls[1]!.args[1]).toEqual({ ascending: false, nullsFirst: false })
  })
})

/**
 * Pagination, asserted on the calls rather than on the rows. `offset` is the one
 * arm with arithmetic in it and the mock cannot tell an off-by-one in the range
 * end from a correct one, so read what reached the builder.
 */
describe("executeQuery pagination", () => {
  function recordingClient() {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const builder: any = new Proxy(
      { then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: null }) },
      {
        get(target, prop) {
          if (prop === "then") return (target as any).then
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            return builder
          }
        },
      },
    )
    return { calls, supabase: { from: () => builder } as any }
  }

  it("turns offset+limit into a single inclusive range", async () => {
    const { calls, supabase } = recordingClient()
    await executeQuery(supabase, "todos", "public", { offset: 20, limit: 10 })

    // The end is inclusive, so a page of 10 starting at 20 is 20..29 — not 30,
    // which would return 11 rows, and not 29 rows over a wrong base.
    expect(calls.filter((c) => c.method === "range")).toEqual([
      { method: "range", args: [20, 29] },
    ])
    // `range` covers both, so `limit` must NOT also be called: PostgREST would
    // take the narrower of the two and the second page would come back empty.
    expect(calls.some((c) => c.method === "limit")).toBe(false)
  })

  it("falls back to a 1000-row page when offset comes with no limit", async () => {
    const { calls, supabase } = recordingClient()
    await executeQuery(supabase, "todos", "public", { offset: 5 })

    expect(calls.filter((c) => c.method === "range")).toEqual([
      { method: "range", args: [5, 1004] },
    ])
  })

  it("uses limit alone when there is no offset", async () => {
    const { calls, supabase } = recordingClient()
    await executeQuery(supabase, "todos", "public", { limit: 3 })

    expect(calls.filter((c) => c.method === "limit")).toEqual([
      { method: "limit", args: [3] },
    ])
    expect(calls.some((c) => c.method === "range")).toBe(false)
  })

  it("paginates the builder a queryFn is handed, before the callback sees it", async () => {
    const { calls, supabase } = recordingClient()
    await executeQuery(supabase, "todos", "public", {
      offset: 20,
      limit: 10,
      queryFn: (builder: any) => builder,
    })

    expect(calls.filter((c) => c.method === "range")).toEqual([
      { method: "range", args: [20, 29] },
    ])
  })
})
