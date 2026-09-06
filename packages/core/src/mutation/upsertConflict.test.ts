import { describe, expect, it, vi } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { createTableStore } from "../createTableStore.js"
import type { QueuedMutation } from "../types.js"
import { createMutationExecutor,executeRemoteMutation } from "./mutationPipeline.js"

/**
 * `upsert`'s conflict target.
 *
 * Without one, PostgREST conflicts on the primary key, so a table whose
 * "one per day" rule lives in a different unique constraint cannot be upserted
 * through a store at all — the second write inserts a duplicate here and raises
 * `23505` against a real Postgres. Every test below fails against 2.1.0.
 *
 * The check-in table this was written for is
 * `daily_check_ins (id uuid primary key, unique (journey_id, date))`, written
 * with neither `id` nor `date` in the payload, so the fixtures mirror that
 * shape rather than a tidier one.
 */

type CheckIn = {
  date: string
  id: string
  journey_id: string
  pain: number
}

/** `order` and `records` agreeing is the invariant the whole store rests on. */
function expectOrderIntegrity(store: ReturnType<typeof makeStore>["store"]) {
  const { order, records } = store.getState()

  expect(new Set(order).size).toBe(order.length)
  expect(order.length).toBe(records.size)

  for (const id of order) {expect(records.has(id)).toBe(true)}
}

function makeStore(rows: CheckIn[]) {
  const supabase = createMockSupabase({ daily_check_ins: rows })
  const store = createTableStore<any, CheckIn, any, any>({
    primaryKey: "id",
    supabase,
    table: "daily_check_ins",
  })

  return { store, supabase }
}

/**
 * A store that has actually read its table, which is the state every screen is
 * in by the time a user writes.
 *
 * The first version of these tests upserted into an *empty* store, and that is
 * precisely the one case where a duplicated `order` entry cannot appear — so a
 * confirmed defect shipped with a green assertion (`order` equalling a
 * one-element array) that looked like it guarded exactly that.
 */
async function seededStore(rows: CheckIn[]) {
  const made = makeStore(rows)

  await made.store.getState().fetch()

  return made
}

describe("upsert with onConflict", () => {
  it("replaces the row matching the named constraint, not the primary key", async () => {
    const { store } = makeStore([
      { date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 },
    ])

    await store.getState().upsert(
      { date: "2026-08-12", journey_id: "j1", pain: 7 } as any,
      { onConflict: "journey_id,date" },
    )

    const rows = Array.from(store.getState().records.values())

    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe("c1")
    expect(rows[0]!.pain).toBe(7)
  })

  it("inserts when nothing matches the constraint", async () => {
    const { store, supabase } = makeStore([
      { date: "2026-08-11", id: "c1", journey_id: "j1", pain: 3 },
    ])

    await store.getState().upsert(
      { date: "2026-08-12", journey_id: "j1", pain: 5 } as any,
      { onConflict: "journey_id,date" },
    )

    const stored = (supabase)._tables.daily_check_ins as CheckIn[]

    expect(stored.map((r) => r.date).sort()).toEqual(["2026-08-11", "2026-08-12"])

    // The store holds only the row it wrote — it never fetched the other one.
    expect(Array.from(store.getState().records.values())).toHaveLength(1)
  })

  it("duplicates without the option, which is the bug it exists to fix", async () => {
    const { store, supabase } = makeStore([
      { date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 },
    ])

    // No onConflict: the conflict target is `id`, the payload carries none, so
    // this inserts a second row for a day that already has one. Against a real
    // Postgres the unique constraint turns that into `23505`.
    //
    // Asserted on the table, not on `records` — the store never fetched, so it
    // holds only what this call wrote either way, which would make the
    // assertion pass for both behaviours.
    await store.getState().upsert({ date: "2026-08-12", journey_id: "j1", pain: 7 } as any)

    expect((supabase)._tables.daily_check_ins).toHaveLength(2)
  })

  it("forwards the option to the builder as its second argument", async () => {
    const { store, supabase } = makeStore([])
    const seen: unknown[] = []

    // Wrap the real builder rather than replacing it, so the write still lands
    // and the assertion is about the argument, not about a stub's shape. An
    // assertion that the builder merely exists passes against a version that
    // forwards nothing, which is the whole failure mode being guarded.
    const realFrom = supabase.from.bind(supabase)

    vi.spyOn(supabase, "from").mockImplementation((name: string) => {
      const builder = realFrom(name)
      const realUpsert = builder.upsert.bind(builder)

      builder.upsert = (row: unknown, options?: unknown) => {
        seen.push(options)

        return realUpsert(row as any, options as any)
      }

      return builder
    })

    await store.getState().upsert(
      { date: "2026-08-12", journey_id: "j1", pain: 1 } as any,
      { onConflict: "journey_id,date" },
    )

    expect(seen).toEqual([{ onConflict: "journey_id,date" }])
    vi.restoreAllMocks()
  })

  it("passes nothing when the caller passed nothing", async () => {
    // The positive assertion's counterpart: an implementation that always sent
    // an options object would satisfy the test above and change the conflict
    // target of every plain upsert in the package.
    const { store, supabase } = makeStore([])
    const seen: unknown[] = []

    const realFrom = supabase.from.bind(supabase)

    vi.spyOn(supabase, "from").mockImplementation((name: string) => {
      const builder = realFrom(name)
      const realUpsert = builder.upsert.bind(builder)

      builder.upsert = (row: unknown, options?: unknown) => {
        seen.push(options)

        return realUpsert(row as any, options as any)
      }

      return builder
    })

    await store.getState().upsert({ date: "2026-08-12", journey_id: "j1", pain: 1 } as any)

    expect(seen).toEqual([undefined])
    vi.restoreAllMocks()
  })

  it("does not conflict on a null column, because Postgres does not either", async () => {
    // NULLS DISTINCT is the default, so two nulls never conflict. A mock that
    // matched them would let this assert "replaces" and pass, while the real
    // database inserted a second row.
    const { store, supabase } = await seededStore([
      { date: null as any, id: "c1", journey_id: "j1", pain: 3 },
    ])

    await store.getState().upsert(
      { date: null, journey_id: "j1", pain: 9 } as any,
      { onConflict: "journey_id,date" },
    )

    expect((supabase)._tables.daily_check_ins).toHaveLength(2)
    expectOrderIntegrity(store)
  })
})

describe("a store that has already read its table", () => {
  it("updates the row the constraint targets instead of adding a second", async () => {
    const { store } = await seededStore([
      { date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 },
    ])

    await store.getState().upsert(
      { date: "2026-08-12", journey_id: "j1", pain: 7 } as any,
      { onConflict: "journey_id,date" },
    )

    // One row, one `order` slot. Before the conflict-column lookup this held a
    // temp id alongside `c1`, and the confirmation aliased the slot so `order`
    // ended up `["c1", "c1"]` — every list rendering the same check-in twice,
    // with duplicate React keys, until the next full fetch.
    expect(Array.from(store.getState().records.values())).toHaveLength(1)
    expect(store.getState().order).toEqual(["c1"])
    expectOrderIntegrity(store)
  })

  it("shows one row, not two, while the write is in flight", async () => {
    const { store } = await seededStore([
      { date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 },
    ])

    const promise = store.getState().upsert(
      { date: "2026-08-12", journey_id: "j1", pain: 7 } as any,
      { onConflict: "journey_id,date" },
    )

    // The transient state is the one a user on a slow connection actually
    // reads, and it used to list today's check-in twice with two pain values.
    const inFlight = Array.from(store.getState().records.values())

    expect(inFlight).toHaveLength(1)
    expect(inFlight[0]!.pain).toBe(7)
    expect((inFlight[0] as any)._anchor_pending).toBe("update")
    expectOrderIntegrity(store)

    await promise
    expectOrderIntegrity(store)
  })

  it("keeps the columns the payload did not mention", async () => {
    // An upsert payload carries only what the caller is writing. Substituting
    // it for the stored row would blank everything else until the server
    // answered — a check-in briefly losing its oedema and mobility readings.
    const { store } = await seededStore([
      { date: "2026-08-12", id: "c1", journey_id: "j1", oedema: 2, pain: 3 } as any,
    ])

    const promise = store
      .getState()
      .upsert({ date: "2026-08-12", journey_id: "j1", pain: 7 } as any, {
        onConflict: "journey_id,date",
      })

    expect((Array.from(store.getState().records.values())[0] as any).oedema).toBe(2)
    await promise
  })

  it("restores the row it overwrote when the write is refused", async () => {
    const { store, supabase } = await seededStore([
      { date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 },
    ])

    const realFrom = supabase.from.bind(supabase)

    vi.spyOn(supabase, "from").mockImplementation((name: string) => {
      const builder = realFrom(name)

      builder.upsert = () => ({
        select: () => ({
          single: async () => ({
            data: null,
            error: { code: "42501", message: "denied" },
          }),
        }),
      })

      return builder
    })

    await expect(
      store.getState().upsert({ date: "2026-08-12", journey_id: "j1", pain: 7 } as any, {
        onConflict: "journey_id,date",
      }),
    ).rejects.toThrow()

    // CAS rollback puts the snapshot back rather than deleting the row, which
    // is the difference between "your edit did not save" and "your check-in
    // disappeared".
    const rows = Array.from(store.getState().records.values())

    expect(rows).toHaveLength(1)
    expect(rows[0]!.pain).toBe(3)
    expect((rows[0] as any)._anchor_pending).toBeUndefined()
    expectOrderIntegrity(store)
    vi.restoreAllMocks()
  })
})

describe("upsert optimistic apply without a primary key", () => {
  it("shows the row immediately under a temp id, then adopts the server's", async () => {
    const { store } = makeStore([])

    const promise = store
      .getState()
      .upsert({ date: "2026-08-12", journey_id: "j1", pain: 4 } as any, {
        onConflict: "journey_id,date",
      })

    // Before the server answers, the screen already has a row. This is the
    // whole point of an optimistic write, and it used to be skipped entirely
    // whenever the payload carried no id.
    const pendingRows = Array.from(store.getState().records.values())

    expect(pendingRows).toHaveLength(1)
    expect((pendingRows[0] as any)._anchor_pending).toBe("update")

    await promise

    const settled = Array.from(store.getState().records.values())

    expect(settled).toHaveLength(1)
    expect((settled[0] as any)._anchor_pending).toBeUndefined()

    // The temp id is gone — `order` and `records` agree on the server's.
    expect(store.getState().order).toEqual([settled[0]!.id])
  })

  it("never sends the temp id to the server", async () => {
    const { store, supabase } = makeStore([])

    await store.getState().upsert(
      { date: "2026-08-12", journey_id: "j1", pain: 4 } as any,
      { onConflict: "journey_id,date" },
    )

    // A temp id reaching the database is a malformed uuid, not a row.
    const stored = (supabase)._tables.daily_check_ins as CheckIn[]

    expect(stored).toHaveLength(1)
    expect(String(stored[0]!.id)).not.toContain("_temp:")
  })
})

describe("upsert with ignoreDuplicates", () => {
  it("resolves the row rather than throwing PGRST116 when the conflict already exists", async () => {
    const { store } = await seededStore([
      { date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 },
    ])

    const resolved = await store.getState().upsert(
      { date: "2026-08-12", journey_id: "j1", pain: 9 } as any,
      { ignoreDuplicates: true, onConflict: "journey_id,date" },
    )

    expect(resolved).toBeTruthy()
  })

  it("writes DO NOTHING — the existing row's columns are untouched, not overwritten", async () => {
    const { store, supabase } = await seededStore([
      { date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 },
    ])

    await store.getState().upsert(
      { date: "2026-08-12", journey_id: "j1", pain: 9 } as any,
      { ignoreDuplicates: true, onConflict: "journey_id,date" },
    )

    const stored = (supabase)._tables.daily_check_ins as CheckIn[]

    expect(stored).toHaveLength(1)

    // A real DO NOTHING never applied `pain: 9` — proves this isn't secretly
    // still doing DO UPDATE under a different name.
    expect(stored[0]!.pain).toBe(3)
  })

  it("clears the row's pending flag once the server confirms the no-op", async () => {
    const { store } = await seededStore([
      { date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 },
    ])

    const resolved = await store.getState().upsert(
      { date: "2026-08-12", journey_id: "j1", pain: 9 } as any,
      { ignoreDuplicates: true, onConflict: "journey_id,date" },
    )

    expect((resolved as any)._anchor_pending).toBeUndefined()
    expect((resolved as any)._anchor_optimistic).toBeUndefined()
    expect(store.getState().records.get("c1")?._anchor_pending).toBeUndefined()
    expectOrderIntegrity(store)
  })

  it("still inserts normally when nothing conflicts", async () => {
    const { store, supabase } = await seededStore([
      { date: "2026-08-11", id: "c1", journey_id: "j1", pain: 3 },
    ])

    await store.getState().upsert(
      { date: "2026-08-12", journey_id: "j1", pain: 5 } as any,
      { ignoreDuplicates: true, onConflict: "journey_id,date" },
    )

    const stored = (supabase)._tables.daily_check_ins as CheckIn[]

    expect(stored.map((r) => r.date).sort()).toEqual(["2026-08-11", "2026-08-12"])
    expectOrderIntegrity(store)
  })

  it("still rolls back on a real error — ignoreDuplicates only changes the no-conflict case", async () => {
    const { store, supabase } = await seededStore([
      { date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 },
    ])

    ;(supabase)._setError(
      "daily_check_ins",
      "upsert",
      { code: "42501", message: "insufficient privilege" },
      { status: 403 },
    )

    await expect(
      store.getState().upsert(
        { date: "2026-08-13", journey_id: "j1", pain: 5 } as any,
        { ignoreDuplicates: true, onConflict: "journey_id,date" },
      ),
    ).rejects.toThrow()

    // Only the seeded row remains — the optimistic insert rolled back.
    const rows = Array.from(store.getState().records.values())

    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe("c1")
    expectOrderIntegrity(store)
  })
})

describe("the queued replay", () => {
  function queuedUpsert(overrides: Partial<QueuedMutation> = {}): QueuedMutation {
    return {
      createdAt: 0,
      id: "m1",
      operation: "UPSERT",
      payload: { date: "2026-08-12", journey_id: "j1", pain: 7 },
      primaryKey: { id: "_temp:abc" },
      retryCount: 0,
      rollbackSnapshot: null,
      status: "in_flight",
      table: "daily_check_ins",
      ...overrides,
    }
  }

  it("replays with the conflict target the live call used", async () => {
    const supabase = createMockSupabase({
      daily_check_ins: [{ date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 }],
    })

    await executeRemoteMutation(
      supabase,
      "daily_check_ins",
      "id",
      queuedUpsert({ upsertOptions: { onConflict: "journey_id,date" } }),
      new Map(),
    )

    const stored = (supabase)._tables.daily_check_ins as CheckIn[]

    expect(stored).toHaveLength(1)
    expect(stored[0]!.pain).toBe(7)
  })

  it("duplicates on the drain when the option was not carried", async () => {
    // The failure this whole field exists to prevent: correct while online,
    // wrong only after a reconnect, where nobody is watching.
    const supabase = createMockSupabase({
      daily_check_ins: [{ date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 }],
    })

    await executeRemoteMutation(
      supabase,
      "daily_check_ins",
      "id",
      queuedUpsert(),
      new Map(),
    )

    expect((supabase)._tables.daily_check_ins).toHaveLength(2)
  })

  it("does not throw when a carried ignoreDuplicates conflicts on the drain", async () => {
    // The failure `ignoreDuplicates` exists to prevent on this path
    // specifically: a queue stops at its first failure, so a `PGRST116` here
    // would stall every OTHER pending mutation behind it, on every table, for
    // a write the server had already confirmed.
    const supabase = createMockSupabase({
      daily_check_ins: [{ date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 }],
    })

    const result = await executeRemoteMutation(
      supabase,
      "daily_check_ins",
      "id",
      queuedUpsert({
        upsertOptions: { ignoreDuplicates: true, onConflict: "journey_id,date" },
      }),
      new Map(),
    )

    expect(result.data).toBeNull()


    // DO NOTHING really did nothing — the existing row is untouched.
    const stored = (supabase)._tables.daily_check_ins as CheckIn[]

    expect(stored).toHaveLength(1)
    expect(stored[0]!.pain).toBe(3)
  })

  it("clears the store's pending flag via the executor when the drain confirms a no-op", async () => {
    const supabase = createMockSupabase({
      daily_check_ins: [{ date: "2026-08-12", id: "c1", journey_id: "j1", pain: 3 }],
    })
    const store = createTableStore<any, CheckIn, any, any>({
      primaryKey: "id",
      supabase,
      table: "daily_check_ins",
    })


    // A row already marked pending under the id this mutation is about — the
    // state left behind by the live `upsert()` call that got queued.
    store.setState((prev: any) => {
      const records = new Map(prev.records)

      records.set("c1", {
        _anchor_mutationId: "mut-1",
        _anchor_optimistic: true,
        _anchor_pending: "update",
        date: "2026-08-12",
        id: "c1",
        journey_id: "j1",
        pain: 9,
      })

      return { ...prev, order: ["c1"], records }
    })

    const executor = createMutationExecutor(
      supabase,
      "daily_check_ins",
      "id",
      store,
    )

    await executor(
      queuedUpsert({
        primaryKey: { id: "c1" },
        upsertOptions: { ignoreDuplicates: true, onConflict: "journey_id,date" },
      }),
      new Map(),
    )

    const row = store.getState().records.get("c1") as any

    expect(row?._anchor_pending).toBeUndefined()
    expect(row?._anchor_optimistic).toBeUndefined()
  })
})
