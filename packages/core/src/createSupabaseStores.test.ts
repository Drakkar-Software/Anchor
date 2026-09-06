import { describe, expect,it } from "vitest"

import { createMockSupabase } from "./__tests__/mockSupabase.js"
import { createSupabaseStores } from "./createSupabaseStores.js"
import { MemoryAdapter } from "./persistence/persistenceAdapter.js"

describe("createSupabaseStores", () => {
  it("creates stores for all specified tables", () => {
    const supabase = createMockSupabase({
      profiles: [{ id: "u1", username: "alice" }],
      todos: [{ id: 1, title: "A" }],
    })

    const stores = createSupabaseStores<any>({
      supabase,
      tables: ["todos", "profiles"],
    })

    expect(stores.todos).toBeDefined()
    expect(stores.profiles).toBeDefined()
    expect(stores.auth).toBeDefined()
    expect(stores._supabase).toBe(supabase)
    expect(typeof stores._destroy).toBe("function")
  })

  it("creates auth store", () => {
    const supabase = createMockSupabase({})
    const stores = createSupabaseStores<any>({
      supabase,
      tables: ["todos"],
    })

    const authState = stores.auth.getState()

    expect(authState.session).toBeNull()
    expect(typeof authState.signIn).toBe("function")
  })

  it("stores have fetch action", async () => {
    const supabase = createMockSupabase({
      todos: [
        { id: 1, title: "A" },
        { id: 2, title: "B" },
      ],
    })

    const stores = createSupabaseStores<any>({
      fetchRemoteOnBoot: false,
      supabase,
      tables: ["todos"],
    })

    const result = await stores.todos.getState().fetch()

    expect(result).toHaveLength(2)
  })

  it("_destroy cleans up without error", () => {
    const supabase = createMockSupabase({})
    const stores = createSupabaseStores<any>({
      supabase,
      tables: ["todos"],
    })

    expect(() => stores._destroy()).not.toThrow()
  })

  it("supports persistence adapter", async () => {
    const adapter = new MemoryAdapter()
    const supabase = createMockSupabase({
      todos: [{ id: 1, title: "A" }],
    })

    const stores = createSupabaseStores<any>({
      fetchRemoteOnBoot: false,
      persistence: { adapter },
      supabase,
      tables: ["todos"],
    })

    await stores.todos.getState().fetch()

    // Wait for debounced persist (100ms debounce + async write)
    await new Promise((r) => setTimeout(r, 200))

    const persisted = await adapter.getItem<any[]>("anchor:public:todos")

    expect(persisted).toHaveLength(1)
  })

  it("prepends persistence.keyPrefix to every table's default key", async () => {
    const adapter = new MemoryAdapter()
    const supabase = createMockSupabase({
      todos: [{ id: 1, title: "A" }],
    })

    const stores = createSupabaseStores<any>({
      fetchRemoteOnBoot: false,
      persistence: { adapter, keyPrefix: "tenant-42:" },
      supabase,
      tables: ["todos"],
    })

    await stores.todos.getState().fetch()
    await new Promise((r) => setTimeout(r, 200))

    // The unprefixed default key must be untouched — this is a namespace, not
    // a rename of what createTableStore already computes.
    expect(await adapter.getItem<any[]>("anchor:public:todos")).toBeNull()

    const persisted = await adapter.getItem<any[]>("tenant-42:anchor:public:todos")

    expect(persisted).toHaveLength(1)
  })

  it("prepends persistence.keyPrefix for a view store too", async () => {
    const adapter = new MemoryAdapter()
    const supabase = createMockSupabase({
      todo_summary: [{ id: 1, total: 3 }],
    })

    const stores = createSupabaseStores<any>({
      fetchRemoteOnBoot: false,
      persistence: { adapter, keyPrefix: "tenant-42:" },
      supabase,
      tables: [],
      views: ["todo_summary"],
    })

    await stores.todo_summary.getState().fetch()
    await new Promise((r) => setTimeout(r, 200))

    const persisted = await adapter.getItem<any[]>("tenant-42:anchor:public:todo_summary")

    expect(persisted).toHaveLength(1)
  })

  it("respects fetchRemoteOnBoot: false", () => {
    const supabase = createMockSupabase({
      todos: [{ id: 1, title: "A" }],
    })

    const stores = createSupabaseStores<any>({
      fetchRemoteOnBoot: false,
      supabase,
      tables: ["todos"],
    })

    // Store should be empty since we didn't fetch on boot
    expect(stores.todos.getState().records.size).toBe(0)
  })
})
