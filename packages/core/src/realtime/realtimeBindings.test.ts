import { describe, expect, it, vi } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { createSupabaseStores } from "../createSupabaseStores.js"
import { createTableStore } from "../createTableStore.js"
import { bindRealtimeToStore } from "./realtimeBindings.js"
import { RealtimeManager } from "./realtimeManager.js"

type Todo = { completed: boolean; id: number; title: string; }

function createTestManager() {
  const channels: any[] = []
  const supabase = {
    _channels: channels,

    channel(_name: string) {
      const listeners: any[] = []
      const ch = {
        _fire: (payload: any) => { for (const l of listeners) {l(payload)} },

        on(_e: string, _f: any, cb: any) { listeners.push(cb);

 return ch },

        subscribe(cb?: any) { if (cb) {cb("SUBSCRIBED");}

 return ch },
      }

      channels.push(ch)

      return ch
    },

    removeChannel: vi.fn(),
  } as any

  return { manager: new RealtimeManager({ supabase }), supabase }
}

function createTestStore() {
  const supabase = createMockSupabase({})

  return createTableStore<any, Todo, any, any>({ supabase, table: "todos" })
}

describe("bindRealtimeToStore", () => {
  it("adds new records on INSERT events", () => {
    const store = createTestStore()
    const { manager, supabase } = createTestManager()

    bindRealtimeToStore(manager, store, { primaryKey: "id", table: "todos" })

    const channel = supabase._channels[0]

    channel._fire({ eventType: "INSERT", new: { completed: false, id: 1, title: "New" }, old: {} })

    expect(store.getState().records.has(1)).toBe(true)
    expect(store.getState().records.get(1)?.title).toBe("New")
  })

  it("updates existing records on UPDATE events", () => {
    const store = createTestStore()

    store.getState().setRecord(1, { completed: false, id: 1, title: "Old" })

    const { manager, supabase } = createTestManager()

    bindRealtimeToStore(manager, store, { primaryKey: "id", table: "todos" })

    const channel = supabase._channels[0]

    channel._fire({ eventType: "UPDATE", new: { completed: true, id: 1, title: "Updated" }, old: {} })

    expect(store.getState().records.get(1)?.title).toBe("Updated")
  })

  it("removes records on DELETE events", () => {
    const store = createTestStore()

    store.getState().setRecord(1, { completed: false, id: 1, title: "A" })

    const { manager, supabase } = createTestManager()

    bindRealtimeToStore(manager, store, { primaryKey: "id", table: "todos" })

    const channel = supabase._channels[0]

    channel._fire({ eventType: "DELETE", new: {}, old: { id: 1 } })

    expect(store.getState().records.has(1)).toBe(false)
  })

  it("does NOT overwrite pending INSERT on realtime INSERT", () => {
    const store = createTestStore()

    store.getState().setRecord(1, {
      _anchor_pending: "insert", completed: false, id: 1,
      title: "Pending",
    } as any)

    const { manager, supabase } = createTestManager()

    bindRealtimeToStore(manager, store, { primaryKey: "id", table: "todos" })

    const channel = supabase._channels[0]

    channel._fire({ eventType: "INSERT", new: { completed: true, id: 1, title: "Remote" }, old: {} })

    // Pending record should NOT be overwritten
    expect(store.getState().records.get(1)?.title).toBe("Pending")
  })

  it("does NOT overwrite pending UPDATE on realtime UPDATE", () => {
    const store = createTestStore()

    store.getState().setRecord(1, {
      _anchor_pending: "update", completed: false, id: 1,
      title: "Pending update",
    } as any)

    const { manager, supabase } = createTestManager()

    bindRealtimeToStore(manager, store, { primaryKey: "id", table: "todos" })

    const channel = supabase._channels[0]

    channel._fire({ eventType: "UPDATE", new: { completed: true, id: 1, title: "Remote" }, old: {} })

    expect(store.getState().records.get(1)?.title).toBe("Pending update")
  })

  it("does NOT delete pending record on realtime DELETE", () => {
    const store = createTestStore()

    store.getState().setRecord(1, {
      _anchor_pending: "update", completed: false, id: 1,
      title: "Pending",
    } as any)

    const { manager, supabase } = createTestManager()

    bindRealtimeToStore(manager, store, { primaryKey: "id", table: "todos" })

    const channel = supabase._channels[0]

    channel._fire({ eventType: "DELETE", new: {}, old: { id: 1 } })

    // Pending record should NOT be deleted
    expect(store.getState().records.has(1)).toBe(true)
  })

  it("returns cleanup function", () => {
    const store = createTestStore()
    const { manager, supabase } = createTestManager()

    const cleanup = bindRealtimeToStore(manager, store, { primaryKey: "id", table: "todos" })

    expect(typeof cleanup).toBe("function")

    cleanup()
    expect(supabase.removeChannel).toHaveBeenCalled()
  })
})

describe("store.subscribe() is no longer a no-op", () => {
  // `subscribe(filter)` and `unsubscribe()` returned `() => {}` and did nothing.
  // That silently made `hooks/useRealtime.ts`'s subscribe path and
  // `appLifecycle`'s `pauseRealtimeOnBackground` do nothing while reporting
  // success — realtime only ever worked through
  // `createSupabaseStores({realtime: {enabled: true}})`.

  it("opens a channel and applies an INSERT to the store", () => {
    const supabase = createMockSupabase({ todos: [] })
    const stores = createSupabaseStores<any>({
      auth: false,
      fetchRemoteOnBoot: false,
      supabase,
      tables: ["todos"],
    })

    stores.todos.getState().subscribe()

    const channel = supabase.getChannels()[0]

    expect(channel).toBeDefined()
    channel._fireEvent("postgres_changes", { eventType: "INSERT", new: { id: 1, title: "live" } })

    expect(stores.todos.getState().records.get(1)).toMatchObject({ title: "live" })
  })

  it("stops applying events after unsubscribe()", () => {
    const supabase = createMockSupabase({ todos: [] })
    const stores = createSupabaseStores<any>({
      auth: false,
      fetchRemoteOnBoot: false,
      supabase,
      tables: ["todos"],
    })

    stores.todos.getState().subscribe()

    const channel = supabase.getChannels()[0]

    stores.todos.getState().unsubscribe()
    channel._fireEvent("postgres_changes", { eventType: "INSERT", new: { id: 1, title: "late" } })

    expect(stores.todos.getState().records.size).toBe(0)
  })

  it("returns a cleanup that also stops it", () => {
    const supabase = createMockSupabase({ todos: [] })
    const stores = createSupabaseStores<any>({
      auth: false, fetchRemoteOnBoot: false, supabase, tables: ["todos"],
    })

    const cleanup = stores.todos.getState().subscribe()
    const channel = supabase.getChannels()[0]

    cleanup()

    channel._fireEvent("postgres_changes", { eventType: "INSERT", new: { id: 1 } })
    expect(stores.todos.getState().records.size).toBe(0)
  })

  it("replaces the previous subscription rather than orphaning a channel", () => {
    const supabase = createMockSupabase({ todos: [] })
    const stores = createSupabaseStores<any>({
      auth: false, fetchRemoteOnBoot: false, supabase, tables: ["todos"],
    })

    stores.todos.getState().subscribe()
    stores.todos.getState().subscribe()

    // One live channel, not two firing the same event twice.
    expect(supabase.getChannels()).toHaveLength(1)
  })

  it("throws on a standalone store, instead of quietly subscribing to nothing", () => {
    const supabase = createMockSupabase({ todos: [] })
    const store = createTableStore<any, any, any, any>({ supabase, table: "todos" })

    // A caller who asked for realtime and silently got none has no way to find
    // out, which is the bug this replaces.
    expect(() => store.getState().subscribe()).toThrow(/createSupabaseStores/v)
  })
})
