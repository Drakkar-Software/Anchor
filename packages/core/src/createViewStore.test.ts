import { describe, expect,it } from "vitest"

import { createMockSupabase } from "./__tests__/mockSupabase.js"
import { createTableStore } from "./createTableStore.js"
import { createViewStore } from "./createViewStore.js"

describe("createViewStore", () => {
  it("creates a store that can fetch data", async () => {
    const supabase = createMockSupabase({
      popular_books: [
        { author: "Author A", id: 1, title: "Book A" },
        { author: "Author B", id: 2, title: "Book B" },
      ],
    })

    const store = createViewStore<any, { author: string; id: number; title: string; }>({
      supabase,
      view: "popular_books",
    })

    const result = await store.getState().fetch()

    expect(result).toHaveLength(2)
    expect(store.getState().records.size).toBe(2)
  })
})

describe("isView flag on createTableStore", () => {
  it("throws on insert", async () => {
    const supabase = createMockSupabase({})
    const store = createTableStore<any, any, any, any>({
      isView: true,
      supabase,
      table: "my_view",
    })

    await expect(store.getState().insert({ title: "test" })).rejects.toThrow(
      'Cannot mutate view "my_view"',
    )
  })

  it("throws on update", async () => {
    const supabase = createMockSupabase({})
    const store = createTableStore<any, any, any, any>({
      isView: true,
      supabase,
      table: "my_view",
    })

    await expect(store.getState().update(1, { title: "test" })).rejects.toThrow(
      "Cannot mutate view",
    )
  })

  it("throws on upsert", async () => {
    const supabase = createMockSupabase({})
    const store = createTableStore<any, any, any, any>({
      isView: true,
      supabase,
      table: "my_view",
    })

    await expect(store.getState().upsert({ title: "test" })).rejects.toThrow(
      "Cannot mutate view",
    )
  })

  it("throws on remove", async () => {
    const supabase = createMockSupabase({})
    const store = createTableStore<any, any, any, any>({
      isView: true,
      supabase,
      table: "my_view",
    })

    await expect(store.getState().remove(1)).rejects.toThrow(
      "Cannot mutate view",
    )
  })

  it("throws on insertMany", async () => {
    const supabase = createMockSupabase({})
    const store = createTableStore<any, any, any, any>({
      isView: true,
      supabase,
      table: "my_view",
    })

    await expect(store.getState().insertMany([{ title: "a" }])).rejects.toThrow(
      "Cannot mutate view",
    )
  })

  it("allows fetch", async () => {
    const supabase = createMockSupabase({
      my_view: [{ id: 1, name: "test" }],
    })
    const store = createTableStore<any, any, any, any>({
      isView: true,
      supabase,
      table: "my_view",
    })

    const result = await store.getState().fetch()

    expect(result).toHaveLength(1)
  })
})
