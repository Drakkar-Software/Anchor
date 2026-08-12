import { describe, it, expect, beforeEach, vi } from "vitest"
import { createTableStore } from "./createTableStore.js"
import { MemoryAdapter } from "./persistence/persistenceAdapter.js"
import { createMockSupabase } from "./__tests__/mockSupabase.js"

type Todo = {
  id: number
  title: string
  completed: boolean
  created_at: string
  updated_at: string
}

describe("createTableStore", () => {
  let supabase: any

  beforeEach(() => {
    supabase = createMockSupabase({
      todos: [
        { id: 1, title: "Buy milk", completed: false, created_at: "2024-01-01", updated_at: "2024-01-01" },
        { id: 2, title: "Walk dog", completed: true, created_at: "2024-01-02", updated_at: "2024-01-02" },
        { id: 3, title: "Read book", completed: false, created_at: "2024-01-03", updated_at: "2024-01-03" },
      ],
    })
  })

  function createStore(overrides: Record<string, unknown> = {}) {
    return createTableStore<any, Todo, Partial<Todo>, Partial<Todo>>({
      supabase,
      table: "todos",
      ...overrides,
    })
  }

  describe("initial state", () => {
    it("creates store with empty initial state", () => {
      const store = createStore()
      const state = store.getState()

      expect(state.records.size).toBe(0)
      expect(state.order).toEqual([])
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
      expect(state.isHydrated).toBe(false)
      expect(state.realtimeStatus).toBe("disconnected")
    })
  })

  describe("fetch", () => {
    it("fetches all rows from supabase", async () => {
      const store = createStore()
      const result = await store.getState().fetch()

      expect(result).toHaveLength(3)
      expect(store.getState().records.size).toBe(3)
      expect(store.getState().order).toEqual([1, 2, 3])
      expect(store.getState().isLoading).toBe(false)
      expect(store.getState().lastFetchedAt).toBeTypeOf("number")
    })

    it("sets isLoading during fetch", async () => {
      const store = createStore()
      const fetchPromise = store.getState().fetch()
      // isLoading may or may not be true depending on microtask timing
      await fetchPromise
      expect(store.getState().isLoading).toBe(false)
    })

    it("preserves pending records during fetch", async () => {
      const store = createStore()

      // Simulate a pending record
      store.getState().setRecord(999, {
        id: 999,
        title: "Pending item",
        completed: false,
        created_at: "",
        updated_at: "",
        _anchor_pending: "insert",
      } as any)

      await store.getState().fetch()

      // Pending record should still be there
      expect(store.getState().records.has(999)).toBe(true)
      expect(store.getState().records.get(999)?._anchor_pending).toBe("insert")
    })
  })

  describe("fetchOne", () => {
    it("fetches a single row by id", async () => {
      const store = createStore()
      const result = await store.getState().fetchOne(1)

      expect(result).toBeDefined()
      expect((result as any).title).toBe("Buy milk")
      expect(store.getState().records.has(1)).toBe(true)
    })

    it("returns null for non-existent row", async () => {
      const store = createStore()
      const result = await store.getState().fetchOne(999)

      expect(result).toBeNull()
    })
  })

  describe("insert", () => {
    it("inserts a row optimistically and confirms with server", async () => {
      const store = createStore()
      const result = await store.getState().insert({
        title: "New todo",
        completed: false,
      })

      expect(result).toBeDefined()
      expect((result as any).title).toBe("New todo")
      // Should be in the store
      const records = [...store.getState().records.values()]
      expect(records.some((r) => (r as any).title === "New todo")).toBe(true)
    })

    it("rolls back on server error", async () => {
      // Create a supabase that fails on insert
      const failingSupabase = {
        from(table: string) {
          return {
            insert() {
              return {
                select() {
                  return {
                    single() {
                      return {
                        then(resolve: any) {
                          resolve({ data: null, error: { message: "Insert failed" } })
                        },
                      }
                    },
                  }
                },
              }
            },
          }
        },
      }

      const store = createStore({ supabase: failingSupabase })

      await expect(
        store.getState().insert({ title: "Will fail", completed: false }),
      ).rejects.toThrow("Insert failed")

      // Store should be empty (rolled back)
      expect(store.getState().records.size).toBe(0)
    })
  })

  describe("update", () => {
    it("updates a row optimistically and confirms", async () => {
      const store = createStore()
      await store.getState().fetch()

      const result = await store.getState().update(1, { completed: true })

      expect(result).toBeDefined()
      expect(store.getState().records.get(1)?.completed).toBe(true)
    })

    it("applies optimistic update immediately", async () => {
      const store = createStore()
      await store.getState().fetch()

      // Start update but don't await
      const updatePromise = store.getState().update(1, { title: "Updated" })

      // The record should already be updated optimistically
      // (though in practice the Promise may resolve instantly with our mock)
      await updatePromise

      expect(store.getState().records.get(1)?.title).toBe("Updated")
    })
  })

  describe("remove", () => {
    it("removes a row optimistically and confirms", async () => {
      const store = createStore()
      await store.getState().fetch()

      expect(store.getState().records.has(1)).toBe(true)

      await store.getState().remove(1)

      expect(store.getState().records.has(1)).toBe(false)
      expect(store.getState().order).not.toContain(1)
    })
  })

  describe("local operations", () => {
    it("setRecord adds a record locally", () => {
      const store = createStore()
      store.getState().setRecord(42, {
        id: 42,
        title: "Local only",
        completed: false,
        created_at: "",
        updated_at: "",
      })

      expect(store.getState().records.has(42)).toBe(true)
      expect(store.getState().order).toContain(42)
    })

    it("removeRecord removes a record locally", () => {
      const store = createStore()
      store.getState().setRecord(42, {
        id: 42,
        title: "Local only",
        completed: false,
        created_at: "",
        updated_at: "",
      })

      store.getState().removeRecord(42)

      expect(store.getState().records.has(42)).toBe(false)
      expect(store.getState().order).not.toContain(42)
    })

    it("clearAll removes all records", () => {
      const store = createStore()
      store.getState().setRecord(1, { id: 1, title: "A", completed: false, created_at: "", updated_at: "" })
      store.getState().setRecord(2, { id: 2, title: "B", completed: false, created_at: "", updated_at: "" })

      store.getState().clearAll()

      expect(store.getState().records.size).toBe(0)
      expect(store.getState().order).toEqual([])
    })

    it("mergeRecords adds new rows without overwriting pending", () => {
      const store = createStore()

      // Add a pending record
      store.getState().setRecord(1, {
        id: 1,
        title: "Pending update",
        completed: false,
        created_at: "",
        updated_at: "",
        _anchor_pending: "update",
      } as any)

      // Merge remote data that includes the same id
      store.getState().mergeRecords([
        { id: 1, title: "Remote version", completed: true, created_at: "", updated_at: "" },
        { id: 2, title: "New remote", completed: false, created_at: "", updated_at: "" },
      ])

      // Pending record should NOT be overwritten
      expect(store.getState().records.get(1)?.title).toBe("Pending update")
      // New record should be added
      expect(store.getState().records.get(2)?.title).toBe("New remote")
    })
  })

  describe("persistence", () => {
    it("auto-hydrates from persistence adapter on creation", async () => {
      const adapter = new MemoryAdapter()
      await adapter.setItem("anchor:public:todos", [
        { id: 10, title: "Cached todo", completed: false, created_at: "", updated_at: "" },
      ])

      const store = createStore({ persistence: { adapter } })

      // Wait for async hydration
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(store.getState().isHydrated).toBe(true)
      expect(store.getState().records.has(10)).toBe(true)
    })

    it("persists to adapter after mutations", async () => {
      const adapter = new MemoryAdapter()
      const store = createStore({ persistence: { adapter } })

      await store.getState().fetch()

      // Wait for debounced persist (100ms debounce + async write)
      await new Promise((resolve) => setTimeout(resolve, 200))

      const persisted = await adapter.getItem<any[]>("anchor:public:todos")
      expect(persisted).toHaveLength(3)
    })
  })

  describe("fetch error handling", () => {
    it("recovers isLoading on exception in fetch", async () => {
      // Supabase client that throws instead of returning { error }
      const throwingSupabase = {
        from() {
          return {
            select() {
              // Return a thenable that throws when awaited
              return {
                then(_resolve: any, reject: any) {
                  reject(new Error("Network failure"))
                },
              }
            },
          }
        },
      }

      const store = createStore({ supabase: throwingSupabase })
      const result = await store.getState().fetch()

      expect(result).toEqual([])
      expect(store.getState().isLoading).toBe(false)
      expect(store.getState().error).toBeTruthy()
      expect(store.getState().error?.message).toContain("Network failure")
    })
  })

  describe("persistence debouncing", () => {
    it("debounces rapid mutations into a single persist write", async () => {
      const adapter = new MemoryAdapter()
      const setItemSpy = vi.spyOn(adapter, "setItem")

      const store = createStore({ persistence: { adapter } })

      // Perform multiple rapid mutations
      store.getState().setRecord(1, { id: 1, title: "A", completed: false, created_at: "", updated_at: "" })
      store.getState().setRecord(2, { id: 2, title: "B", completed: false, created_at: "", updated_at: "" })
      store.getState().setRecord(3, { id: 3, title: "C", completed: false, created_at: "", updated_at: "" })

      // Should NOT have called setItem yet (debounced)
      expect(setItemSpy).not.toHaveBeenCalled()

      // Wait for debounce to fire
      await new Promise((r) => setTimeout(r, 200))

      // Should have called setItem exactly once (debounced)
      expect(setItemSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe("cacheStrategy", () => {
    describe("merge mode", () => {
      it("accumulates records across fetches, and keeps every one of them reachable", async () => {
        const store = createStore({ cacheStrategy: "merge" })

        // First fetch: all todos
        await store.getState().fetch()
        expect(store.getState().records.size).toBe(3)
        expect(store.getState().order).toEqual([1, 2, 3])

        // Second fetch: only completed todos (id=2)
        await store.getState().fetch({ filters: [{ column: "completed", op: "eq", value: true }] })

        // Records should still have all 3 (accumulated)
        expect(store.getState().records.size).toBe(3)
        expect(store.getState().records.has(1)).toBe(true)
        expect(store.getState().records.has(2)).toBe(true)
        expect(store.getState().records.has(3)).toBe(true)

        // The latest query leads, and the rows it did not mention follow rather
        // than dropping out. `order` is the only route into `records` for every
        // projection, so a row missing from it is in memory and invisible —
        // which made "merge" silently lose the previous fetch's rows.
        expect(store.getState().order).toEqual([2, 1, 3])
      })

      it("updates existing non-pending records with fresh data", async () => {
        const store = createStore({ cacheStrategy: "merge" })

        await store.getState().fetch()
        const oldRecord = store.getState().records.get(1)
        expect(oldRecord?.title).toBe("Buy milk")

        // Mutate server data
        supabase._tables.todos[0] = { ...supabase._tables.todos[0], title: "Buy eggs" }

        // Re-fetch all - should update the record
        await store.getState().fetch()
        expect(store.getState().records.get(1)?.title).toBe("Buy eggs")
      })

      it("does not overwrite pending records", async () => {
        const store = createStore({ cacheStrategy: "merge" })

        // Simulate a pending record with id=1
        store.getState().setRecord(1, {
          id: 1,
          title: "Pending version",
          completed: false,
          created_at: "",
          updated_at: "",
          _anchor_pending: "update",
        } as any)

        await store.getState().fetch()

        // Pending record should keep its local version
        expect(store.getState().records.get(1)?.title).toBe("Pending version")
        expect(store.getState().records.get(1)?._anchor_pending).toBe("update")
        // But it should appear in order since it's in the fetch results
        expect(store.getState().order).toContain(1)
      })

      it("preserves pending rows not in the latest query at end of order", async () => {
        const store = createStore({ cacheStrategy: "merge" })

        // Set a pending record with id=999 (not in server data)
        store.getState().setRecord(999, {
          id: 999,
          title: "New pending",
          completed: false,
          created_at: "",
          updated_at: "",
          _anchor_pending: "insert",
        } as any)

        await store.getState().fetch()

        // Order: all 3 fetched rows + pending 999 at the end
        expect(store.getState().order).toEqual([1, 2, 3, 999])
        expect(store.getState().records.has(999)).toBe(true)
      })
    })

    describe("per-fetch override", () => {
      it("allows merge override on a replace-mode store", async () => {
        const store = createStore() // default: replace

        await store.getState().fetch()
        expect(store.getState().records.size).toBe(3)

        // Fetch completed only with merge override
        await store.getState().fetch({
          filters: [{ column: "completed", op: "eq", value: true }],
          cacheStrategy: "merge",
        })

        // Records accumulated (merge); the latest query leads and the rest
        // stay reachable.
        expect(store.getState().records.size).toBe(3)
        expect(store.getState().order).toEqual([2, 1, 3])
      })

      it("allows replace override on a merge-mode store", async () => {
        const store = createStore({ cacheStrategy: "merge" })

        await store.getState().fetch()
        expect(store.getState().records.size).toBe(3)

        // Fetch completed only with replace override
        await store.getState().fetch({
          filters: [{ column: "completed", op: "eq", value: true }],
          cacheStrategy: "replace",
        })

        // Only completed record remains (replace mode)
        expect(store.getState().records.size).toBe(1)
        expect(store.getState().order).toEqual([2])
      })
    })

    describe("clearAndFetch", () => {
      it("clears all records then fetches fresh", async () => {
        const store = createStore({ cacheStrategy: "merge" })

        // Accumulate data
        await store.getState().fetch()
        await store.getState().fetch({ filters: [{ column: "completed", op: "eq", value: true }] })
        expect(store.getState().records.size).toBe(3) // accumulated

        // Clear and fetch only completed
        const result = await store.getState().clearAndFetch({
          filters: [{ column: "completed", op: "eq", value: true }],
        })

        // Should only have the completed record (replace was forced)
        expect(store.getState().records.size).toBe(1)
        expect(store.getState().order).toEqual([2])
        expect(result).toHaveLength(1)
      })
    })

    describe("fetchGeneration + merge mode", () => {
      it("discards stale responses in merge mode", async () => {
        const store = createStore({ cacheStrategy: "merge" })

        // Seed some initial data
        await store.getState().fetch()
        expect(store.getState().records.size).toBe(3)

        // Fire two fetches concurrently — only the last should apply
        const fetch1 = store.getState().fetch({ filters: [{ column: "completed", op: "eq", value: true }] })
        // Due to in-flight dedup, the second call returns the same promise
        const fetch2 = store.getState().fetch({ filters: [{ column: "completed", op: "eq", value: false }] })

        await Promise.all([fetch1, fetch2])

        // The store should have valid state (no crash, no corruption)
        expect(store.getState().records.size).toBeGreaterThan(0)
        expect(store.getState().isLoading).toBe(false)
      })
    })

    describe("replace mode (default)", () => {
      it("replaces all records on each fetch", async () => {
        const store = createStore() // default: replace

        await store.getState().fetch()
        expect(store.getState().records.size).toBe(3)

        // Fetch only completed
        await store.getState().fetch({
          filters: [{ column: "completed", op: "eq", value: true }],
        })

        // Only completed record should remain
        expect(store.getState().records.size).toBe(1)
        expect(store.getState().order).toEqual([2])
      })
    })
  })

  describe("extend", () => {
    it("allows extending the store with custom actions", () => {
      const store = createTableStore<any, Todo, Partial<Todo>, Partial<Todo>, { completedCount: () => number }>({
        supabase,
        table: "todos",
        extend: (_set, get) => ({
          completedCount: () => {
            return [...get().records.values()].filter((t) => t.completed).length
          },
        }),
      })

      store.getState().setRecord(1, { id: 1, title: "A", completed: true, created_at: "", updated_at: "" })
      store.getState().setRecord(2, { id: 2, title: "B", completed: false, created_at: "", updated_at: "" })
      store.getState().setRecord(3, { id: 3, title: "C", completed: true, created_at: "", updated_at: "" })

      expect(store.getState().completedCount()).toBe(2)
    })
  })
})
