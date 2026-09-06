import { describe, expect, it, vi } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { createTableStore } from "../createTableStore.js"
import { createMutationExecutor,executeRemoteMutation } from "./mutationPipeline.js"

describe("executeRemoteMutation", () => {
  it("executes INSERT and returns server data with serverId", async () => {
    const supabase = createMockSupabase({ todos: [] })
    const result = await executeRemoteMutation(
      supabase,
      "todos",
      "id",
      {
        createdAt: Date.now(),
        id: "m1",
        operation: "INSERT",
        payload: { title: "New todo" },
        primaryKey: { id: "_temp:abc" },
        retryCount: 0,
        rollbackSnapshot: null,
        status: "in_flight",
        table: "todos",
      },
      new Map(),
    )

    expect(result.data).toBeDefined()
    expect(result.serverId).toBeDefined()
  })

  it("strips temp ID from INSERT payload", async () => {
    const supabase = createMockSupabase({ todos: [] })
    const insertSpy = vi.fn().mockReturnValue({
      select: () => ({
        single: () => ({
          then: (r: any) => r({ data: { id: 42, title: "A" }, error: null }),
        }),
      }),
    })

    // Override from to spy on insert
    supabase.from = () => ({ insert: insertSpy }) as any

    await executeRemoteMutation(
      supabase,
      "todos",
      "id",
      {
        createdAt: Date.now(),
        id: "m1",
        operation: "INSERT",
        payload: { id: "_temp:xyz", title: "A" },
        primaryKey: { id: "_temp:xyz" },
        retryCount: 0,
        rollbackSnapshot: null,
        status: "in_flight",
        table: "todos",
      },
      new Map(),
    )

    // The payload sent to insert should NOT have the temp id
    const insertedPayload = insertSpy.mock.calls[0][0]

    expect(insertedPayload.id).toBeUndefined()
    expect(insertedPayload.title).toBe("A")
  })

  it("executes UPDATE with correct primaryKey", async () => {
    const supabase = createMockSupabase({
      todos: [{ completed: false, id: 1, title: "Old" }],
    })

    const result = await executeRemoteMutation(
      supabase,
      "todos",
      "id",
      {
        createdAt: Date.now(),
        id: "m1",
        operation: "UPDATE",
        payload: { title: "Updated" },
        primaryKey: { id: 1 },
        retryCount: 0,
        rollbackSnapshot: { id: 1, title: "Old" },
        status: "in_flight",
        table: "todos",
      },
      new Map(),
    )

    expect(result.data).toBeDefined()
    expect((result.data as any).title).toBe("Updated")
  })

  it("executes DELETE", async () => {
    const supabase = createMockSupabase({
      todos: [{ id: 1, title: "A" }],
    })

    const result = await executeRemoteMutation(
      supabase,
      "todos",
      "id",
      {
        createdAt: Date.now(),
        id: "m1",
        operation: "DELETE",
        payload: null,
        primaryKey: { id: 1 },
        retryCount: 0,
        rollbackSnapshot: { id: 1, title: "A" },
        status: "in_flight",
        table: "todos",
      },
      new Map(),
    )

    expect(result.data).toBeNull()
  })

  it("resolves temp IDs from tempIdMap", async () => {
    const supabase = createMockSupabase({
      todos: [{ id: 42, title: "Parent" }],
    })

    const tempIdMap = new Map<string, unknown>()

    tempIdMap.set("_temp:parent", 42)

    const result = await executeRemoteMutation(
      supabase,
      "todos",
      "id",
      {
        createdAt: Date.now(),
        id: "m1",
        operation: "UPDATE",
        payload: { parentId: "_temp:parent", title: "Child" },
        primaryKey: { id: 42 },
        retryCount: 0,
        rollbackSnapshot: null,
        status: "in_flight",
        table: "todos",
      },
      tempIdMap,
    )

    expect(result.data).toBeDefined()
  })

  it("throws on error", async () => {
    const supabase = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: () => ({
              then: (r: any) => r({ data: null, error: { message: "Insert failed" } }),
            }),
          }),
        }),
      }),
    } as any

    await expect(
      executeRemoteMutation(
        supabase, "todos", "id",
        { createdAt: 0, id: "m1", operation: "INSERT", payload: { title: "A" }, primaryKey: { id: 1 }, retryCount: 0, rollbackSnapshot: null, status: "in_flight", table: "todos" },
        new Map(),
      ),
    ).rejects.toThrow("Insert failed")
  })
})

describe("createMutationExecutor", () => {
  it("creates an executor that updates store on success", async () => {
    const supabase = createMockSupabase({ todos: [] })
    const store = createTableStore<any, any, any, any>({ supabase, table: "todos" })

    const executor = createMutationExecutor(supabase, "todos", "id", store)

    await executor(
      {
        createdAt: Date.now(),
        id: "m1",
        operation: "INSERT",
        payload: { title: "Test" },
        primaryKey: { id: "_temp:test" },
        retryCount: 0,
        rollbackSnapshot: null,
        status: "in_flight",
        table: "todos",
      },
      new Map(),
    )

    // Store should have the new record
    expect(store.getState().records.size).toBeGreaterThan(0)
  })
})
