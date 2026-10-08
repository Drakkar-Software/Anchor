import { afterEach,beforeEach, describe, expect, it, vi } from "vitest"
import { createStore } from "zustand/vanilla"

import { setupBroadcastSync, setupCrossTabSync, setupStorageFallback } from "./crossTabSync.js"

// Mock BroadcastChannel for Node.js test environment
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = []

  name: string

  onmessage: ((event: { data: any }) => void) | null = null

  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.instances.push(this)
  }

  postMessage(data: any) {
    // Deliver to all OTHER instances with the same name
    for (const instance of MockBroadcastChannel.instances) {
      if (instance !== this && instance.name === this.name && instance.onmessage) {
        instance.onmessage({ data } as any)
      }
    }
  }

  close() {
    const idx = MockBroadcastChannel.instances.indexOf(this)

    if (idx !== -1) {MockBroadcastChannel.instances.splice(idx, 1)}
  }
}

// Install globally
;

(globalThis as any).BroadcastChannel = MockBroadcastChannel

type TestState = {
  isHydrated: boolean
  isRestoring: boolean
  order: (string | number)[]
  records: Map<string | number, unknown>
}

function createTestStore(overrides: Partial<TestState> = {}) {
  return createStore<TestState>()(() => ({
    isHydrated: true,
    isRestoring: false,
    order: [],
    records: new Map(),
    ...overrides,
  }))
}

describe("crossTabSync", () => {
  beforeEach(() => {
    MockBroadcastChannel.instances = []
  })

  afterEach(() => {
    MockBroadcastChannel.instances = []
  })

  it("syncs state between two stores via BroadcastChannel", () => {
    const storeA = createTestStore()
    const storeB = createTestStore()

    const cleanupA = setupBroadcastSync(storeA, "test-channel")
    const cleanupB = setupBroadcastSync(storeB, "test-channel")

    // Mutate store A
    storeA.setState({
      order: [1],
      records: new Map([[1, { id: 1, title: "Hello" }]]),
    })

    // Store B should have received the update
    expect(storeB.getState().records.has(1)).toBe(true)
    expect(storeB.getState().order).toContain(1)

    cleanupA()
    cleanupB()
  })

  it("does not apply cross-tab data during hydration", () => {
    const storeA = createTestStore()
    const storeB = createTestStore({ isHydrated: false })

    const cleanupA = setupBroadcastSync(storeA, "test-hydration")
    const cleanupB = setupBroadcastSync(storeB, "test-hydration")

    // Mutate store A
    storeA.setState({
      order: [1],
      records: new Map([[1, { id: 1, title: "Hello" }]]),
    })

    // Store B should NOT receive (not yet hydrated)
    expect(storeB.getState().records.size).toBe(0)

    cleanupA()
    cleanupB()
  })

  it("ignores messages from different auth sessions", () => {
    const storeA = createTestStore()
    const storeB = createTestStore()

    const cleanupA = setupBroadcastSync(storeA, "test-auth", "user-1")
    const cleanupB = setupBroadcastSync(storeB, "test-auth", "user-2")

    // Mutate store A (user-1)
    storeA.setState({
      order: [1],
      records: new Map([[1, { id: 1, title: "Private data" }]]),
    })

    // Store B (user-2) should NOT receive user-1's data
    expect(storeB.getState().records.size).toBe(0)

    cleanupA()
    cleanupB()
  })

  it("preserves pending rows during cross-tab sync", () => {
    const storeA = createTestStore()
    const storeB = createTestStore()

    // Store B has a pending mutation
    storeB.setState({
      order: [99],
      records: new Map([[99, { _anchor_pending: "insert", id: 99, title: "Pending" }]]),
    })

    const cleanupA = setupBroadcastSync(storeA, "test-pending")
    const cleanupB = setupBroadcastSync(storeB, "test-pending")

    // Store A broadcasts its state (doesn't include id=99)
    storeA.setState({
      order: [1],
      records: new Map([[1, { id: 1, title: "From A" }]]),
    })

    // Store B should have BOTH: incoming from A and preserved pending.
    // 99 was not in A's order, so it is appended once.
    expect(storeB.getState().records.get(1)).toMatchObject({ title: "From A" })
    expect(storeB.getState().records.get(99)).toMatchObject({ title: "Pending", _anchor_pending: "insert" })
    expect(storeB.getState().order).toEqual([1, 99])

    cleanupA()
    cleanupB()
  })

  it("does not append a pending id the sender already ordered", () => {
    const storeA = createTestStore()
    const storeB = createTestStore({
      order: [99],
      records: new Map([[99, { _anchor_pending: "update", id: 99, title: "Pending" }]]),
    })

    const cleanupA = setupBroadcastSync(storeA, "test-pending-ordered")
    const cleanupB = setupBroadcastSync(storeB, "test-pending-ordered")

    storeA.setState({
      order: [99, 1],
      records: new Map([[1, { id: 1, title: "From A" }]]),
    })

    expect(storeB.getState().records.get(99)).toMatchObject({ title: "Pending" })
    expect(storeB.getState().order).toEqual([99, 1])

    cleanupA()
    cleanupB()
  })
})

// Node has neither localStorage nor storage events. The shim records writes and
// delivers them only when the test emits, matching a browser: setItem does not
// fire `storage` in the writing document.
function installStorageShim() {
  const data = new Map<string, string>()
  const listeners = new Set<(event: { key: string | null; newValue: string | null }) => void>()

  ;(globalThis as any).localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => { data.delete(key) },
    setItem: (key: string, value: string) => { data.set(key, value) },
  }

  ;(globalThis as any).addEventListener = (type: string, cb: (event: any) => void) => {
    if (type === "storage") {listeners.add(cb)}
  }

  ;(globalThis as any).removeEventListener = (type: string, cb: (event: any) => void) => {
    if (type === "storage") {listeners.delete(cb)}
  }

  return {
    emit(key: string) {
      const newValue = data.get(key) ?? null

      for (const listener of listeners) {
        listener({ key, newValue })
      }
    },

    uninstall() {
      delete (globalThis as any).localStorage
      delete (globalThis as any).addEventListener
      delete (globalThis as any).removeEventListener
    },
  }
}

describe("storage fallback", () => {
  let shim: ReturnType<typeof installStorageShim>

  beforeEach(() => {
    shim = installStorageShim()
  })

  afterEach(() => {
    shim.uninstall()
  })

  it("syncs state when a storage event delivers the other tab's write", () => {
    const storeA = createTestStore()
    const storeB = createTestStore()
    const cleanupA = setupStorageFallback(storeA, "storage-sync")
    const cleanupB = setupStorageFallback(storeB, "storage-sync")

    storeA.setState({
      order: [1],
      records: new Map([[1, { id: 1, title: "Hello" }]]),
    })

    // Same document: the write is stored, and nothing has been delivered yet.
    expect(storeB.getState().records.size).toBe(0)

    shim.emit("anchor:broadcast:storage-sync")

    expect(storeB.getState().records.get(1)).toMatchObject({ title: "Hello" })
    expect(storeB.getState().order).toEqual([1])

    cleanupA()
    cleanupB()
  })

  it("keeps a pending row, including when the sender already lists its id", () => {
    const storeA = createTestStore()
    const storeB = createTestStore({
      order: [99],
      records: new Map([[99, { _anchor_pending: "insert", id: 99, title: "Pending" }]]),
    })
    const cleanupA = setupStorageFallback(storeA, "storage-pending")
    const cleanupB = setupStorageFallback(storeB, "storage-pending")

    storeA.setState({
      order: [1],
      records: new Map([[1, { id: 1, title: "From A" }]]),
    })
    shim.emit("anchor:broadcast:storage-pending")

    expect(storeB.getState().records.get(1)).toMatchObject({ title: "From A" })
    expect(storeB.getState().records.get(99)).toMatchObject({ title: "Pending" })
    expect(storeB.getState().order).toEqual([1, 99])

    storeA.setState({
      order: [99, 1],
      records: new Map([[1, { id: 1, title: "From A" }]]),
    })
    shim.emit("anchor:broadcast:storage-pending")

    expect(storeB.getState().records.get(99)).toMatchObject({ title: "Pending" })
    expect(storeB.getState().order).toEqual([99, 1])

    cleanupA()
    cleanupB()
  })

  it("applies a matching session and ignores a different one", () => {
    const storeA = createTestStore()
    const storeB = createTestStore()
    const storeC = createTestStore()
    const cleanupA = setupStorageFallback(storeA, "storage-auth", "user-1")
    const cleanupB = setupStorageFallback(storeB, "storage-auth", "user-1")
    const cleanupC = setupStorageFallback(storeC, "storage-auth", "user-2")

    storeA.setState({
      order: [1],
      records: new Map([[1, { id: 1, title: "Private" }]]),
    })
    shim.emit("anchor:broadcast:storage-auth")

    expect(storeB.getState().records.get(1)).toMatchObject({ title: "Private" })
    expect(storeC.getState().records.size).toBe(0)

    cleanupA()
    cleanupB()
    cleanupC()
  })

  it("does not apply during hydration, then applies once hydrated", () => {
    const storeA = createTestStore()
    const storeB = createTestStore({ isHydrated: false })
    const cleanupA = setupStorageFallback(storeA, "storage-hydration")
    const cleanupB = setupStorageFallback(storeB, "storage-hydration")

    storeA.setState({
      order: [1],
      records: new Map([[1, { id: 1, title: "Hello" }]]),
    })
    shim.emit("anchor:broadcast:storage-hydration")

    expect(storeB.getState().records.size).toBe(0)

    storeB.setState({ isHydrated: true })
    shim.emit("anchor:broadcast:storage-hydration")

    expect(storeB.getState().records.get(1)).toMatchObject({ title: "Hello" })

    cleanupA()
    cleanupB()
  })

  it("leaves state unchanged when the stored payload is not JSON", () => {
    const store = createTestStore({
      order: [1],
      records: new Map([[1, { id: 1, title: "Kept" }]]),
    })
    const cleanup = setupStorageFallback(store, "storage-bad")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    ;(globalThis as any).localStorage.setItem("anchor:broadcast:storage-bad", "{")
    shim.emit("anchor:broadcast:storage-bad")

    expect(store.getState().records.get(1)).toMatchObject({ title: "Kept" })
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
    cleanup()
  })
})

describe("setupCrossTabSync transport choice", () => {
  it("uses BroadcastChannel when present and storage events when it is not", () => {
    const storeA = createTestStore()
    const storeB = createTestStore()
    const cleanupA = setupCrossTabSync(storeA, "auto-bc")
    const cleanupB = setupCrossTabSync(storeB, "auto-bc")

    storeA.setState({
      order: [1],
      records: new Map([[1, { id: 1, title: "bc" }]]),
    })

    expect(storeB.getState().records.get(1)).toMatchObject({ title: "bc" })
    cleanupA()
    cleanupB()

    const saved = (globalThis as any).BroadcastChannel

    delete (globalThis as any).BroadcastChannel

    const shim = installStorageShim()

    try {
      const storeC = createTestStore()
      const storeD = createTestStore()
      const cleanupC = setupCrossTabSync(storeC, "auto-storage")
      const cleanupD = setupCrossTabSync(storeD, "auto-storage")

      storeC.setState({
        order: [2],
        records: new Map([[2, { id: 2, title: "ls" }]]),
      })

      expect(storeD.getState().records.size).toBe(0)

      shim.emit("anchor:broadcast:auto-storage")

      expect(storeD.getState().records.get(2)).toMatchObject({ title: "ls" })
      cleanupC()
      cleanupD()
    } finally {
      (globalThis as any).BroadcastChannel = saved

      shim.uninstall()
    }
  })
})
