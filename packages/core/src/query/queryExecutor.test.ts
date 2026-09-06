import { describe, expect,it } from "vitest"

import { applyFilters, applySort, executeQuery } from "./queryExecutor.js"

describe("applyFilters", () => {
  it("applies eq filter to a mock builder", () => {
    const calls: { args: unknown[]; method: string; }[] = []
    const builder = new Proxy(
      {},
      {
        get(_target, prop) {
          return (...args: unknown[]) => {
            calls.push({ args, method: String(prop) })

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
    expect(calls[0]).toEqual({ args: ["name", "alice"], method: "eq" })
    expect(calls[1]).toEqual({ args: ["age", 18], method: "gt" })
    expect(calls[2]).toEqual({ args: ["status", ["active", "pending"]], method: "in" })
  })

  it("applies textSearch with options", () => {
    const calls: { args: unknown[]; method: string; }[] = []
    const builder = new Proxy(
      {},
      {
        get(_target, prop) {
          return (...args: unknown[]) => {
            calls.push({ args, method: String(prop) })

            return builder
          }
        },
      },
    )

    applyFilters(builder, [
      {
        column: "body",
        op: "textSearch",
        value: { config: "english", query: "hello world", type: "websearch" },
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
    const calls: { args: unknown[]; method: string; }[] = []
    const builder = new Proxy(
      {},
      {
        get(_target, prop) {
          return (...args: unknown[]) => {
            calls.push({ args, method: String(prop) })

            return builder
          }
        },
      },
    )

    applySort(builder, [
      { ascending: false, column: "created_at" },
      { ascending: true, column: "name", nullsFirst: true },
    ])

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      args: ["created_at", { ascending: false, nullsFirst: undefined }],
      method: "order",
    })
    expect(calls[1]).toEqual({
      args: ["name", { ascending: true, nullsFirst: true }],
      method: "order",
    })
  })

  it("defaults to ascending and leaves nullsFirst to PostgREST", () => {
    const calls: { args: unknown[]; method: string; }[] = []
    const builder = new Proxy(
      {},
      {
        get(_target, prop) {
          return (...args: unknown[]) => {
            calls.push({ args, method: String(prop) })

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
      args: ["id", { ascending: true, nullsFirst: undefined }],
      method: "order",
    })
  })

  it("still forwards an explicit nullsFirst in both positions", () => {
    const calls: { args: unknown[]; method: string; }[] = []
    const builder: any = new Proxy(
      {},
      {
        get(_target, prop) {
          return (...args: unknown[]) => {
            calls.push({ args, method: String(prop) })

            return builder
          }
        },
      },
    )

    applySort(builder, [
      { ascending: false, column: "a", nullsFirst: true },
      { ascending: false, column: "b", nullsFirst: false },
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
    const calls: { args: unknown[]; method: string; }[] = []
    const builder: any = new Proxy(
      { then: (resolve: (v: unknown) => void) => resolve({ count: null, data: [], error: null }) },
      {
        get(target, prop) {
          if (prop === "then") {return (target as any).then}

          return (...args: unknown[]) => {
            calls.push({ args, method: String(prop) })

            return builder
          }
        },
      },
    )

    return { calls, supabase: { from: () => builder } as any }
  }

  it("turns offset+limit into a single inclusive range", async () => {
    const { calls, supabase } = recordingClient()

    await executeQuery(supabase, "todos", "public", { limit: 10, offset: 20 })

    // The end is inclusive, so a page of 10 starting at 20 is 20..29 — not 30,
    // which would return 11 rows, and not 29 rows over a wrong base.
    expect(calls.filter((c) => c.method === "range")).toEqual([
      { args: [20, 29], method: "range" },
    ])

    // `range` covers both, so `limit` must NOT also be called: PostgREST would
    // take the narrower of the two and the second page would come back empty.
    expect(calls.some((c) => c.method === "limit")).toBe(false)
  })

  it("falls back to a 1000-row page when offset comes with no limit", async () => {
    const { calls, supabase } = recordingClient()

    await executeQuery(supabase, "todos", "public", { offset: 5 })

    expect(calls.filter((c) => c.method === "range")).toEqual([
      { args: [5, 1004], method: "range" },
    ])
  })

  it("uses limit alone when there is no offset", async () => {
    const { calls, supabase } = recordingClient()

    await executeQuery(supabase, "todos", "public", { limit: 3 })

    expect(calls.filter((c) => c.method === "limit")).toEqual([
      { args: [3], method: "limit" },
    ])
    expect(calls.some((c) => c.method === "range")).toBe(false)
  })

  it("paginates the builder a queryFn is handed, before the callback sees it", async () => {
    const { calls, supabase } = recordingClient()

    await executeQuery(supabase, "todos", "public", {
      limit: 10,
      offset: 20,
      queryFn: (builder: any) => builder,
    })

    expect(calls.filter((c) => c.method === "range")).toEqual([
      { args: [20, 29], method: "range" },
    ])
  })
})
