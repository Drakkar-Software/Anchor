import { describe, expect,it } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { createTableStore } from "../createTableStore.js"
import { isExpired,isStale } from "./cacheTtl.js"

describe("isStale", () => {
  it("returns true when never fetched", () => {
    const supabase = createMockSupabase({})
    const store = createTableStore<any, any, any, any>({
      supabase,
      table: "todos",
    })

    expect(isStale(store)).toBe(true)
  })

  it("returns false when recently fetched", async () => {
    const supabase = createMockSupabase({ todos: [{ id: 1, title: "A" }] })
    const store = createTableStore<any, any, any, any>({
      supabase,
      table: "todos",
    })

    await store.getState().fetch()
    expect(isStale(store, 60_000)).toBe(false)
  })

  it("returns true when staleTTL exceeded", async () => {
    const supabase = createMockSupabase({ todos: [{ id: 1, title: "A" }] })
    const store = createTableStore<any, any, any, any>({
      supabase,
      table: "todos",
    })

    await store.getState().fetch()

    // Manually set lastFetchedAt to past
    store.setState({ lastFetchedAt: Date.now() - 120_000 } as any)
    expect(isStale(store, 60_000)).toBe(true)
  })
})

describe("isExpired", () => {
  it("returns true when never fetched", () => {
    const supabase = createMockSupabase({})
    const store = createTableStore<any, any, any, any>({
      supabase,
      table: "todos",
    })

    expect(isExpired(store)).toBe(true)
  })

  it("returns false when within cacheTTL", async () => {
    const supabase = createMockSupabase({ todos: [{ id: 1, title: "A" }] })
    const store = createTableStore<any, any, any, any>({
      supabase,
      table: "todos",
    })

    await store.getState().fetch()
    expect(isExpired(store, 30 * 60 * 1000)).toBe(false)
  })
})
