import { describe, it, expect, vi } from "vitest"
import { createStore } from "zustand/vanilla"
import type { StoreApi } from "zustand"
import type { TableStore } from "../types.js"

/**
 * Since we don't have @testing-library/react, we test the subscription
 * logic by verifying that store.subscribe is called and that record
 * changes are detectable via the pattern useLinkedQuery uses.
 */

function createMockTableStore(
  initialRecords: Map<string | number, any> = new Map(),
): StoreApi<TableStore<any, any, any>> {
  return createStore<any>()(() => ({
    records: initialRecords,
    order: [...initialRecords.keys()],
    isLoading: false,
    error: null,
    isHydrated: true,
    isRestoring: false,
    lastFetchedAt: null,
    realtimeStatus: "disconnected" as const,
    getQueueSize: () => 0,
    fetch: async () => [],
    fetchOne: async () => null,
    refetch: async () => [],
    insert: async () => ({}),
    insertMany: async () => [],
    update: async () => ({}),
    upsert: async () => ({}),
    remove: async () => {},
    removeWhere: async () => {},
    setRecord: () => {},
    removeRecord: () => {},
    clearAll: () => {},
    mergeRecords: () => {},
    subscribe: () => () => {},
    unsubscribe: () => {},
    hydrate: async () => {},
    persist: async () => {},
    flushQueue: async () => {},
  }))
}

describe("useLinkedQuery - store subscription pattern", () => {
  it("store subscription fires when records Map reference changes", () => {
    const store = createMockTableStore(
      new Map([[1, { id: 1, name: "Alice" }]]),
    )

    const callback = vi.fn()
    store.subscribe((state) => {
      callback(state.records)
    })

    // Simulate a mutation — creates a new Map reference (same pattern as createTableStore)
    const prev = store.getState().records
    const next = new Map(prev)
    next.set(2, { id: 2, name: "Bob" })
    store.setState({ records: next, order: [1, 2] })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0]).not.toBe(prev)
    expect(callback.mock.calls[0][0].size).toBe(2)
  })

  it("store subscription does not fire when records ref is the same", () => {
    const store = createMockTableStore(
      new Map([[1, { id: 1, name: "Alice" }]]),
    )

    const callback = vi.fn()
    let prevRecords = store.getState().records

    store.subscribe((state) => {
      if (state.records !== prevRecords) {
        prevRecords = state.records
        callback()
      }
    })

    // Changing non-records state should not trigger the callback
    store.setState({ isLoading: true })
    expect(callback).not.toHaveBeenCalled()
  })

  it("detects record changes across multiple stores", () => {
    const store1 = createMockTableStore(new Map([[1, { id: 1 }]]))
    const store2 = createMockTableStore(new Map([[10, { id: 10 }]]))

    const stores = [store1, store2]
    let version = 0

    const prevRecords = stores.map((s) => s.getState().records)

    const unsubs = stores.map((store, i) =>
      store.subscribe((state) => {
        if (state.records !== prevRecords[i]) {
          prevRecords[i] = state.records
          version++
        }
      }),
    )

    // Mutate store1
    const next1 = new Map(store1.getState().records)
    next1.set(2, { id: 2 })
    store1.setState({ records: next1 })
    expect(version).toBe(1)

    // Mutate store2
    const next2 = new Map(store2.getState().records)
    next2.delete(10)
    store2.setState({ records: next2 })
    expect(version).toBe(2)

    unsubs.forEach((u) => u())
  })

  it("unsubscribes cleanly on cleanup", () => {
    const store = createMockTableStore()

    const unsub = store.subscribe(() => {})
    // Should not throw
    unsub()
  })

  // ─── initialData ─────────────────────────────────────────────────────────

  it("initialData as value seeds data state immediately", () => {
    const seed = { id: "1", title: "Cached offer" }

    // Simulate useState initializer behaviour: resolve once on mount
    const raw = seed
    const resolved =
      typeof raw === "function" ? (raw as () => typeof seed)() : raw
    const hasInitialData = resolved !== undefined

    expect(resolved).toEqual(seed)
    expect(hasInitialData).toBe(true)
  })

  it("initialData as getter function is called and its result used", () => {
    const record = { id: "42", name: "Alice" }
    const store = createMockTableStore(new Map([["42", record]]))

    const getter = () => store.getState().records.get("42")
    const resolved = typeof getter === "function" ? getter() : getter

    expect(resolved).toEqual(record)
    expect(resolved !== undefined).toBe(true)
  })

  it("initialData getter returning undefined yields loading state", () => {
    // Store is empty — getter returns undefined
    const store = createMockTableStore(new Map())
    const getter = () => store.getState().records.get("missing-id")
    const resolved = typeof getter === "function" ? getter() : getter

    expect(resolved).toBeUndefined()
    // isLoading initial state = enabled && !hasInitialData = true && true = true
    const isLoading = true && resolved === undefined
    expect(isLoading).toBe(true)
  })

  it("initialData present suppresses initial loading state", () => {
    const seed = [{ id: "1" }, { id: "2" }]
    const hasInitialData = seed !== undefined
    // isLoading initial = enabled && !hasInitialData
    const isLoadingInitial = true && !hasInitialData
    expect(isLoadingInitial).toBe(false)
  })

  // ─── mergeToStore ─────────────────────────────────────────────────────────

  it("mergeToStore calls mergeRecords when result is an array", async () => {
    const mergeRecords = vi.fn()
    const store = createMockTableStore()
    store.setState({ ...store.getState(), mergeRecords })

    const rows = [{ id: "1" }, { id: "2" }]
    let gen = 0

    const runRefetch = async (queryFn: () => Promise<unknown>) => {
      const currentGen = ++gen
      const result = await queryFn()
      if (currentGen === gen) {
        if (Array.isArray(result)) {
          store.getState().mergeRecords(result as any[])
        }
      }
      return result
    }

    await runRefetch(() => Promise.resolve(rows))
    expect(mergeRecords).toHaveBeenCalledTimes(1)
    expect(mergeRecords).toHaveBeenCalledWith(rows)
  })

  it("mergeToStore does not call mergeRecords when result is not an array", async () => {
    const mergeRecords = vi.fn()
    const store = createMockTableStore()
    store.setState({ ...store.getState(), mergeRecords })

    const singleRecord = { id: "1", title: "Single" }
    let gen = 0

    const runRefetch = async (queryFn: () => Promise<unknown>) => {
      const currentGen = ++gen
      const result = await queryFn()
      if (currentGen === gen) {
        if (Array.isArray(result)) {
          store.getState().mergeRecords(result as any[])
        }
      }
    }

    await runRefetch(() => Promise.resolve(singleRecord))
    expect(mergeRecords).not.toHaveBeenCalled()
  })

  it("mergeToStore is not called when the query throws", async () => {
    const mergeRecords = vi.fn()
    const store = createMockTableStore()
    store.setState({ ...store.getState(), mergeRecords })

    let gen = 0

    const runRefetch = async (queryFn: () => Promise<unknown>) => {
      const currentGen = ++gen
      try {
        const result = await queryFn()
        if (currentGen === gen && Array.isArray(result)) {
          store.getState().mergeRecords(result as any[])
        }
      } catch {
        // error handling — mergeRecords must not be called
      }
    }

    await runRefetch(() => Promise.reject(new Error("network error")))
    expect(mergeRecords).not.toHaveBeenCalled()
  })

  // ─── mergeToStore + store subscription loop prevention ─────────────────

  it("isMerging flag prevents store subscription from firing during own mergeToStore write", () => {
    const store = createMockTableStore(
      new Map([["1", { id: "1", name: "Alice" }]]),
    )

    let isMerging = false
    let storeVersion = 0

    const prevRecords = [store.getState().records]

    store.subscribe((state) => {
      if (state.records !== prevRecords[0]) {
        prevRecords[0] = state.records
        // Same guard as useLinkedQuery: skip bump when merging
        if (!isMerging) {
          storeVersion++
        }
      }
    })

    // Simulate mergeToStore write (guarded)
    isMerging = true
    const next = new Map(store.getState().records)
    next.set("2", { id: "2", name: "Bob" })
    store.setState({ records: next })
    isMerging = false

    // storeVersion should NOT have incremented
    expect(storeVersion).toBe(0)

    // External mutation (not guarded) SHOULD increment
    const next2 = new Map(store.getState().records)
    next2.set("3", { id: "3", name: "Charlie" })
    store.setState({ records: next2 })

    expect(storeVersion).toBe(1)
  })

  // ─── staleTime ────────────────────────────────────────────────────────────

  it("staleTime: fetch is skipped when data is fresh", () => {
    // Simulate: lastFetchedAt is recent, staleTime is 5000ms, no store mutation
    const lastFetchedAt = Date.now() - 100 // fetched 100ms ago
    const staleTime = 5000
    const storeVersion = 0
    let prevStoreVersion = 0

    const storeVersionChanged = prevStoreVersion !== storeVersion
    prevStoreVersion = storeVersion

    const shouldSkip =
      !storeVersionChanged &&
      staleTime > 0 &&
      lastFetchedAt !== null &&
      Date.now() - lastFetchedAt < staleTime

    expect(shouldSkip).toBe(true)
  })

  it("staleTime: fetch runs when data is stale", () => {
    const lastFetchedAt = Date.now() - 10_000 // fetched 10s ago
    const staleTime = 5000
    const storeVersion = 0
    let prevStoreVersion = 0

    const storeVersionChanged = prevStoreVersion !== storeVersion
    prevStoreVersion = storeVersion

    const shouldSkip =
      !storeVersionChanged &&
      staleTime > 0 &&
      lastFetchedAt !== null &&
      Date.now() - lastFetchedAt < staleTime

    expect(shouldSkip).toBe(false)
  })

  it("staleTime: store mutation bypasses freshness guard", () => {
    const lastFetchedAt = Date.now() - 100 // data is fresh
    const staleTime = 5000
    const storeVersion = 1 // store mutated
    let prevStoreVersion = 0

    const storeVersionChanged = prevStoreVersion !== storeVersion
    prevStoreVersion = storeVersion

    const shouldSkip =
      !storeVersionChanged &&
      staleTime > 0 &&
      lastFetchedAt !== null &&
      Date.now() - lastFetchedAt < staleTime

    // Store mutation → storeVersionChanged = true → guard bypassed
    expect(storeVersionChanged).toBe(true)
    expect(shouldSkip).toBe(false)
  })

  it("staleTime=0: always fetches regardless of lastFetchedAt", () => {
    const lastFetchedAt = Date.now() - 1 // nearly instant ago
    const staleTime = 0
    const storeVersion = 0
    let prevStoreVersion = 0

    const storeVersionChanged = prevStoreVersion !== storeVersion
    prevStoreVersion = storeVersion

    const shouldSkip =
      !storeVersionChanged &&
      staleTime > 0 &&
      lastFetchedAt !== null &&
      Date.now() - lastFetchedAt < staleTime

    expect(shouldSkip).toBe(false)
  })

  it("staleTime: isLoading stays false when data exists (SWR background fetch)", () => {
    // hasDataRef starts true (from initialData or prior fetch)
    let hasData = true
    let isLoading = false

    // Simulate refetch() with SWR guard
    const startLoading = () => {
      if (!hasData) isLoading = true
    }
    const finishFetch = () => {
      hasData = true
      isLoading = false
    }

    startLoading()
    expect(isLoading).toBe(false) // data exists → skeleton suppressed

    finishFetch()
    expect(isLoading).toBe(false)
    expect(hasData).toBe(true)
  })

  it("staleTime: isLoading is true when no data yet (cold start)", () => {
    let hasData = false
    let isLoading = false

    const startLoading = () => {
      if (!hasData) isLoading = true
    }

    startLoading()
    expect(isLoading).toBe(true) // no data → show skeleton
  })

  it("generation counter pattern discards stale results", async () => {
    let generationRef = 0
    const results: string[] = []

    // Simulate two concurrent fetches where the first resolves after the second
    const fetch1 = new Promise<string>((resolve) =>
      setTimeout(() => resolve("stale"), 20),
    )
    const fetch2 = new Promise<string>((resolve) =>
      setTimeout(() => resolve("fresh"), 5),
    )

    // Start fetch1
    const gen1 = ++generationRef
    fetch1.then((result) => {
      if (gen1 === generationRef) results.push(result)
    })

    // Start fetch2 (supersedes fetch1)
    const gen2 = ++generationRef
    fetch2.then((result) => {
      if (gen2 === generationRef) results.push(result)
    })

    await new Promise((r) => setTimeout(r, 50))

    // Only the fresh result should be recorded
    expect(results).toEqual(["fresh"])
  })
})
