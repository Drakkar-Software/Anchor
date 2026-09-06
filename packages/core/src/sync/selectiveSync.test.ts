import { describe, expect, it, vi } from "vitest"

import { type PrioritizedStore , syncAllByPriority } from "./selectiveSync.js"

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

    await syncAllByPriority(stores)

    expect(fetchOrder).toEqual(["a", "b", "c"])
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

  it("continues on fetch error", async () => {
    const fetchOrder: string[] = []
    const storeA = createMockStore("a", fetchOrder)
    const storeB = createMockStore("b", fetchOrder)

    // Make storeA's fetch fail
    storeA.getState().fetch.mockRejectedValueOnce(new Error("fail"))

    const stores: PrioritizedStore[] = [
      { priority: 1, store: storeA },
      { priority: 2, store: storeB },
    ]

    await syncAllByPriority(stores)

    // storeB should still be fetched even though storeA failed
    expect(fetchOrder).toContain("b")
  })

  it("handles empty store list", async () => {
    await expect(syncAllByPriority([])).resolves.toBeUndefined()
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
