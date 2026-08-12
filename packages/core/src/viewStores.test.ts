import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createSupabaseStores } from "./createSupabaseStores.js"
import { OfflineQueue } from "./mutation/offlineQueue.js"
import { createMockSupabase } from "./__tests__/mockSupabase.js"

/**
 * Views wired through the factory.
 *
 * A view is the route to a join in this library: `records` is keyed on a
 * primary key and realtime writes the flat `postgres_changes` payload into it,
 * so an embedded child collection is dropped by the first event after a fetch.
 * A view is flat, so it survives. Before this they could not be named at all —
 * `TableNames` reads the generated `Database`'s `Tables` block only, and views
 * live in their own.
 *
 * Several of these tests carry a positive assertion beside the negative one on
 * purpose. "No realtime channel mentions the view" and "the queue holds nothing
 * for the view" are both true of a library that has stopped subscribing and
 * stopped queueing entirely, so on their own they would report a total
 * regression as a passing exclusion.
 */

type JourneyOverview = {
  id: string
  patient_id: string
  current_day: number
}

describe("views in createSupabaseStores", () => {
  let supabase: any

  beforeEach(() => {
    supabase = createMockSupabase({
      patients: [{ id: "p1", short_name: "Camille" }],
      journey_overview: [
        { id: "j1", patient_id: "p1", current_day: 8 },
        { id: "j2", patient_id: "p2", current_day: 3 },
      ],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function build(overrides: Record<string, unknown> = {}) {
    return createSupabaseStores<any>({
      supabase,
      tables: ["patients"],
      views: ["journey_overview"],
      fetchRemoteOnBoot: false,
      auth: false,
      ...overrides,
    } as any)
  }

  it("creates a store for a view alongside the tables", async () => {
    const stores = build() as any
    expect(stores.journey_overview).toBeDefined()

    const rows = await stores.journey_overview.getState().fetch()
    expect(rows.map((r: JourneyOverview) => r.id)).toEqual(["j1", "j2"])
  })

  it("refuses every write, because a view is not writable", async () => {
    const stores = build() as any
    const view = stores.journey_overview.getState()

    await expect(view.insert({ id: "x" })).rejects.toThrow(/Cannot mutate view/)
    await expect(view.update("j1", { current_day: 9 })).rejects.toThrow(/Cannot mutate view/)
    await expect(view.upsert({ id: "j1" })).rejects.toThrow(/Cannot mutate view/)
    await expect(view.remove("j1")).rejects.toThrow(/Cannot mutate view/)
  })

  it("subscribes realtime for the table and NOT for the view", () => {
    const channelSpy = vi.spyOn(supabase, "channel")
    build({ realtime: { enabled: true } })

    // Postgres publishes changes under the underlying TABLE's name, never the
    // view's, so a channel on the view would register and never fire.
    const subscribed = channelSpy.mock.calls.map((c) => String(c[0]))
    expect(subscribed.some((name) => name.includes("journey_overview"))).toBe(false)
    // …and the table still gets its channel. Without this half, a change that
    // stopped realtime working at all would pass as "the view is excluded".
    expect(subscribed.filter((name) => name.includes("patients"))).toHaveLength(1)
  })

  it("registers an offline-queue executor for the table and NOT for the view", () => {
    const registerSpy = vi.spyOn(OfflineQueue.prototype, "registerExecutor")
    build()

    const registered = registerSpy.mock.calls.map((c) => String(c[0]))
    expect(registered).toContain("patients")
    expect(registered).not.toContain("journey_overview")
  })

  it("gives a view store the shared queue, so its queue methods are not lies", async () => {
    const stores = build() as any
    // `getQueueSize` and `flushQueue` are not behind the view guard and are on
    // the public type. Without `_queue` they would resolve to a hardcoded 0 and
    // to nothing at all, which is indistinguishable from a working queue with
    // nothing in it — and a "retry pending changes" control wired to this store
    // would report success having done nothing.
    expect(stores.journey_overview.getState().getQueueSize()).toBe(0)
    await expect(stores.journey_overview.getState().flushQueue()).resolves.toBeUndefined()
  })

  it("does not warn that options the factory itself passed need the factory", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    build({ network: { isOnline: () => true, subscribe: () => () => {} } })

    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages.filter((m) => m.includes("requires createSupabaseStores()"))).toEqual([])
  })

  it("honours viewOptions — primaryKey, defaultSelect and defaultFilters", async () => {
    const stores = build({
      viewOptions: {
        journey_overview: {
          primaryKey: "id",
          defaultSelect: "id, current_day",
          defaultFilters: [{ column: "patient_id", op: "eq", value: "p1" }],
        },
      },
    }) as any

    const rows = await stores.journey_overview.getState().fetch()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ id: "j1", current_day: 8 })
    // `defaultSelect` really narrowed the row, so a screen reading a column it
    // did not ask for gets undefined rather than silently working.
    expect(rows[0]).not.toHaveProperty("patient_id")
  })

  it("fails the fetch when the primary key is missing from a row", async () => {
    // The case views make ordinary: a generated `Database` marks every view
    // column nullable, a LEFT JOIN can genuinely produce a null id, and a
    // `defaultSelect` that omits the key column looks like this too. Keyed on a
    // nullish value, all three rows would collapse onto one `records` entry and
    // every screen would render the last one three times over.
    supabase = createMockSupabase({
      patients: [],
      journey_overview: [
        { id: null, patient_id: "p1", current_day: 8 },
        { id: null, patient_id: "p2", current_day: 3 },
      ],
    })
    const stores = build() as any

    await expect(stores.journey_overview.getState().fetch()).resolves.toEqual([])
    const state = stores.journey_overview.getState()
    expect(state.records.size).toBe(0)
    expect(state.error?.message).toMatch(/journey_overview.*no "id"/)
    // And it is the query's error, not only the store's, so the screen that
    // asked shows it.
    expect([...state.queries.values()][0]?.error).toBe(state.error)
  })

  it("refuses a name that is in both tables and views", () => {
    expect(() =>
      createSupabaseStores<any>({
        supabase,
        tables: ["patients"],
        views: ["patients"],
        fetchRemoteOnBoot: false,
        auth: false,
      } as any),
    ).toThrow(/"patients" named in both/)
  })

  it("gets per-query scoping like any other store", async () => {
    const stores = build({ cacheStrategy: "merge" }) as any
    const view = stores.journey_overview.getState()

    await view.fetch()
    await view.fetch({ filters: [{ column: "patient_id", op: "eq", value: "p1" }] })

    expect(stores.journey_overview.getState().queries.size).toBe(2)
  })

  it("is cleared by the auth gate on sign-out, like a table store", async () => {
    const stores = build({ auth: true }) as any
    await stores.journey_overview.getState().fetch()
    await stores.patients.getState().fetch()
    expect(stores.journey_overview.getState().records.size).toBe(2)

    // Driven through the real gate rather than by calling `clearAll()` here:
    // views are only covered because the gate is handed `Object.values(stores)`
    // after the view loop has filled it. Narrow that list to the tables in some
    // later tidy-up and a signed-out user's rows stay in the view's `records`
    // and in its persisted blob, which on a shared device is the whole point of
    // clearing.
    await supabase.auth.signOut()
    expect(stores.journey_overview.getState().records.size).toBe(0)
    expect(stores.patients.getState().records.size).toBe(0)
  })

  it("fetches views on boot when asked to", async () => {
    const stores = build({ fetchRemoteOnBoot: true }) as any
    await new Promise((r) => setTimeout(r, 10))
    expect(stores.journey_overview.getState().records.size).toBe(2)
  })

  it("still works with no views at all", () => {
    const stores = createSupabaseStores<any>({
      supabase,
      tables: ["patients"],
      fetchRemoteOnBoot: false,
      auth: false,
    } as any) as any
    expect(stores.patients).toBeDefined()
    expect(stores.journey_overview).toBeUndefined()
  })
})
