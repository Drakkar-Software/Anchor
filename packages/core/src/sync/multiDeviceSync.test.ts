import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setupMultiDeviceSync } from "./multiDeviceSync.js"

type BroadcastHandler = (payload: { payload: any }) => void

function createMockChannel() {
  const handlers = new Map<string, BroadcastHandler>()

  return {
    _trigger(payload: any) {
      const handler = handlers.get("broadcast")

      if (handler) {handler({ payload })}
    },

    on(type: string, _filter: any, handler: BroadcastHandler) {
      handlers.set(type, handler)

      return this
    },

    send: vi.fn(),
    subscribe: vi.fn(() => this),
  }
}

function createMockStore(initialRecords: [string | number, any][] = []) {
  const listeners = new Set<() => void>()

  let currentState: any = {
    error: null,
    isHydrated: true,
    isLoading: false,
    isRestoring: false,
    lastFetchedAt: null,
    order: initialRecords.map(([k]) => k),
    realtimeStatus: "disconnected" as const,
    records: new Map(initialRecords),
  }

  return {
    _triggerChange() {
      for (const cb of listeners) {cb()}
    },

    getInitialState: () => currentState,
    getState: () => currentState,

    setState: vi.fn((updater: any) => {
      currentState = typeof updater === "function" ? updater(currentState) : { ...currentState, ...updater };

      for (const cb of listeners) {cb()}
    }),

    subscribe: (cb: () => void) => {
      listeners.add(cb)

      return () => listeners.delete(cb)
    },
  } as any
}

function createMockSupabase() {
  const channels = new Map<string, ReturnType<typeof createMockChannel>>()

  return {
    _getChannel(name: string) {
      return channels.get(name)
    },

    channel(name: string) {
      const ch = createMockChannel()

      channels.set(name, ch)

      return ch as any
    },

    removeChannel: vi.fn(),
  }
}

describe("setupMultiDeviceSync", () => {
  let supabase: ReturnType<typeof createMockSupabase>

  beforeEach(() => {
    supabase = createMockSupabase()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("subscribes to a realtime broadcast channel", () => {
    const store = createMockStore()

    setupMultiDeviceSync(supabase as any, { todos: store })

    const channel = supabase._getChannel("anchor:device-sync")

    expect(channel).toBeDefined()
    expect(channel!.subscribe).toHaveBeenCalled()
  })

  it("uses custom channel name", () => {
    const store = createMockStore()

    setupMultiDeviceSync(supabase as any, { todos: store }, {
      channelName: "custom-channel",
    })

    expect(supabase._getChannel("custom-channel")).toBeDefined()
  })

  it("merges incoming records from other devices", () => {
    const store = createMockStore([
      [1, { id: 1, title: "Local" }],
    ])

    setupMultiDeviceSync(supabase as any, { todos: store }, {
      deviceId: "device-a",
    })

    const channel = supabase._getChannel("anchor:device-sync")!

    channel._trigger({
      deviceId: "device-b",
      order: [2],
      records: [[2, { id: 2, title: "Remote" }]],
      table: "todos",
      timestamp: Date.now(),
    })

    const state = store.getState()

    expect(state.records.get(2)).toEqual({ id: 2, title: "Remote" })
    expect(state.order).toContain(2)
  })

  it("ignores broadcasts from own device", () => {
    const store = createMockStore()

    setupMultiDeviceSync(supabase as any, { todos: store }, {
      deviceId: "device-a",
    })

    const channel = supabase._getChannel("anchor:device-sync")!

    channel._trigger({
      deviceId: "device-a", // Same device
      order: [1],
      records: [[1, { id: 1, title: "Self" }]],
      table: "todos",
      timestamp: Date.now(),
    })

    expect(store.setState).not.toHaveBeenCalled()
  })

  it("protects pending mutations from being overwritten", () => {
    const store = createMockStore([
      [1, { _anchor_pending: "update", id: 1, title: "Pending Edit" }],
    ])

    setupMultiDeviceSync(supabase as any, { todos: store }, {
      deviceId: "device-a",
    })

    const channel = supabase._getChannel("anchor:device-sync")!

    channel._trigger({
      deviceId: "device-b",
      order: [1],
      records: [[1, { id: 1, title: "Remote Override" }]],
      table: "todos",
      timestamp: Date.now(),
    })

    const state = store.getState()

    expect(state.records.get(1).title).toBe("Pending Edit")
    expect(state.records.get(1)._anchor_pending).toBe("update")
  })

  it("broadcasts store changes with debounce", () => {
    const store = createMockStore([[1, { id: 1, title: "Test" }]])

    setupMultiDeviceSync(supabase as any, { todos: store }, {
      debounceMs: 500,
      deviceId: "device-a",
    })

    // Simulate an actual record change (new object reference for the row)
    store.setState((prev: any) => {
      const records = new Map(prev.records)

      records.set(1, { id: 1, title: "Updated" })

      return { ...prev, records }
    })

    // Should not have sent yet (debounce)
    const channel = supabase._getChannel("anchor:device-sync")!

    expect(channel.send).not.toHaveBeenCalled()

    // Advance past debounce
    vi.advanceTimersByTime(500)

    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sync",

        payload: expect.objectContaining({
          deviceId: "device-a",
          table: "todos",
        }),

        type: "broadcast",
      }),
    )
  })

  it("ignores tables not in the sync list", () => {
    const todosStore = createMockStore()
    const profilesStore = createMockStore()

    setupMultiDeviceSync(
      supabase as any,
      { profiles: profilesStore, todos: todosStore },
      { deviceId: "device-a", tables: ["todos"] },
    )

    const channel = supabase._getChannel("anchor:device-sync")!

    channel._trigger({
      deviceId: "device-b",
      order: [1],
      records: [[1, { id: 1 }]],
      table: "profiles",
      timestamp: Date.now(),
    })

    expect(profilesStore.setState).not.toHaveBeenCalled()
  })

  it("cleanup removes channel and clears timers", () => {
    const store = createMockStore()
    const cleanup = setupMultiDeviceSync(supabase as any, { todos: store }, {
      deviceId: "device-a",
    })

    // Trigger a change to set a timer
    store._triggerChange()

    cleanup()

    expect(supabase.removeChannel).toHaveBeenCalled()

    // Advance timers — no broadcast should fire
    const channel = supabase._getChannel("anchor:device-sync")!

    vi.advanceTimersByTime(5000)
    expect(channel.send).not.toHaveBeenCalled()
  })
})
