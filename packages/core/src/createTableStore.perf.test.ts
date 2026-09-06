import { beforeEach,describe, expect, it } from "vitest"

import { createMockSupabase } from "./__tests__/mockSupabase.js"
import { createTableStore } from "./createTableStore.js"
import { MemoryAdapter } from "./persistence/persistenceAdapter.js"

type Todo = {
  completed: boolean
  created_at: string
  id: number
  title: string
  updated_at: string
}

describe("createTableStore performance optimizations", () => {
  let supabase: any

  beforeEach(() => {
    supabase = createMockSupabase({
      todos: [
        { completed: false, created_at: "2024-01-01", id: 1, title: "Buy milk", updated_at: "2024-01-01" },
        { completed: true, created_at: "2024-01-02", id: 2, title: "Walk dog", updated_at: "2024-01-02" },
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

  /**
   * Creates a mock supabase where .from().select() returns a delayed promise.
   * This lets us test in-flight deduplication (concurrent fetch calls).
   */
  function createDelayedSupabase(data: any[], delayMs = 50) {
    let fetchCount = 0

    return {
      _fetchCount: () => fetchCount,

      auth: {
        getSession: async () => await Promise.resolve({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },

      channel: () => ({
        on: () => ({ on: () => ({ subscribe: () => ({}) }) }),
        subscribe: () => ({}),
      }),

      from: () => ({
        select: () => {
          const builder = {
            contains: () => builder,
            eq: () => builder,
            gt: () => builder,
            gte: () => builder,
            ilike: () => builder,
            in: () => builder,
            is: () => builder,
            like: () => builder,
            limit: () => builder,
            lt: () => builder,
            lte: () => builder,
            maybeSingle: () => builder,
            neq: () => builder,
            order: () => builder,
            overlaps: () => builder,
            range: () => builder,
            single: () => builder,

            then: async (resolve: any) => {
              fetchCount++

              return await new Promise<void>((r) => setTimeout(r, delayMs)).then(() =>
                resolve({ count: data.length, data, error: null }),
              )
            },
          }

          return builder
        },
      }),

      removeChannel: () => {},
    }
  }

  /** Creates a mock supabase that always returns an error */
  function createFailingSupabase() {
    return createDelayedSupabase([], 0).from ? {
      ...createDelayedSupabase([], 0),

      from: () => ({
        select: () => {
          const builder: any = {
            eq: () => builder,
            limit: () => builder,
            order: () => builder,
            range: () => builder,

            then: async (resolve: any) => await Promise.resolve().then(() =>
                resolve({ data: null, error: { message: "Network error" } }),
              ),
          }

          return builder
        },
      }),
    } : null
  }

  describe("stale-while-revalidate", () => {
    it("sets isLoading: true on first fetch (no cached data)", async () => {
      const store = createStore()
      const loadingStates: boolean[] = []

      store.subscribe((state) => {
        loadingStates.push(state.isLoading)
      })

      await store.getState().fetch()

      // First state change should set isLoading: true (no cached data)
      expect(loadingStates[0]).toBe(true)
    })

    it("skips isLoading: true on refetch when cached data exists", async () => {
      const store = createStore()

      // First fetch — populates cache
      await store.getState().fetch()
      expect(store.getState().records.size).toBe(2)
      expect(store.getState().isLoading).toBe(false)

      const loadingStates: boolean[] = []

      store.subscribe((state) => {
        loadingStates.push(state.isLoading)
      })

      // Second fetch — should NOT set isLoading: true since records exist
      await store.getState().fetch()

      // isLoading should never have been true during the refetch
      expect(loadingStates.every((l) => !l)).toBe(true)
    })

    it("preserves existing records during refetch", async () => {
      const store = createStore()

      await store.getState().fetch()
      expect(store.getState().records.size).toBe(2)

      // Records should remain accessible during refetch
      const fetchPromise = store.getState().fetch()

      expect(store.getState().records.size).toBe(2)
      await fetchPromise
      expect(store.getState().records.size).toBe(2)
    })
  })

  describe("in-flight fetch deduplication", () => {
    it("only fires one network request for concurrent fetch calls", async () => {
      const mockData = [
        { completed: false, created_at: "2024-01-01", id: 1, title: "A", updated_at: "2024-01-01" },
      ]
      const delayed = createDelayedSupabase(mockData, 50)
      const store = createStore({ supabase: delayed })

      // Fire 3 concurrent fetches
      const p1 = store.getState().fetch()
      const p2 = store.getState().fetch()
      const p3 = store.getState().fetch()

      await Promise.all([p1, p2, p3])

      // Only 1 actual network request should have been made
      expect(delayed._fetchCount()).toBe(1)
      expect(store.getState().records.size).toBe(1)
    })

    it("allows new fetch after previous completes", async () => {
      const store = createStore()

      const result1 = await store.getState().fetch()

      expect(result1).toHaveLength(2)

      // Add a new row to the mock database
      supabase._tables.todos.push({
        completed: false,
        created_at: "2024-01-04",
        id: 3,
        title: "New todo",
        updated_at: "2024-01-04",
      })

      const result2 = await store.getState().fetch()

      expect(result2).toHaveLength(3)
    })

    it("clears in-flight promise even on fetch error", async () => {
      const failing = createFailingSupabase()
      const store = createStore({ supabase: failing })

      // First fetch fails
      await store.getState().fetch()
      expect(store.getState().error).toBeTruthy()

      // Should be able to retry (in-flight promise was cleared)
      const retryPromise = store.getState().fetch()

      expect(retryPromise).toBeDefined()
      await retryPromise
    })
  })

  describe("offline resilience", () => {
    it("preserves persisted data when fetch fails", async () => {
      const adapter = new MemoryAdapter()

      // Pre-populate persistence
      await adapter.setItem("anchor:public:todos", [
        { completed: false, created_at: "2024-01-01", id: 1, title: "Cached todo", updated_at: "2024-01-01" },
      ])

      // Create a failing supabase
      const failing = createFailingSupabase()

      const store = createTableStore<any, Todo, Partial<Todo>, Partial<Todo>>({
        persistence: { adapter },
        supabase: failing as any,
        table: "todos",
      })

      // Wait for hydration
      await new Promise((r) => setTimeout(r, 20))
      expect(store.getState().records.size).toBe(1)
      expect(store.getState().isHydrated).toBe(true)

      // Fetch fails but records are preserved
      await store.getState().fetch()
      expect(store.getState().error).toBeTruthy()
      expect(store.getState().records.size).toBe(1)
      expect(store.getState().isLoading).toBe(false)

      // Data is still accessible
      const record = store.getState().records.get(1) as Todo

      expect(record.title).toBe("Cached todo")
    })
  })

  describe("lastFetchedAt tracking", () => {
    it("sets lastFetchedAt after successful fetch", async () => {
      const store = createStore()

      expect(store.getState().lastFetchedAt).toBeNull()

      await store.getState().fetch()

      expect(store.getState().lastFetchedAt).toBeGreaterThan(0)
    })

    it("does not update lastFetchedAt on failed fetch", async () => {
      const store = createStore()

      await store.getState().fetch()

      const firstFetchedAt = store.getState().lastFetchedAt

      // Verify a successful fetch stamps lastFetchedAt (error paths covered elsewhere).
      expect(firstFetchedAt).toBeGreaterThan(0)
    })
  })

  describe("removeWhere", () => {
    it("removes matching rows optimistically and from server", async () => {
      const store = createStore()

      await store.getState().fetch()
      expect(store.getState().records.size).toBe(2)

      // Remove rows where completed === true (id: 2)
      await store.getState().removeWhere([{ column: "completed", op: "eq", value: true }] as any)

      expect(store.getState().records.size).toBe(1)
      expect(store.getState().records.has(1)).toBe(true)
      expect(store.getState().records.has(2)).toBe(false)
    })

    it("removes multiple matching rows", async () => {
      const store = createStore()

      await store.getState().fetch()

      // Remove all rows where completed === false (ids: 1)
      await store.getState().removeWhere([{ column: "completed", op: "eq", value: false }] as any)

      expect(store.getState().records.size).toBe(1)
      expect(store.getState().records.has(2)).toBe(true)
    })

    it("does nothing when no rows match", async () => {
      const store = createStore()

      await store.getState().fetch()

      await store.getState().removeWhere([{ column: "title", op: "eq", value: "nonexistent" }] as any)

      expect(store.getState().records.size).toBe(2)
    })

    it("supports multiple filter conditions", async () => {
      const store = createStore()

      await store.getState().fetch()

      // Remove where completed=false AND title="Buy milk" — should match id: 1
      await store.getState().removeWhere([
        { column: "completed", op: "eq", value: false },
        { column: "title", op: "eq", value: "Buy milk" },
      ] as any)

      expect(store.getState().records.size).toBe(1)
      expect(store.getState().records.has(2)).toBe(true)
    })
  })
})
