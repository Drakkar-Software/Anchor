import { describe, expect, it, vi } from "vitest"
import type { StoreApi } from "zustand"

import type { NetworkStatusAdapter,TableStore, TableStoreState } from "../types.js"
import { computeSyncStatus } from "./useSyncStatus.js"

// ─── Helpers ────────────────────────────────────────────────────────

function createMockNetwork(online: boolean): NetworkStatusAdapter {
  return {
    isOnline: () => online,
    subscribe: () => () => {},
  }
}

function createMockStore(
  state: Partial<TableStoreState<any>> & { getQueueSize?: () => number },
): StoreApi<TableStore<any, any, any>> {
  const fullState = {
    error: null,
    getQueueSize: state.getQueueSize ?? (() => 0),
    isHydrated: true,
    isLoading: false,
    isRestoring: false,
    lastFetchedAt: null,
    order: [],
    realtimeStatus: "disconnected" as const,
    records: new Map(),
    ...state,
  }
  const listeners = new Set<() => void>()

  return {
    getInitialState: () => fullState as any,
    getState: () => fullState as any,
    setState: () => {},

    subscribe: (cb: () => void) => {
      listeners.add(cb)

      return () => {
        listeners.delete(cb)
      }
    },
  } as any
}

// ─── computeSyncStatus ──────────────────────────────────────────────

describe("computeSyncStatus", () => {
  it("returns synced with no stores", () => {
    const result = computeSyncStatus([])

    expect(result.status).toBe("synced")
    expect(result.pendingCount).toBe(0)
    expect(result.isSyncing).toBe(false)
    expect(result.lastSyncedAt).toBeNull()
    expect(result.failedCount).toBe(0)
  })

  it("returns syncing when a store is loading", () => {
    const store = createMockStore({ isLoading: true })
    const result = computeSyncStatus([store])

    expect(result.status).toBe("syncing")
    expect(result.isSyncing).toBe(true)
  })

  it("returns error when a store has an error", () => {
    const store = createMockStore({ error: new Error("fail") })
    const result = computeSyncStatus([store])

    expect(result.status).toBe("error")
    expect(result.failedCount).toBe(1)
  })

  it("error takes precedence over syncing", () => {
    const s1 = createMockStore({ isLoading: true })
    const s2 = createMockStore({ error: new Error("fail") })
    const result = computeSyncStatus([s1, s2])

    expect(result.status).toBe("error")
    expect(result.isSyncing).toBe(true)
    expect(result.failedCount).toBe(1)
  })

  it("returns offline when network is offline", () => {
    const store = createMockStore({})
    const network = createMockNetwork(false)
    const result = computeSyncStatus([store], network)

    expect(result.status).toBe("offline")
  })

  it("error takes precedence over offline", () => {
    const store = createMockStore({ error: new Error("fail") })
    const network = createMockNetwork(false)
    const result = computeSyncStatus([store], network)

    expect(result.status).toBe("error")
  })

  it("counts pending rows across multiple stores", () => {
    const records1 = new Map<string | number, any>([
      [1, { _anchor_pending: "insert", id: 1 }],
      [2, { id: 2 }],
    ])
    const records2 = new Map<string | number, any>([
      [3, { _anchor_pending: "update", id: 3 }],
      [4, { _anchor_pending: "delete", id: 4 }],
    ])
    const s1 = createMockStore({ records: records1 })
    const s2 = createMockStore({ records: records2 })
    const result = computeSyncStatus([s1, s2])

    expect(result.pendingCount).toBe(3)
    expect(result.status).toBe("syncing")
  })

  it("returns syncing when there are pending rows even without loading", () => {
    const records = new Map<string | number, any>([
      [1, { _anchor_pending: "insert", id: 1 }],
    ])
    const store = createMockStore({ records })
    const result = computeSyncStatus([store])

    expect(result.status).toBe("syncing")
    expect(result.isSyncing).toBe(false) // isLoading is false
    expect(result.pendingCount).toBe(1)
  })

  it("picks the oldest lastFetchedAt across stores", () => {
    const s1 = createMockStore({ lastFetchedAt: 1000 })
    const s2 = createMockStore({ lastFetchedAt: 500 })
    const s3 = createMockStore({ lastFetchedAt: 2000 })
    const result = computeSyncStatus([s1, s2, s3])

    expect(result.lastSyncedAt).toBe(500)
  })

  it("ignores null lastFetchedAt values", () => {
    const s1 = createMockStore({ lastFetchedAt: null })
    const s2 = createMockStore({ lastFetchedAt: 1000 })
    const result = computeSyncStatus([s1, s2])

    expect(result.lastSyncedAt).toBe(1000)
  })

  it("returns null lastSyncedAt when all stores have null", () => {
    const s1 = createMockStore({})
    const s2 = createMockStore({})
    const result = computeSyncStatus([s1, s2])

    expect(result.lastSyncedAt).toBeNull()
  })

  it("counts multiple stores with errors", () => {
    const s1 = createMockStore({ error: new Error("a") })
    const s2 = createMockStore({ error: new Error("b") })
    const s3 = createMockStore({})
    const result = computeSyncStatus([s1, s2, s3])

    expect(result.failedCount).toBe(2)
  })

  it("returns synced with network online and no issues", () => {
    const store = createMockStore({})
    const network = createMockNetwork(true)
    const result = computeSyncStatus([store], network)

    expect(result.status).toBe("synced")
  })
})

// ─── Pending changes extraction logic ───────────────────────────────

describe("pending changes extraction", () => {
  it("extracts pending rows with correct mutation types", () => {
    const records = new Map<string | number, any>([
      [1, { _anchor_pending: "insert", id: 1, title: "new" }],
      [2, { _anchor_pending: "update", id: 2, title: "updated" }],
      [3, { id: 3, title: "normal" }],
      [4, { _anchor_pending: "delete", id: 4, title: "deleted" }],
    ])

    const pending: { id: string | number; mutationType: string }[] = []

    for (const [id, row] of records.entries()) {
      if (row._anchor_pending) {
        pending.push({ id, mutationType: row._anchor_pending })
      }
    }

    expect(pending).toHaveLength(3)
    expect(pending[0]).toEqual({ id: 1, mutationType: "insert" })
    expect(pending[1]).toEqual({ id: 2, mutationType: "update" })
    expect(pending[2]).toEqual({ id: 4, mutationType: "delete" })
  })

  it("returns empty array when no pending rows", () => {
    const records = new Map<string | number, any>([
      [1, { id: 1, title: "a" }],
      [2, { id: 2, title: "b" }],
    ])

    const pending: any[] = []

    for (const [_id, row] of records.entries()) {
      if (row._anchor_pending) {pending.push(row)}
    }

    expect(pending).toHaveLength(0)
  })
})

// ─── Queue status logic ─────────────────────────────────────────────

describe("queue status computation", () => {
  it("computes pending count and queue size", () => {
    const records = new Map<string | number, any>([
      [1, { _anchor_pending: "insert", id: 1 }],
      [2, { id: 2 }],
      [3, { _anchor_pending: "update", id: 3 }],
    ])
    const store = createMockStore({ getQueueSize: () => 5, records })
    const state = store.getState()

    let pendingCount = 0

    for (const row of state.records.values()) {
      if (row._anchor_pending) {pendingCount++}
    }

    expect(pendingCount).toBe(2)
    expect(state.getQueueSize()).toBe(5)
  })

  it("returns zero counts for empty store", () => {
    const store = createMockStore({})
    const state = store.getState()

    let pendingCount = 0

    for (const row of state.records.values()) {
      if (row._anchor_pending) {pendingCount++}
    }

    expect(pendingCount).toBe(0)
    expect(state.getQueueSize()).toBe(0)
  })
})

// ─── Mock store subscribe ───────────────────────────────────────────

describe("mock store subscribe", () => {
  it("subscribe returns an unsubscribe function", () => {
    const store = createMockStore({})
    const cb = vi.fn()
    const unsub = store.subscribe(cb)

    expect(typeof unsub).toBe("function")
    unsub()
  })

  it("multi-store subscribe/unsubscribe works", () => {
    const stores = [createMockStore({}), createMockStore({}), createMockStore({})]
    const cb = vi.fn()
    const unsubs = stores.map((s) => s.subscribe(cb))

    expect(unsubs).toHaveLength(3)
    unsubs.forEach((u) => {
      u()
    })
  })
})
