import { afterEach, describe, expect, it, vi } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { createSupabaseStores } from "../createSupabaseStores.js"
import { ManualNetworkStatus } from "../network/onlineManager.js"
import { MemoryAdapter } from "../persistence/persistenceAdapter.js"
import { noopLogger,type QueuedMutation, type SyncLogger  } from "../types.js"
import { OfflineQueue } from "./offlineQueue.js"

/**
 * `offlineQueue.queueWrites` — a write that cannot reach the server is queued
 * rather than lost.
 *
 * Every test here fails against 2.2.0: `OfflineQueue.enqueue()` had no caller
 * anywhere in the package, so the queue hydrated, auto-flushed and held an
 * executor per table while every mutator went straight to Supabase and threw
 * when it could not be reached.
 *
 * Two things decide whether these tests prove anything.
 *
 * **The failure shape has to be the real one.** postgrest-js does not throw a
 * dead network: `PostgrestBuilder.then` catches it into the ordinary
 * `{ data, error }` pair with `status: 0` and `code: ""` (`dist/index.cjs:328`
 * on 2.108.2, `:394` on 2.112.3). A test that simulated an offline write by
 * rejecting the promise would exercise a path that cannot happen, and would
 * pass against an implementation that queued nothing in production.
 *
 * **And the refusals have to be here too.** Queuing a write the server has
 * actively refused means retrying it forever and telling the caller it was
 * sent, so `42501` and `23505` are asserted to still roll back and throw. That
 * boundary, not the queuing, is the part worth guarding.
 */

type Todo = { done?: boolean; id: number | string; title: string; }

const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) {cleanups.pop()!()}

  vi.restoreAllMocks()
})

function makeStores(
  options: {
    adapter?: MemoryAdapter
    logger?: SyncLogger
    maxRetries?: number
    queueWrites?: boolean
    rows?: Todo[]
  } = {},
) {
  const supabase = createMockSupabase({ todos: (options.rows ?? []) as any[] })
  const network = new ManualNetworkStatus()

  // The store exposes `getQueueSize()` but not the mutations themselves, and
  // the ordering assertions need `dependsOn` and `upsertOptions`. Spying on
  // `enqueue` reads what was actually handed to the queue, and calls through.
  const enqueued = vi.spyOn(OfflineQueue.prototype, "enqueue")
  const stores = createSupabaseStores<any>({
    fetchRemoteOnBoot: false,
    logger: options.logger,
    network,

    offlineQueue: {
      // The queue debounces its own flush and would otherwise fire a real
      // timer after the test had finished. Every test below flushes explicitly.
      flushDebounceMs: 1_000_000,
      maxRetries: options.maxRetries,
      queueWrites: options.queueWrites ?? true,
    },

    persistence: options.adapter ? { adapter: options.adapter } : undefined,
    supabase,
    tables: ["todos"],
  })

  cleanups.push(() => stores._destroy())

  return {
    network,
    queued: () => enqueued.mock.calls.map((c) => c[0]),
    stores,
    supabase,
    todos: stores.todos,
  }
}

/**
 * A builder that answers with one canned PostgREST response.
 *
 * Every method returns itself, so it satisfies whichever chain the mutator
 * builds (`insert().select().single()`, `update().eq().select().single()`,
 * `delete().eq()`), and `then` makes the chain awaitable.
 */
function stubBuilder(result: unknown) {
  const b: Record<string, unknown> = {}

  for (const method of [
    "insert", "update", "upsert", "delete", "select", "eq", "single",
    "maybeSingle", "order", "limit", "range",
  ]) {
    b[method] = () => b
  }

  b.then = async (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    await Promise.resolve(result).catch(reject).then(resolve)

  return b
}

/** Exactly what postgrest-js returns when the request never reached a server. */
const TRANSPORT_FAILURE = {
  count: null,
  data: null,

  error: {
    code: "",
    details: "",
    hint: "",
    message: "TypeError: Network request failed",
  },

  status: 0,
  statusText: "",
}

/** …and what it returns when Postgres answered, refusing. */
function refusal(code: string, status = 403) {
  return {
    count: null,
    data: null,
    error: { code, details: "", hint: "", message: `denied (${code})` },
    status,
    statusText: "Forbidden",
  }
}

describe("offline writes are queued, not lost", () => {
  it("queues an insert made while the network adapter reports offline", async () => {
    const { network, supabase, todos } = makeStores()

    network.setOnline(false)

    const fromSpy = vi.spyOn(supabase, "from")
    const row = await todos.getState().insert({ title: "A" } as any)

    // Never attempted: the pre-check is what makes an offline write cheap
    // rather than a round trip that has to time out first.
    expect(fromSpy).not.toHaveBeenCalled()
    expect(todos.getState().getQueueSize()).toBe(1)

    // The promise resolving is NOT what says the write was sent. A caller that
    // treats a non-null result as success — which is the shape that shipped a
    // "your symptoms were sent" message for an unsent check-in — needs this
    // flag to tell the two apart, so the returned row has to carry it.
    expect((row as any)._anchor_pending).toBe("insert")
    expect(todos.getState().records.size).toBe(1)
  })

  it("confirms the row against the server once the network comes back", async () => {
    const { network, supabase, todos } = makeStores()

    network.setOnline(false)
    await todos.getState().insert({ title: "A" } as any)

    network.setOnline(true)
    await todos.getState().flushQueue()

    expect(todos.getState().getQueueSize()).toBe(0)

    const rows = Array.from(todos.getState().records.values())

    expect(rows).toHaveLength(1)
    expect((rows[0] as any)._anchor_pending).toBeUndefined()
    expect((rows[0] as any).title).toBe("A")

    // And it reached the table, rather than only looking settled locally.
    expect((supabase)._tables.todos).toHaveLength(1)

    // The temp id was swapped for the server's, in both halves of the store.
    const { order, records } = todos.getState()

    expect(order).toHaveLength(1)
    expect(records.has(order[0]!)).toBe(true)
    expect(String(order[0])).not.toContain("_temp:")
  })

  it("queues a write that dies in transit after it was already sent", async () => {
    // The common mobile case: online when the write starts, gone by the time
    // it would have arrived. The `isOnline()` pre-check cannot see this one.
    const { supabase, todos } = makeStores()

    vi.spyOn(supabase, "from").mockImplementationOnce(
      () => stubBuilder(TRANSPORT_FAILURE) as any,
    )

    const row = await todos.getState().insert({ title: "A" } as any)

    expect((row as any)._anchor_pending).toBe("insert")
    expect(todos.getState().getQueueSize()).toBe(1)
    expect(todos.getState().records.size).toBe(1)
  })

  it.each([
    ["42501", "an RLS policy refusal"],
    ["23505", "a unique violation"],
    ["23503", "a foreign key violation"],
  ])("rolls back and throws on %s (%s) instead of queuing it", async (code) => {
    const { supabase, todos } = makeStores()

    vi.spyOn(supabase, "from").mockImplementationOnce(
      () => stubBuilder(refusal(code)) as any,
    )

    await expect(
      todos.getState().insert({ title: "A" } as any),
    ).rejects.toThrow()

    // A refusal queued is a refusal retried forever, and reported as sent.
    expect(todos.getState().getQueueSize()).toBe(0)
    expect(todos.getState().records.size).toBe(0)
    expect((todos.getState().error as any)?.code).toBe(code)
  })

  it("still rolls back and throws when queueWrites is off", async () => {
    // The default, and the whole reason the option exists: turning the queue on
    // changes what a failed write does, so a consumer that did not ask for it
    // must see the behaviour it has always had.
    const { network, supabase, todos } = makeStores({ queueWrites: false })

    network.setOnline(false)

    vi.spyOn(supabase, "from").mockImplementationOnce(
      () => stubBuilder(TRANSPORT_FAILURE) as any,
    )

    await expect(
      todos.getState().insert({ title: "A" } as any),
    ).rejects.toThrow(/Network request failed/v)
    expect(todos.getState().getQueueSize()).toBe(0)
    expect(todos.getState().records.size).toBe(0)
  })

  it("queues nothing while the write succeeds", async () => {
    // The positive counterpart: the flag must not send every write to the queue.
    const { todos } = makeStores()

    const row = await todos.getState().insert({ title: "A" } as any)

    expect(todos.getState().getQueueSize()).toBe(0)
    expect((row as any)._anchor_pending).toBeUndefined()
  })

  it("tells the logger a write was queued", async () => {
    const mutationQueued = vi.fn()
    const { network, todos } = makeStores({
      logger: { ...noopLogger, mutationQueued },
    })

    network.setOnline(false)

    await todos.getState().insert({ title: "A" } as any)

    expect(mutationQueued).toHaveBeenCalledWith("todos", "INSERT")
  })
})

describe("what a queued write leaves behind", () => {
  it("persists the optimistic row, not only confirmed ones", async () => {
    // Persisting on success alone would leave the queue holding a mutation for
    // a row the store no longer has: the entry disappears on relaunch and comes
    // back when the drain lands, which reads as data loss followed by a ghost.
    const adapter = new MemoryAdapter()
    const { network, todos } = makeStores({ adapter })

    network.setOnline(false)

    await todos.getState().insert({ title: "A" } as any)
    await vi.waitFor(async () => {
      const stored = await adapter.getItem<Todo[]>("anchor:public:todos")

      expect(stored).toHaveLength(1)
    })
  })

  it("drains a write queued by a previous session", async () => {
    const adapter = new MemoryAdapter()
    const first = makeStores({ adapter })

    first.network.setOnline(false)
    await first.todos.getState().insert({ title: "A" } as any)
    first.stores._destroy()

    // A second factory over the same storage — the relaunch.
    const second = makeStores({ adapter })

    await vi.waitFor(() => {
      expect(second.todos.getState().getQueueSize()).toBe(1)
    })

    await second.todos.getState().flushQueue()
    expect(second.todos.getState().getQueueSize()).toBe(0)
    expect((second.supabase)._tables.todos).toHaveLength(1)
  })

  it("removes an optimistic row the server never accepted", async () => {
    // `OfflineQueue` marks a mutation rolled_back past `maxRetries` and prunes
    // it. Before `onRollback` was wired, that left the row on screen, still
    // flagged pending, for a write that had been abandoned.
    const { network, supabase, todos } = makeStores({ maxRetries: 0 })

    network.setOnline(false)
    await todos.getState().insert({ title: "A" } as any)
    expect(todos.getState().records.size).toBe(1)

    network.setOnline(true)
    vi.spyOn(supabase, "from").mockImplementation(
      () => stubBuilder(refusal("42501")) as any,
    )
    await todos.getState().flushQueue()

    expect(todos.getState().getQueueSize()).toBe(0)
    expect(todos.getState().records.size).toBe(0)
    expect(todos.getState().order).toHaveLength(0)
  })

  it("puts the previous values back when a queued update is abandoned", async () => {
    const { network, supabase, todos } = makeStores({
      maxRetries: 0,
      rows: [{ id: 1, title: "Original" }],
    })

    await todos.getState().fetch()

    network.setOnline(false)
    await todos.getState().update(1, { title: "Edited" } as any)
    expect((todos.getState().records.get(1) as any).title).toBe("Edited")

    network.setOnline(true)
    vi.spyOn(supabase, "from").mockImplementation(
      () => stubBuilder(refusal("42501")) as any,
    )
    await todos.getState().flushQueue()

    const restored = todos.getState().records.get(1) as any

    expect(restored.title).toBe("Original")
    expect(restored._anchor_pending).toBeUndefined()
  })
})

describe("ordering and the mutators that stay out", () => {
  it("chains two writes to one row so the drain replays them in order", async () => {
    const { network, queued, todos } = makeStores({ rows: [{ id: 1, title: "A" }] })

    await todos.getState().fetch()
    network.setOnline(false)

    await todos.getState().update(1, { title: "B" } as any)
    await todos.getState().update(1, { title: "C" } as any)

    const queue = queued()

    expect(queue).toHaveLength(2)
    expect(queue[1]!.dependsOn).toBe(queue[0]!.id)

    network.setOnline(true)
    await todos.getState().flushQueue()
    expect((todos.getState().records.get(1) as any).title).toBe("C")
  })

  it("chains two upserts that resolve to the same row through onConflict", async () => {
    // A2.1's local conflict lookup is what makes this work: without it the two
    // upserts would take separate temp ids, `primaryKey` would differ, and the
    // queue would have nothing to relate them by.
    const { network, queued, todos } = makeStores({
      rows: [{ done: false, id: 1, title: "A" }],
    })

    await todos.getState().fetch()
    network.setOnline(false)

    await todos.getState().upsert({ done: true, title: "A" } as any, {
      onConflict: "title",
    })
    await todos.getState().upsert({ done: false, title: "A" } as any, {
      onConflict: "title",
    })

    const queue = queued()

    expect(queue).toHaveLength(2)
    expect(queue[0]!.primaryKey).toEqual(queue[1]!.primaryKey)
    expect(queue[1]!.dependsOn).toBe(queue[0]!.id)

    // And the conflict target rides along, or the drain writes a different row.
    expect(queue[0]!.upsertOptions).toEqual({ onConflict: "title" })
  })

  it("queues a delete and keeps the row gone locally in the meantime", async () => {
    const { network, supabase, todos } = makeStores({
      rows: [{ id: 1, title: "A" }],
    })

    await todos.getState().fetch()
    network.setOnline(false)

    await todos.getState().remove(1)

    // No pending tombstone to render: `remove` drops the row from `records` and
    // `order` outright, so there is nothing for `selectQueryRows` to filter.
    expect(todos.getState().records.has(1)).toBe(false)
    expect(todos.getState().order).not.toContain(1)
    expect(todos.getState().getQueueSize()).toBe(1)

    network.setOnline(true)
    await todos.getState().flushQueue()
    expect((supabase)._tables.todos).toHaveLength(0)
  })

  it("does not queue insertMany — it rolls back and throws", async () => {
    // Deliberate: `QueuedMutation` addresses one row, so a batch would enter
    // the queue as N independent inserts and a drain could half-succeed.
    //
    // Driven through a transport failure rather than `setOnline(false)`,
    // because these two have no pre-check — they go to the network whatever the
    // adapter says, and the failure is what they have to handle.
    const { supabase, todos } = makeStores()

    vi.spyOn(supabase, "from").mockImplementationOnce(
      () => stubBuilder(TRANSPORT_FAILURE) as any,
    )

    await expect(
      todos.getState().insertMany([{ title: "A" }, { title: "B" }] as any),
    ).rejects.toThrow()
    expect(todos.getState().getQueueSize()).toBe(0)
    expect(todos.getState().records.size).toBe(0)
  })

  it("does not queue removeWhere either", async () => {
    // Its local matcher assumes a match for every operator beyond eq/neq, which
    // is safe for an optimistic hide and unsafe as the basis of a replay.
    const { supabase, todos } = makeStores({ rows: [{ id: 1, title: "A" }] })

    await todos.getState().fetch()
    vi.spyOn(supabase, "from").mockImplementationOnce(
      () => stubBuilder(TRANSPORT_FAILURE) as any,
    )

    await expect(
      todos.getState().removeWhere([{ column: "title", op: "eq", value: "A" }] as any),
    ).rejects.toThrow()
    expect(todos.getState().getQueueSize()).toBe(0)

    // Rolled back, so the row is still there.
    expect(todos.getState().records.has(1)).toBe(true)
  })
})


/**
 * The second review pass. Every case here is a way the queue could report a
 * write as done, or undo one it had no business undoing, and none of them is
 * reachable until `queueWrites` gives the queue a producer.
 */
describe("a queued write cannot be overtaken or wrongly undone", () => {
  it("keeps queuing while the row has a write in flight, even back online", async () => {
    // The queue flushes on a debounce. A direct write in that window reaches
    // Postgres first and is then overwritten by the older queued payload, so
    // the edit the user had already replaced wins — on the server as well as
    // on screen.
    const { network, queued, supabase, todos } = makeStores({
      rows: [{ id: 1, title: "A" }],
    })

    await todos.getState().fetch()

    network.setOnline(false)
    await todos.getState().update(1, { title: "B" } as any)

    network.setOnline(true)
    await todos.getState().update(1, { title: "C" } as any)

    expect(queued()).toHaveLength(2)

    await todos.getState().flushQueue()
    expect((todos.getState().records.get(1) as any).title).toBe("C")
    expect((supabase)._tables.todos[0].title).toBe("C")
  })

  it("leaves a server-confirmed row alone when an abandoned write rolls back", async () => {
    const { network, supabase, todos } = makeStores({
      maxRetries: 0,
      rows: [{ id: 1, title: "A" }],
    })

    await todos.getState().fetch()

    network.setOnline(false)
    await todos.getState().update(1, { title: "B" } as any)

    // Something confirmed arrives at that id before the queue gives up — a
    // realtime event, a refetch, a cross-tab merge.
    todos.getState().setRecord(1, { id: 1, title: "from the server" } as any)

    network.setOnline(true)
    vi.spyOn(supabase, "from").mockImplementation(
      () => stubBuilder(refusal("42501")) as any,
    )
    await todos.getState().flushQueue()

    // Not reverted to "A": that row is the server's answer, not ours to undo.
    expect((todos.getState().records.get(1) as any).title).toBe("from the server")
  })

  it("does not delete a row it never created when an abandoned insert rolls back", async () => {
    const { network, supabase, todos } = makeStores({ maxRetries: 0 })

    network.setOnline(false)

    const optimistic = await todos.getState().insert({ title: "A" } as any)
    const tempId = (optimistic as any).id

    // The same id now holds something confirmed.
    todos.getState().setRecord(tempId, { id: tempId, title: "confirmed" } as any)

    network.setOnline(true)
    vi.spyOn(supabase, "from").mockImplementation(
      () => stubBuilder(refusal("42501")) as any,
    )
    await todos.getState().flushQueue()

    expect(todos.getState().records.get(tempId)).toBeDefined()
  })

  it("restores the last clean row, not an intermediate optimistic one", async () => {
    // Two queued writes to one row: the second's "before" is the first's
    // optimistic value. Snapshotting that would make the rollback restore a row
    // still flagged pending, with intermediate values, and nothing left in the
    // queue that could ever clear the flag.
    const { network, supabase, todos } = makeStores({
      maxRetries: 0,
      rows: [{ done: false, id: 1, title: "clean" }],
    })

    await todos.getState().fetch()

    network.setOnline(false)
    await todos.getState().update(1, { title: "first" } as any)
    await todos.getState().update(1, { title: "second" } as any)

    network.setOnline(true)
    vi.spyOn(supabase, "from").mockImplementation(
      () => stubBuilder(refusal("42501")) as any,
    )
    await todos.getState().flushQueue()

    const row = todos.getState().records.get(1) as any

    expect(row.title).toBe("clean")
    expect(row._anchor_pending).toBeUndefined()
    expect(row._anchor_optimistic).toBeUndefined()
  })

  it("says out loud that a write was abandoned", async () => {
    // Nothing else reports it, and `remove()` returns void — so without this a
    // deleted row simply reappears in the list some minutes later.
    const mutationError = vi.fn()
    const { network, supabase, todos } = makeStores({
      logger: { ...noopLogger, mutationError },
      maxRetries: 0,
      rows: [{ id: 1, title: "A" }],
    })

    await todos.getState().fetch()

    network.setOnline(false)
    await todos.getState().remove(1)

    network.setOnline(true)
    vi.spyOn(supabase, "from").mockImplementation(
      () => stubBuilder(refusal("42501")) as any,
    )
    mutationError.mockClear()
    await todos.getState().flushQueue()

    expect(mutationError).toHaveBeenCalledWith(
      "todos",
      "DELETE",
      expect.stringContaining("Abandoned"),
    )

    // …and the row is back, because the delete never happened.
    expect(todos.getState().records.has(1)).toBe(true)
  })

  it("resolves the temp id an onConflict upsert minted, for the writes behind it", async () => {
    // An upsert identified by a constraint carries no primary key, so the store
    // mints a temp id exactly as `insert` does. The queue used to register
    // temp-id resolutions for INSERT only, which left every later queued write
    // to that row replaying `.eq(id, '_temp:…')` forever.
    const { network, supabase, todos } = makeStores()

    network.setOnline(false)

    const row = await todos.getState().upsert(
      { done: false, title: "A" } as any,
      { onConflict: "title" },
    )
    const tempId = (row as any).id

    expect(String(tempId)).toContain("_temp:")

    await todos.getState().update(tempId, { done: true } as any)

    network.setOnline(true)
    await todos.getState().flushQueue()

    expect(todos.getState().getQueueSize()).toBe(0)

    const server = (supabase)._tables.todos

    expect(server).toHaveLength(1)
    expect(server[0].done).toBe(true)

    // And the store no longer holds the temp id.
    expect(todos.getState().order.some((id: any) => String(id).includes("_temp:"))).toBe(false)
  })

  it("refuses to queue an update to a row it does not hold", async () => {
    // There is nothing to show as pending, nothing to roll back to, and nothing
    // to return but a row assembled from the caller's own payload — missing
    // every column it did not write, absent from `records`, and invisible to
    // `isPending` and every projection.
    const { network, todos } = makeStores()

    network.setOnline(false)

    await expect(
      todos.getState().update(99, { title: "X" } as any),
    ).rejects.toThrow(/does not hold it/v)
    expect(todos.getState().getQueueSize()).toBe(0)
  })

  it("puts a drained update's row in `order`, not only in `records`", async () => {
    // `records` and `order` staying in step is the invariant every projection
    // rests on: a row in one and not the other is held and unreachable.
    const { network, supabase, todos } = makeStores({ rows: [{ id: 1, title: "A" }] })

    await todos.getState().fetch()
    network.setOnline(false)
    await todos.getState().update(1, { title: "B" } as any)

    network.setOnline(true)
    await todos.getState().flushQueue()

    const { order, records } = todos.getState()

    expect(order).toEqual([1])
    expect(order.length).toBe(records.size)
    expect((supabase)._tables.todos[0].title).toBe("B")
  })
})

/**
 * Two cases the obvious version of the tests above misses. Both were found by
 * reverting a fix and watching the suite stay green.
 */
describe("chains that create a row, and rows that leave the store", () => {
  it("does not resurrect a pending row when a chain that created one is abandoned", async () => {
    // Both writes create the same new row, so the FIRST has no snapshot at all
    // and its rollback is a removal. If the second had snapshotted the row it
    // found — the first's optimistic value — its own rollback would then put
    // that row back, flagged pending, with an empty queue behind it and nothing
    // that could ever clear the flag.
    const { network, supabase, todos } = makeStores({ maxRetries: 0 })

    network.setOnline(false)

    await todos.getState().upsert({ done: false, title: "A" } as any, {
      onConflict: "title",
    })
    await todos.getState().upsert({ done: true, title: "A" } as any, {
      onConflict: "title",
    })

    network.setOnline(true)
    vi.spyOn(supabase, "from").mockImplementation(
      () => stubBuilder(refusal("42501")) as any,
    )
    await todos.getState().flushQueue()

    expect(todos.getState().records.size).toBe(0)
    expect(todos.getState().order).toHaveLength(0)
    expect(todos.getState().getQueueSize()).toBe(0)
  })

  it("drains a queue read off disk with nothing else to trigger it", async () => {
    // The boot race. `hydrate()` reading storage and supabase-js recovering a
    // stored session are both in flight from the factory, in an order native
    // and web do not agree on, and whichever finishes second is the one that
    // has to start the drain. `startAutoFlush` only *subscribes* to
    // connectivity, so a device that never leaves wifi offers no transition to
    // ride on.
    //
    // This is load-bearing only since a tagged mutation began waiting for its
    // own user: before that, an unauthenticated flush from any source would
    // have drained the queue anyway. A test that stubs the queue dirty before
    // the auth event cannot see it, because here the queue becomes dirty after.
    //
    // The mutation therefore carries a `userId`, and the session is recovered
    // before the stores are built. An untagged one passes the flush filter
    // whatever the current user is, which is not the shape any authenticated
    // consumer produces — every mutation enqueued while somebody is signed in
    // is tagged. It also pins the order the fix depends on: the gate's
    // synchronous INITIAL_SESSION sets the user before `hydrate()` resolves, so
    // the flush this schedules is one the filter will let through.
    const supabase = createMockSupabase({ todos: [{ id: 1, title: "A" }] })

    await supabase.auth.signInWithPassword({ email: "a@b.c", password: "x" })

    const adapter = new MemoryAdapter()

    await adapter.setItem("anchor:__mutation_queue", [
      {
        createdAt: 1,
        id: "m1",
        operation: "UPDATE",
        payload: { title: "from the previous run" },
        primaryKey: { id: 1 },
        retryCount: 0,
        rollbackSnapshot: null,
        status: "pending",
        table: "todos",
        userId: "user-1",
      } as unknown as QueuedMutation,
    ])

    const stores = createSupabaseStores<any>({
      fetchRemoteOnBoot: false,
      network: new ManualNetworkStatus(),
      offlineQueue: { flushDebounceMs: 1, queueWrites: true },
      persistence: { adapter },
      supabase,
      tables: ["todos"],
    })

    cleanups.push(() => stores._destroy())

    await vi.waitFor(() =>
      expect((supabase)._tables.todos[0].title).toBe("from the previous run"),
    )
  })

  it("does not put a cleared row back when an abandoned update rolls back", async () => {
    // The undo of an optimistic apply that is no longer there is nothing, not a
    // re-insert. `setRecord` adds the id to `records` AND `order` and persists
    // it, so restoring the snapshot here would return a previous user's row to
    // the screen and to disk minutes after sign-out took it off both — and a
    // `merge` cache would then keep it through the next user's fetch.
    //
    // "says out loud that a write was abandoned", above, is why this cannot be
    // a bare `if (!current) return`: for a DELETE an absent row is the
    // optimistic state, and putting the snapshot back IS the undo. The guard
    // has to read the operation.
    const { network, supabase, todos } = makeStores({
      maxRetries: 0,
      rows: [{ id: 1, title: "A" }],
    })

    await todos.getState().fetch()
    network.setOnline(false)
    await todos.getState().update(1, { title: "B" } as any)

    todos.getState().clearAll()

    network.setOnline(true)
    vi.spyOn(supabase, "from").mockImplementation(
      () => stubBuilder(refusal("42501")) as any,
    )
    await todos.getState().flushQueue()

    expect(todos.getState().records.size).toBe(0)
    expect(todos.getState().order).toHaveLength(0)
  })

  it("keeps a drained row reachable when the store was cleared under it", async () => {
    // Sign-out clears the stores and — since 2.2.0 — no longer clears the
    // queue, so a queued write can outlive the rows it was made against. The
    // replay then writes a row into `records` whose id `order` has never seen,
    // and every projection reads `order`: held, and invisible.
    const { network, supabase, todos } = makeStores({ rows: [{ id: 1, title: "A" }] })

    await todos.getState().fetch()
    network.setOnline(false)
    await todos.getState().update(1, { title: "B" } as any)

    todos.getState().clearAll()
    expect(todos.getState().records.size).toBe(0)

    network.setOnline(true)
    await todos.getState().flushQueue()

    const { order, records } = todos.getState()

    expect(records.size).toBe(1)
    expect(order).toEqual([1])
    expect((supabase)._tables.todos[0].title).toBe("B")
  })
})
