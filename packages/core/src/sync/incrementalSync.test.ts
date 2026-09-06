import { describe, expect,it } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { createTableStore } from "../createTableStore.js"
import { incrementalSync } from "./incrementalSync.js"

type Todo = { id: number; title: string; updated_at: string }

describe("incrementalSync", () => {
  it("fetches all rows on first sync (no lastFetchedAt)", async () => {
    const supabase = createMockSupabase({
      todos: [
        { id: 1, title: "A", updated_at: "2024-01-01" },
        { id: 2, title: "B", updated_at: "2024-01-02" },
      ],
    })

    const store = createTableStore<any, Todo, any, any>({
      supabase,
      table: "todos",
    })

    const result = await incrementalSync(
      supabase,
      "todos",
      "id",
      store,
    )

    expect(result.fetchedCount).toBe(2)
    expect(result.mergedCount).toBe(2)
    expect(store.getState().records.size).toBe(2)
    expect(store.getState().lastFetchedAt).toBeTypeOf("number")
  })

  it("does not overwrite pending mutations", async () => {
    const supabase = createMockSupabase({
      todos: [
        { id: 1, title: "Remote version", updated_at: "2024-01-02" },
      ],
    })

    const store = createTableStore<any, Todo, any, any>({
      supabase,
      table: "todos",
    })

    // Set a pending record
    store.getState().setRecord(1, {
      _anchor_pending: "update",
      id: 1,
      title: "Local pending",
      updated_at: "2024-01-01",
    } as any)

    await incrementalSync(supabase, "todos", "id", store)

    // Pending record should NOT be overwritten
    expect(store.getState().records.get(1)?.title).toBe("Local pending")
  })

  it("updates lastFetchedAt even when no rows fetched", async () => {
    const supabase = createMockSupabase({ todos: [] })
    const store = createTableStore<any, Todo, any, any>({
      supabase,
      table: "todos",
    })

    await incrementalSync(supabase, "todos", "id", store)

    expect(store.getState().lastFetchedAt).toBeTypeOf("number")
  })
})

describe("incrementalSync error routing", () => {
  it("throws an error carrying the Postgres code", async () => {
    const supabase = createMockSupabase({ todos: [] })
    const store = createTableStore<any, Todo, any, any>({ supabase, table: "todos" })

    supabase._setError("todos", "select", { code: "42501", message: "permission denied" })

    await expect(
      incrementalSync(supabase, "todos", "id", store, { timestampColumn: "updated_at" }),
    ).rejects.toMatchObject({ code: "42501" })
  })

  it("resolves with counts when nothing failed", async () => {
    const supabase = createMockSupabase({
      todos: [{ id: 1, title: "A", updated_at: "2026-01-01" }],
    })
    const store = createTableStore<any, Todo, any, any>({ supabase, table: "todos" })

    const result = await incrementalSync(supabase, "todos", "id", store, {
      timestampColumn: "updated_at",
    })

    expect(result.fetchedCount).toBe(1)
  })
})
