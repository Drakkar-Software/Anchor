import { describe, expect, it, vi } from "vitest"

import {
  type PrioritizedStore,
  syncAllByPriority,
} from "./selectiveSync.js"

function createMockStore(name: string, fetchOrder: string[]) {
  const fetch = vi.fn().mockImplementation(async () => {
    fetchOrder.push(name)

    return []
  })

  return {
    getInitialState: vi.fn(),

    getState: () => ({
      error: null,
      fetch,
      isHydrated: true,
      isLoading: false,
      isRestoring: false,
      lastFetchedAt: null,
      order: [],
      realtimeStatus: "disconnected" as const,
      records: new Map(),
      refetch: fetch,
    }),

    setState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as any
}

describe("syncAllByPriority", () => {
  it("fetches stores in priority order (lower = higher priority)", async () => {
    const fetchOrder: string[] = []
    const storeA = createMockStore("a", fetchOrder)
    const storeB = createMockStore("b", fetchOrder)
    const storeC = createMockStore("c", fetchOrder)

    const stores: PrioritizedStore[] = [
      { priority: 3, store: storeC },
      { priority: 1, store: storeA },
      { priority: 2, store: storeB },
    ]

    const results = await syncAllByPriority(stores)

    expect(fetchOrder).toEqual(["a", "b", "c"])
    expect(results).toHaveLength(3)
    expect(results.map((r) => r.priority)).toEqual([1, 2, 3])
    expect(results.every((r) => r.error === null)).toBe(true)
  })

  it("handles equal priorities", async () => {
    const fetchOrder: string[] = []
    const storeA = createMockStore("a", fetchOrder)
    const storeB = createMockStore("b", fetchOrder)

    const stores: PrioritizedStore[] = [
      { priority: 1, store: storeA },
      { priority: 1, store: storeB },
    ]

    await syncAllByPriority(stores)
    expect(fetchOrder).toHaveLength(2)
  })

  it("continues on fetch error and returns rejection as error", async () => {
    const fetchOrder: string[] = []
    const storeA = createMockStore("a", fetchOrder)
    const storeB = createMockStore("b", fetchOrder)

    const rejection = new Error("fail")

    storeA.getState().fetch.mockImplementationOnce(async () => {
      fetchOrder.push("a")
      throw rejection
    })

    const stores: PrioritizedStore[] = [
      { priority: 1, store: storeA },
      { priority: 2, store: storeB },
    ]

    const results = await syncAllByPriority(stores)

    expect(fetchOrder).toEqual(["a", "b"])
    expect(results).toHaveLength(2)
    expect(results[0]!.error).toBe(rejection)
    expect(results[1]!.error).toBeNull()
  })

  it("returns store state error when fetch resolves", async () => {
    const fetchOrder: string[] = []
    const storeA = createMockStore("a", fetchOrder)
    const stateError = new Error("fetch failed silently")

    const originalGetState = storeA.getState.bind(storeA)

    storeA.getState = vi.fn(() => ({
      ...originalGetState(),
      error: stateError,
    }))

    const results = await syncAllByPriority([{ priority: 1, store: storeA }])

    expect(results).toHaveLength(1)
    expect(results[0]!.error).toBe(stateError)
  })

  it("handles empty store list", async () => {
    await expect(syncAllByPriority([])).resolves.toEqual([])
  })

  it("does not mutate the input array", async () => {
    const fetchOrder: string[] = []
    const stores: PrioritizedStore[] = [
      { priority: 3, store: createMockStore("c", fetchOrder) },
      { priority: 1, store: createMockStore("a", fetchOrder) },
    ]

    const original = Array.from(stores)

    await syncAllByPriority(stores)

    expect(stores[0]!.priority).toBe(original[0]!.priority)
    expect(stores[1]!.priority).toBe(original[1]!.priority)
  })
})
