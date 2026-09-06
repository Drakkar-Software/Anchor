import { beforeEach, describe, expect, it, vi } from "vitest"

import { createMockSupabase } from "./__tests__/mockSupabase.js"
import { createTableStore } from "./createTableStore.js"
import { MemoryAdapter } from "./persistence/persistenceAdapter.js"
import { queryKey } from "./query/queryKey.js"
import { selectQueryRows } from "./query/selectRows.js"

/**
 * Per-query scoping, driven at the store level.
 *
 * There is no jsdom in this package, so `useQuery` is never rendered; what it
 * reads — the `queries` registry, the keyed in-flight map, the keyed generation
 * counter and `selectQueryRows` — is all reachable from the store, and that is
 * what these exercise.
 *
 * The shape being defended is the one the consumer hits on its first screen:
 * a home screen showing TODAY's tasks and a list screen showing ALL of them,
 * mounted at once, over one table.
 */

type Task = {
  day: string
  done: boolean
  id: number
  title: string
}

const TODAY = "2026-08-12"
const YESTERDAY = "2026-08-11"

const todayOnly = [{ column: "day" as const, op: "eq" as const, value: TODAY }]

describe("per-query scoping", () => {
  let supabase: any

  beforeEach(() => {
    supabase = createMockSupabase({
      tasks: [
        { day: YESTERDAY, done: true, id: 1, title: "yesterday's" },
        { day: TODAY, done: false, id: 2, title: "today's first" },
        { day: TODAY, done: false, id: 3, title: "today's second" },
      ],
    })
  })

  function createStore(overrides: Record<string, unknown> = {}) {
    return createTableStore<any, Task, Partial<Task>, Partial<Task>>({
      supabase,
      table: "tasks",
      ...overrides,
    } as any)
  }

  describe("in-flight deduplication", () => {
    it("issues both requests instead of handing one query the other's promise", async () => {
      const store = createStore({ cacheStrategy: "merge" })
      const fromSpy = vi.spyOn(supabase, "from")

      // Both start before either resolves — the exact race two mounted
      // components produce. A single in-flight slot returned the FIRST
      // promise to the second caller, so the second query never issued a
      // request at all and rendered the first one's rows.
      const [scoped, all] = await Promise.all([
        store.getState().fetch({ filters: todayOnly }),
        store.getState().fetch(),
      ])

      expect(fromSpy).toHaveBeenCalledTimes(2)
      expect(scoped).not.toBe(all)
      expect(store.getState().queries.size).toBe(2)

      // What each screen renders comes from the selector, not from `fetch`'s
      // return value — `fetch` has always returned the whole store.
      expect(selectQueryRows<Task>(store.getState(), todayOnly).map((r) => r.id)).toEqual([2, 3])
      expect(selectQueryRows<Task>(store.getState()).map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2, 3])
    })

    it("still deduplicates two IDENTICAL concurrent fetches", async () => {
      const store = createStore()
      const fromSpy = vi.spyOn(supabase, "from")

      const [a, b] = await Promise.all([
        store.getState().fetch({ filters: todayOnly }),
        store.getState().fetch({ filters: todayOnly }),
      ])

      expect(a).toBe(b)
      expect(fromSpy).toHaveBeenCalledTimes(1)
    })

    it("keys on the EFFECTIVE options, so a store default cannot split a query", async () => {
      // `defaultFilters` is merged inside `fetch`. A key taken from the
      // caller's raw options would file the entry under a key nothing reads.
      const store = createStore({
        defaultFilters: [{ column: "done", op: "eq", value: false }],
      })

      await store.getState().fetch()

      const effective = store.getState().resolveFetchOptions()
      const entry = store.getState().queries.get(queryKey(effective))

      expect(entry).toBeDefined()
      expect(entry?.lastFetchedAt).toBeGreaterThan(0)

      // And NOT under the raw, unmerged key.
      expect(store.getState().queries.get(queryKey({}))).toBeUndefined()
    })
  })

  describe("the queries registry", () => {
    it("keeps one entry per query, each with its own timestamp", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      await store.getState().fetch({ filters: todayOnly })
      await store.getState().fetch()

      expect(store.getState().queries.size).toBe(2)

      for (const entry of store.getState().queries.values()) {
        expect(entry.lastFetchedAt).toBeGreaterThan(0)
        expect(entry.isLoading).toBe(false)
        expect(entry.error).toBeNull()
      }
    })

    it("records a failure on the query's own entry, not only globally", async () => {
      const store = createStore()

      vi.spyOn(supabase, "from").mockImplementationOnce(() => ({
        select: () => ({
          eq: () => ({
            then: (resolve: (v: unknown) => void) =>
              resolve({ count: null, data: null, error: { code: "42501", message: "denied" } }),
          }),
        }),
      }))

      await store.getState().fetch({ filters: todayOnly })

      const entry = store.getState().queries.get(
        queryKey(store.getState().resolveFetchOptions({ filters: todayOnly })),
      )


      // Written on failure too. Writing only on success means a cold offline
      // boot reports a permanent spinner over rows already in memory.
      expect(entry).toBeDefined()
      expect(entry?.isLoading).toBe(false)
      expect((entry?.error as { code?: string } | null)?.code).toBe("42501")
    })

    it("carries the count when one was asked for", async () => {
      const store = createStore()

      await store.getState().fetch({ count: "exact", filters: todayOnly })

      const entry = store.getState().queries.get(
        queryKey(store.getState().resolveFetchOptions({ count: "exact", filters: todayOnly })),
      )

      expect(entry?.count).toBe(2)
    })

    it("is bounded, so a per-keystroke filter cannot grow it forever", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      for (let i = 0; i < 40; i++) {
        await store.getState().fetch({
          filters: [{ column: "title", op: "ilike", value: `%${i}%` }],
        })
      }

      expect(store.getState().queries.size).toBeLessThanOrEqual(32)
    })

    it("forgets everything on clearAll", async () => {
      const store = createStore()

      await store.getState().fetch({ filters: todayOnly })
      expect(store.getState().queries.size).toBe(1)

      store.getState().clearAll()
      expect(store.getState().queries.size).toBe(0)
      expect(store.getState().records.size).toBe(0)
    })

    it("keeps a retained query across clearAll, because nothing unmounted", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      store.getState().retainQuery({ filters: todayOnly })
      await store.getState().fetch({ filters: todayOnly })

      // Sign-out empties the store; the screen is still on display.
      store.getState().clearAll()

      const fromSpy = vi.spyOn(supabase, "from")

      await store.getState().refetch()

      // The mounted screen is refetched. Dropping the retained options here
      // would send the next foreground refresh back to pulling the whole table.
      expect(fromSpy).toHaveBeenCalledTimes(1)
      expect(selectQueryRows<Task>(store.getState(), todayOnly)).toHaveLength(2)
    })

    it("does not evict a retained query to make room", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      store.getState().retainQuery({ filters: todayOnly })
      await store.getState().fetch({ filters: todayOnly })

      const retainedKey = queryKey(store.getState().resolveFetchOptions({ filters: todayOnly }))

      for (let i = 0; i < 40; i++) {
        await store.getState().fetch({
          filters: [{ column: "title", op: "ilike", value: `%${i}%` }],
        })
      }

      // Evicting a mounted screen's entry sends it back to "loading, with no
      // data" and makes it refetch on its next render.
      expect(store.getState().queries.has(retainedKey)).toBe(true)
    })

    it("reports loading per query, not per table", async () => {
      const store = createStore({ cacheStrategy: "merge" })


      // The table already holds rows — for a DIFFERENT query.
      await store.getState().fetch()

      const pending = store.getState().fetch({
        filters: [{ column: "title", op: "eq", value: "nothing matches this" }],
      })
      const key = queryKey(
        store.getState().resolveFetchOptions({
          filters: [{ column: "title", op: "eq", value: "nothing matches this" }],
        }),
      )

      // Judged on the table's row count, this reported "not loading" while it
      // had nothing to show, so the screen rendered its empty state instead of
      // a spinner.
      expect(store.getState().queries.get(key)?.isLoading).toBe(true)
      await pending
      expect(store.getState().queries.get(key)?.isLoading).toBe(false)
    })
  })

  describe("a response that outlives the store it was fetched for", () => {
    it("is discarded after clearAll rather than repopulating it", async () => {
      const store = createStore()

      // A fetch still in flight when the user signs out.
      let release: (() => void) | undefined

      vi.spyOn(supabase, "from").mockImplementationOnce(() => ({
        select: () => ({
          then: (resolve: (v: unknown) => void) => {
            release = () =>
              resolve({
                count: null,
                data: [{ day: TODAY, done: false, id: 1, title: "previous account's row" }],
                error: null,
              })
          },
        }),
      }))

      const slow = store.getState().fetch()


      // Let the fetch reach its await, so the response is genuinely in flight.
      await new Promise((r) => setTimeout(r, 0))
      store.getState().clearAll()
      release?.()
      await slow

      // The generation counter only ever goes up, so the late response cannot
      // collide with its replacement's number and pass the staleness guard.
      // Resetting it on clear let the previous account's rows land in a store
      // that had just been emptied for a different user.
      expect(store.getState().records.size).toBe(0)
    })
  })

  describe("stale-response discard is per query", () => {
    it("does not let one query's fetch invalidate another's response", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      // A shared generation counter meant the second fetch bumped the counter
      // and the first fetch's response was thrown away as "stale".
      const scopedPromise = store.getState().fetch({ filters: todayOnly })
      const allPromise = store.getState().fetch()
      const [scoped, all] = await Promise.all([scopedPromise, allPromise])

      expect(scoped.length).toBe(2)
      expect(all.length).toBe(3)
    })
  })

  describe("refetch", () => {
    it("replays every RETAINED query, not just the one that fetched last", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      store.getState().retainQuery({ filters: todayOnly })
      store.getState().retainQuery()
      await store.getState().fetch({ filters: todayOnly })
      await store.getState().fetch()

      const before = Array.from(store.getState().queries.keys())
      const stamps = new Map(
        Array.from(store.getState().queries, ([k, v]) => [k, v.lastFetchedAt]),
      )

      await new Promise((r) => setTimeout(r, 5))
      await store.getState().refetch()

      // Both entries moved. With a single `lastFetchOptions` slot only one did,
      // and under "replace" the other query's rows were evicted with it — which
      // is what `appLifecycle`'s foreground handler triggers on every resume.
      for (const key of before) {
        expect(store.getState().queries.get(key)?.lastFetchedAt).toBeGreaterThan(
          stamps.get(key)!,
        )
      }
    })

    it("does NOT replay a query nothing is watching any more", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      // A screen the user visited and left.
      store.getState().retainQuery({ filters: todayOnly })
      await store.getState().fetch({ filters: todayOnly })
      store.getState().releaseQuery({ filters: todayOnly })

      const fromSpy = vi.spyOn(supabase, "from")

      await store.getState().refetch()

      // One request — the fallback whole-table read — not one per filter
      // combination the store has ever been handed. A foreground resume fires
      // this on every store.
      expect(fromSpy).toHaveBeenCalledTimes(1)
    })

    it("refcounts retain, so two components on one query survive one unmount", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      store.getState().retainQuery({ filters: todayOnly })
      store.getState().retainQuery({ filters: todayOnly })
      await store.getState().fetch({ filters: todayOnly })
      store.getState().releaseQuery({ filters: todayOnly })

      const fromSpy = vi.spyOn(supabase, "from")

      await store.getState().refetch()

      // Still retained once, so still replayed. React 18 double-invokes
      // effects, which is exactly this pattern.
      expect(fromSpy).toHaveBeenCalledTimes(1)
      expect(store.getState().queries.size).toBe(1)
    })

    it("falls back to a plain fetch when nothing is retained", async () => {
      const store = createStore()
      const rows = await store.getState().refetch()

      expect(rows.length).toBe(3)
    })
  })

  describe("selectQueryRows over the store's own state", () => {
    it("gives each query its own rows from one shared record map", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      await store.getState().fetch()

      const state = store.getState()

      expect(selectQueryRows<Task>(state, todayOnly).map((r) => r.id)).toEqual([2, 3])
      expect(selectQueryRows<Task>(state).map((r) => r.id)).toEqual([1, 2, 3])
    })

    it("shows an optimistic insert in the query that should contain it", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      await store.getState().fetch()

      // Do not await: this is the optimistic window, before the server answers.
      const pending = store.getState().insert({ day: TODAY, title: "typed just now" } as any)

      const rows = selectQueryRows<Task>(store.getState(), todayOnly)

      expect(rows.some((r) => r.title === "typed just now")).toBe(true)

      await pending
    })

    it("shows a pending row even when the filter names a column it lacks", async () => {
      const store = createStore({ cacheStrategy: "merge" })

      await store.getState().fetch()

      // No `day` at all — the optimistic row only carries what was passed.
      const pending = store.getState().insert({ title: "no day column" } as any)

      const rows = selectQueryRows<Task>(store.getState(), todayOnly)

      expect(rows.some((r) => r.title === "no day column")).toBe(true)

      await pending
    })

    it("reads rows straight after a hydrate, with no fetch and no network", async () => {
      const adapter = new MemoryAdapter()

      await adapter.setItem("anchor:public:tasks", [
        { day: TODAY, done: false, id: 2, title: "today's first" },
        { day: YESTERDAY, done: true, id: 1, title: "yesterday's" },
      ])

      const store = createStore({ persistence: { adapter } })

      await store.getState().hydrate()

      // No entry exists for any query yet — the rows still have to be readable,
      // because this is the offline cold boot the library exists for.
      expect(store.getState().queries.size).toBe(0)
      expect(selectQueryRows<Task>(store.getState(), todayOnly).map((r) => r.id)).toEqual([2])
    })
  })

  describe("queryFn", () => {
    it("gets no registry entry, and never dedups against another queryFn", async () => {
      const store = createStore({ cacheStrategy: "merge" })
      const fromSpy = vi.spyOn(supabase, "from")

      const [a, b] = await Promise.all([
        store.getState().fetch({ queryFn: (builder: any) => builder.eq("day", TODAY) }),
        store.getState().fetch({ queryFn: (builder: any) => builder.eq("day", YESTERDAY) }),
      ])

      // Two opaque functions are indistinguishable by value, so they must never
      // share a key: sharing one would let a selective sync's narrow result set
      // become the answer for an unfiltered read.
      expect(fromSpy).toHaveBeenCalledTimes(2)
      expect(a).not.toBe(b)

      // And they register nothing, because there is no key to register under.
      expect(store.getState().queries.size).toBe(0)

      // Both results are in the store; neither displaced the other.
      expect(store.getState().records.size).toBe(3)
    })
  })
})
