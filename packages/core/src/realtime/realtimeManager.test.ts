import { describe, it, expect, vi } from "vitest"
import { RealtimeManager } from "./realtimeManager.js"

function createMockSupabase() {
  const channels: any[] = []
  return {
    channel(name: string) {
      const listeners: Array<{ event: string; filter: any; callback: any }> = []
      let statusCallback: any = null
      const ch = {
        on(event: string, filter: any, callback: any) {
          listeners.push({ event, filter, callback })
          return ch
        },
        subscribe(cb?: (status: string) => void) {
          statusCallback = cb
          if (cb) cb("SUBSCRIBED")
          return ch
        },
        _listeners: listeners,
        _fireStatus: (s: string, err?: Error) => statusCallback?.(s, err),
        _fireEvent: (payload: any) => {
          for (const l of listeners) l.callback(payload)
        },
      }
      channels.push(ch)
      return ch
    },
    removeChannel: vi.fn(),
    _channels: channels,
  } as any
}

describe("RealtimeManager", () => {
  it("subscribes to a table and fires onStatus", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })
    const onStatus = vi.fn()

    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus,
    })

    // Mock fires SUBSCRIBED synchronously
    expect(onStatus).toHaveBeenCalledWith("connecting")
    expect(onStatus).toHaveBeenCalledWith("connected")
  })

  it("tracks status in getStatus()", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })

    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus: vi.fn(),
    })

    const status = manager.getStatus()
    expect(status.get("todos")).toBe("connected")
  })

  it("dispatches INSERT/UPDATE/DELETE events", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })
    const onInsert = vi.fn()
    const onUpdate = vi.fn()
    const onDelete = vi.fn()

    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      onInsert,
      onUpdate,
      onDelete,
      onStatus: vi.fn(),
    })

    const channel = supabase._channels[0]
    channel._fireEvent({ eventType: "INSERT", new: { id: 1, title: "A" } })
    channel._fireEvent({ eventType: "UPDATE", new: { id: 1, title: "B" } })
    channel._fireEvent({ eventType: "DELETE", old: { id: 1 } })

    expect(onInsert).toHaveBeenCalledWith({ id: 1, title: "A" })
    expect(onUpdate).toHaveBeenCalledWith({ id: 1, title: "B" })
    expect(onDelete).toHaveBeenCalledWith({ id: 1 })
  })

  it("unsubscribes and removes channel", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })
    const onStatus = vi.fn()

    const unsub = manager.subscribe({
      table: "todos",
      primaryKey: "id",
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus,
    })

    unsub()

    expect(supabase.removeChannel).toHaveBeenCalled()
    expect(onStatus).toHaveBeenCalledWith("disconnected")
    expect(manager.getStatus().size).toBe(0)
  })

  it("replaces subscription when subscribing to same table", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })

    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus: vi.fn(),
    })

    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus: vi.fn(),
    })

    // First channel should have been removed
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1)
    expect(manager.getStatus().size).toBe(1)
  })

  it("destroy() cleans up all subscriptions", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })

    manager.subscribe({ table: "a", primaryKey: "id", onInsert: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onStatus: vi.fn() })
    manager.subscribe({ table: "b", primaryKey: "id", onInsert: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onStatus: vi.fn() })

    manager.destroy()

    expect(supabase.removeChannel).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().size).toBe(0)
  })

  it("registers one distinct postgres_changes binding per requested event", () => {
    // realtime-js 2.112.2+ silently drops a second postgres_changes binding
    // that matches on (event, schema, table, filter, select). Anchor must
    // register one binding per distinct event value, never a repeated one,
    // or events would go missing without Anchor's code ever knowing.
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })

    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      events: ["INSERT", "UPDATE", "DELETE"],
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus: vi.fn(),
    })

    const channel = supabase._channels[0]
    expect(channel._listeners).toHaveLength(3)
    const events = channel._listeners.map((l: any) => l.filter.event)
    expect(new Set(events).size).toBe(3)
    expect(events.sort()).toEqual(["DELETE", "INSERT", "UPDATE"])
  })

  it("applies select as a server-side column projection", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })

    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      select: ["id", "title"],
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus: vi.fn(),
    })

    const channel = supabase._channels[0]
    expect(channel._listeners[0].filter.select).toEqual(["id", "title"])
  })

  it("throws if select omits the primary key", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })

    expect(() =>
      manager.subscribe({
        table: "todos",
        primaryKey: "id",
        select: ["title"],
        onInsert: vi.fn(),
        onUpdate: vi.fn(),
        onDelete: vi.fn(),
        onStatus: vi.fn(),
      }),
    ).toThrow(/primary key/)
  })

  it("converts a FilterDescriptor[] filter into a postgres_changes filter string", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })

    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      filter: [
        { column: "status", op: "eq", value: "open" },
        { column: "priority", op: "gt", value: 2 },
      ],
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus: vi.fn(),
    })

    const channel = supabase._channels[0]
    expect(channel._listeners[0].filter.filter).toBe("status=eq.open,priority=gt.2")
  })

  it("passes a string filter through unchanged", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })

    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      filter: "status=eq.open",
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus: vi.fn(),
    })

    const channel = supabase._channels[0]
    expect(channel._listeners[0].filter.filter).toBe("status=eq.open")
  })

  it("rejects a FilterDescriptor operator Realtime cannot evaluate", () => {
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })

    expect(() =>
      manager.subscribe({
        table: "todos",
        primaryKey: "id",
        filter: [{ column: "tags", op: "contains", value: ["a"] }],
        onInsert: vi.fn(),
        onUpdate: vi.fn(),
        onDelete: vi.fn(),
        onStatus: vi.fn(),
      }),
    ).toThrow(/not supported/)
  })

  it("does not map match to Realtime's regex match operator", () => {
    // Anchor's "match" is PostgREST multi-column equality; Realtime's "match"
    // is a POSIX regex operator. A hand-built { op: "match" } descriptor must
    // be rejected, not silently reinterpreted as a regex filter.
    const supabase = createMockSupabase()
    const manager = new RealtimeManager({ supabase })

    expect(() =>
      manager.subscribe({
        table: "todos",
        primaryKey: "id",
        filter: [{ column: "title", op: "match", value: "^foo" }],
        onInsert: vi.fn(),
        onUpdate: vi.fn(),
        onDelete: vi.fn(),
        onStatus: vi.fn(),
      }),
    ).toThrow(/not supported/)
  })
})

describe("RealtimeManager status mapping", () => {
  function subscribeOne(supabase: any, onStatus = vi.fn(), logger?: any) {
    const manager = new RealtimeManager({ supabase, logger })
    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus,
    })
    return { manager, onStatus, channel: supabase._channels[0] }
  }

  it("reports TIMED_OUT as an error, not as still connecting", () => {
    const { onStatus, channel } = subscribeOne(createMockSupabase())

    channel._fireStatus("TIMED_OUT")

    // No further status follows a timeout, so "connecting" was permanent.
    expect(onStatus).toHaveBeenLastCalledWith("error")
  })

  it("still reports a genuinely in-flight status as connecting", () => {
    // The paired positive: mapping everything to "error" would also satisfy the
    // assertion above.
    const { onStatus, channel } = subscribeOne(createMockSupabase())

    channel._fireStatus("JOINING")

    expect(onStatus).toHaveBeenLastCalledWith("connecting")
  })

  it("keeps CHANNEL_ERROR, CLOSED and SUBSCRIBED where they were", () => {
    const { onStatus, channel } = subscribeOne(createMockSupabase())

    channel._fireStatus("CHANNEL_ERROR")
    expect(onStatus).toHaveBeenLastCalledWith("error")
    channel._fireStatus("CLOSED")
    expect(onStatus).toHaveBeenLastCalledWith("disconnected")
    channel._fireStatus("SUBSCRIBED")
    expect(onStatus).toHaveBeenLastCalledWith("connected")
  })

  it("passes subscribe()'s err argument to the logger instead of dropping it", () => {
    const logger = { realtimeError: vi.fn(), realtimeEvent: vi.fn() }
    const { channel } = subscribeOne(createMockSupabase(), vi.fn(), logger)
    const err = new Error("channel refused")

    channel._fireStatus("CHANNEL_ERROR", err)

    expect(logger.realtimeError).toHaveBeenCalledWith("todos", "CHANNEL_ERROR", err)
  })

  it("does not log an error for a healthy status", () => {
    const logger = { realtimeError: vi.fn(), realtimeEvent: vi.fn() }
    const { channel } = subscribeOne(createMockSupabase(), vi.fn(), logger)

    channel._fireStatus("SUBSCRIBED")

    expect(logger.realtimeError).not.toHaveBeenCalled()
  })
})

describe("RealtimeManager pause and resume", () => {
  function subscribeOne(supabase: any) {
    const manager = new RealtimeManager({ supabase })
    const onStatus = vi.fn()
    manager.subscribe({
      table: "todos",
      primaryKey: "id",
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onStatus,
    })
    return { manager, onStatus }
  }

  it("resume() resubscribes what pause() tore down", () => {
    const supabase = createMockSupabase()
    const { manager, onStatus } = subscribeOne(supabase)
    expect(supabase._channels).toHaveLength(1)

    manager.pause()
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1)
    expect(manager.getStatus().get("todos")).toBe("disconnected")

    manager.resume()

    // A second channel was opened, and the table is connected again.
    expect(supabase._channels).toHaveLength(2)
    expect(manager.getStatus().get("todos")).toBe("connected")
    expect(onStatus).toHaveBeenLastCalledWith("connected")
  })

  it("tells the store it went away, so the UI can say so", () => {
    const supabase = createMockSupabase()
    const { manager, onStatus } = subscribeOne(supabase)

    manager.pause()

    // pause() used to change `sub.status` and notify nobody.
    expect(onStatus).toHaveBeenLastCalledWith("disconnected")
  })

  it("does not remove an already-paused channel a second time on destroy", () => {
    const supabase = createMockSupabase()
    const { manager } = subscribeOne(supabase)

    manager.pause()
    manager.destroy()

    // pause() left the entry in `subscriptions`, so destroy() — which the auth
    // gate fires on SIGNED_OUT — handed the same channel back twice.
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1)
  })

  it("is a no-op to pause twice", () => {
    const supabase = createMockSupabase()
    const { manager } = subscribeOne(supabase)

    manager.pause()
    manager.pause()

    expect(supabase.removeChannel).toHaveBeenCalledTimes(1)
  })

  it("resume() does nothing when nothing was paused", () => {
    const supabase = createMockSupabase()
    const { manager } = subscribeOne(supabase)

    manager.resume()

    expect(supabase._channels).toHaveLength(1)
    expect(supabase.removeChannel).not.toHaveBeenCalled()
  })
})
