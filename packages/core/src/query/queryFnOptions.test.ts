import { describe, it, expect, beforeEach, vi } from "vitest"
import { createTableStore } from "../createTableStore.js"
import { createMockSupabase } from "../__tests__/mockSupabase.js"

/**
 * The escape hatch and the options it used to throw away.
 *
 * `executeQuery` returned from the `queryFn` branch before the
 * filters/sort/pagination block, so a fetch carrying both a `queryFn` and
 * filters ran unfiltered — while `fetch` went on computing those filters,
 * merging the store's defaults into them, and keying the query on them. Only
 * `select` reached the builder.
 */

type Todo = { id: string; title: string; done: boolean; rank: number }

const ROWS: Todo[] = [
  { id: "t1", title: "one", done: false, rank: 3 },
  { id: "t2", title: "two", done: true, rank: 1 },
  { id: "t3", title: "three", done: false, rank: 2 },
]

describe("queryFn and the options it is handed", () => {
  let supabase: any

  beforeEach(() => {
    supabase = createMockSupabase({ todos: ROWS })
  })

  function store(options: Record<string, unknown> = {}) {
    return createTableStore<any, Todo, any, any>({
      supabase,
      table: "todos",
      ...options,
    } as any)
  }

  it("hands the queryFn a builder carrying the fetch's filters", async () => {
    const s = store()
    const rows = await s.getState().fetch({
      queryFn: (builder: any) => builder,
      filters: [{ column: "done", op: "eq", value: false }],
    })

    expect(rows.map((r) => r.id)).toEqual(["t1", "t3"])
  })

  it("hands it the limit too", async () => {
    const s = store()
    const rows = await s.getState().fetch({
      queryFn: (builder: any) => builder.order("rank", { ascending: true }),
      limit: 2,
    })

    expect(rows.map((r) => r.id)).toEqual(["t2", "t3"])
  })

  it("leaves the ordering to the queryFn, sort or no sort", async () => {
    // The one option deliberately NOT pre-applied. PostgREST's `order`
    // accumulates rather than overwrites, so handing the builder over with the
    // store's sort already on it would demote the callback's own `.order()` to a
    // tiebreaker behind it — and ordering through a referenced table is one of
    // the gaps the escape hatch exists for. `limit`/`range` overwrite and
    // filters compose as AND, so both of those pre-apply safely.
    const s = store({ defaultSort: [{ column: "done", ascending: true }] })
    const rows = await s.getState().fetch({
      queryFn: (builder: any) => builder.order("rank", { ascending: true }),
    })

    expect(rows.map((r) => r.id)).toEqual(["t2", "t3", "t1"])
  })

  it("merges the store's own defaults into the builder it hands over", async () => {
    // `fetch` resolves `defaultFilters` whether or not there is a `queryFn`, so
    // a store scoped to one user's rows stayed scoped only for fetches that did
    // not use the escape hatch.
    const s = store({ defaultFilters: [{ column: "done", op: "eq", value: true }] })
    const rows = await s.getState().fetch({ queryFn: (builder: any) => builder })

    expect(rows.map((r) => r.id)).toEqual(["t2"])
  })

  it("lets the queryFn narrow further from what it is given", async () => {
    const s = store()
    const rows = await s.getState().fetch({
      filters: [{ column: "done", op: "eq", value: false }],
      queryFn: (builder: any) => builder.eq("rank", 2),
    })

    expect(rows.map((r) => r.id)).toEqual(["t3"])
  })
})

describe("defaultQueryFn", () => {
  let supabase: any

  beforeEach(() => {
    supabase = createMockSupabase({ todos: ROWS })
  })

  it("applies to every fetch that does not pass its own", async () => {
    const seen = vi.fn((builder: any) => builder.eq("done", false))
    const s = createTableStore<any, Todo, any, any>({
      supabase,
      table: "todos",
      defaultQueryFn: seen,
    } as any)

    const rows = await s.getState().fetch()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(rows.map((r) => r.id)).toEqual(["t1", "t3"])
  })

  it("keeps per-query scoping, unlike a per-call queryFn", async () => {
    const s = createTableStore<any, Todo, any, any>({
      supabase,
      table: "todos",
      cacheStrategy: "merge",
      defaultQueryFn: (builder: any) => builder,
    } as any)

    await s.getState().fetch({ filters: [{ column: "done", op: "eq", value: false }] })
    await s.getState().fetch({ filters: [{ column: "done", op: "eq", value: true }] })

    // Two real entries, each with its own flags and count. A store-level
    // function is the same for every query on the store, so it says nothing
    // about which query this is — putting it through `resolveFetchOptions` would
    // make `isKeyable` false for all of them and the registry would stay empty.
    expect(s.getState().queries.size).toBe(2)
    for (const entry of s.getState().queries.values()) {
      expect(entry.isLoading).toBe(false)
      expect(entry.error).toBeNull()
    }
  })

  it("is overridden by a queryFn on the call", async () => {
    const fallback = vi.fn((builder: any) => builder)
    const s = createTableStore<any, Todo, any, any>({
      supabase,
      table: "todos",
      defaultQueryFn: fallback,
    } as any)

    const rows = await s.getState().fetch({ queryFn: (builder: any) => builder.eq("rank", 1) })
    expect(fallback).not.toHaveBeenCalled()
    expect(rows.map((r) => r.id)).toEqual(["t2"])
  })

  it("registers no query entry when the queryFn came from the call", async () => {
    const s = createTableStore<any, Todo, any, any>({ supabase, table: "todos" } as any)
    await s.getState().fetch({ queryFn: (builder: any) => builder })

    // An opaque function cannot go in a value-based key, so the query reads the
    // table's own loading and error flags instead of its own.
    expect(s.getState().queries.size).toBe(0)
    expect(s.getState().isLoading).toBe(false)
  })
})
