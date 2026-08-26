import { describe, it, expect } from "vitest"
import { createTableStore } from "./createTableStore.js"
import { createMutationExecutor } from "./mutation/mutationPipeline.js"
import { createMockSupabase } from "./__tests__/mockSupabase.js"
import { encodeKey } from "./utils/compositeKey.js"

/**
 * A join table shaped exactly like MetCare's `stay_services`/`blocked_profiles`/
 * `post_likes`: no surrogate `id`, both columns client-supplied, primary key
 * `(stay_id, service_id)`. This is the shape `createTableStore` used to reject
 * outright — see the deleted throw at the top of `createTableStore.ts`.
 */
type Link = {
  stay_id: string
  service_id: string
  note?: string
}

describe("createTableStore — composite primary keys", () => {
  function seedSupabase() {
    return createMockSupabase({
      stay_services: [
        { stay_id: "s1", service_id: "svc1", note: "breakfast" },
        { stay_id: "s1", service_id: "svc2", note: "spa" },
        { stay_id: "s2", service_id: "svc1", note: "breakfast" },
      ],
    })
  }

  function createStore(supabase: any) {
    return createTableStore<any, Link, Link, Partial<Link>>({
      supabase,
      table: "stay_services",
      primaryKey: ["stay_id", "service_id"],
    })
  }

  it("keys records by the JSON-encoded composite key on fetch", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)
    await store.getState().fetch()

    const state = store.getState()
    expect(state.records.size).toBe(3)
    const key = encodeKey({ stay_id: "s1", service_id: "svc1" }, ["stay_id", "service_id"])
    expect(state.records.get(key)).toMatchObject({ stay_id: "s1", service_id: "svc1", note: "breakfast" })
    expect(state.order).toContain(key)
  })

  it("insert requires every PK column in the payload", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)

    await expect(
      store.getState().insert({ stay_id: "s3" } as Link),
    ).rejects.toThrow(/requires every primary key column/)

    // Nothing optimistically applied for the rejected insert.
    expect(store.getState().records.size).toBe(0)
  })

  it("insert with every PK column present writes through and confirms by the encoded key", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)

    const row = await store.getState().insert({ stay_id: "s3", service_id: "svc9", note: "late checkout" })
    expect(row.stay_id).toBe("s3")
    expect(row.service_id).toBe("svc9")

    const key = encodeKey({ stay_id: "s3", service_id: "svc9" }, ["stay_id", "service_id"])
    expect(store.getState().records.get(key)).toMatchObject({ note: "late checkout" })
  })

  it("update accepts a plain { column: value } object and normalizes it to the encoded key", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)
    await store.getState().fetch()

    const updated = await store.getState().update({ stay_id: "s1", service_id: "svc2" }, { note: "premium spa" })
    expect(updated.note).toBe("premium spa")

    const key = encodeKey({ stay_id: "s1", service_id: "svc2" }, ["stay_id", "service_id"])
    expect(store.getState().records.get(key)).toMatchObject({ note: "premium spa" })
  })

  it("remove accepts a plain object id and deletes the right row only", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)
    await store.getState().fetch()

    await store.getState().remove({ stay_id: "s1", service_id: "svc1" })

    const state = store.getState()
    expect(state.records.size).toBe(2)
    const removedKey = encodeKey({ stay_id: "s1", service_id: "svc1" }, ["stay_id", "service_id"])
    expect(state.records.has(removedKey)).toBe(false)
    // The other s1 row survives — a naive single-column .eq() would have
    // deleted every row for stay_id "s1".
    const survivingKey = encodeKey({ stay_id: "s1", service_id: "svc2" }, ["stay_id", "service_id"])
    expect(state.records.has(survivingKey)).toBe(true)
  })

  it("upsert with ignoreDuplicates on a composite conflict target resolves without throwing", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)
    await store.getState().fetch()

    // DO NOTHING: Postgres writes nothing and returns no row. The store
    // resolves to its own optimistic merge (this payload, over the existing
    // snapshot), cleared of its pending flags — the documented behavior for
    // an ignored conflict, matching the single-column-PK path exactly.
    const result = await store.getState().upsert(
      { stay_id: "s1", service_id: "svc1", note: "ignored" },
      { onConflict: "stay_id,service_id", ignoreDuplicates: true },
    )
    expect(result.note).toBe("ignored")
    expect(result._anchor_pending).toBeUndefined()

    const key = encodeKey({ stay_id: "s1", service_id: "svc1" }, ["stay_id", "service_id"])
    expect(store.getState().records.get(key)?._anchor_pending).toBeUndefined()
  })

  it("subscribe() refuses a composite-key table rather than binding the wrong column", () => {
    const supabase = seedSupabase()
    const store = createTableStore<any, Link, Link, Partial<Link>>({
      supabase,
      table: "stay_services",
      primaryKey: ["stay_id", "service_id"],
      // A fake manager, so the composite-key guard is what's under test here
      // rather than the (already-covered) "no manager at all" guard.
      _realtimeManager: {} as any,
    })
    expect(() => store.getState().subscribe()).toThrow(/composite primary key/)
  })
})

describe("createMutationExecutor — composite primary keys", () => {
  it("replays a queued UPDATE against the right composite row and rekeys the store on confirm", async () => {
    const supabase = createMockSupabase({
      stay_services: [{ stay_id: "s1", service_id: "svc1", note: "breakfast" }],
    })
    const store = createTableStore<any, Link, Link, Partial<Link>>({
      supabase,
      table: "stay_services",
      primaryKey: ["stay_id", "service_id"],
    })
    await store.getState().fetch()

    const executor = createMutationExecutor(
      supabase,
      "stay_services",
      ["stay_id", "service_id"],
      store,
    )

    const key = encodeKey({ stay_id: "s1", service_id: "svc1" }, ["stay_id", "service_id"])
    await executor(
      {
        id: "m1",
        table: "stay_services",
        operation: "UPDATE",
        payload: { note: "premium breakfast" },
        primaryKey: { stay_id: "s1", service_id: "svc1" },
        createdAt: Date.now(),
        status: "in_flight",
        retryCount: 0,
        rollbackSnapshot: null,
      },
      new Map(),
    )

    expect(store.getState().records.get(key)).toMatchObject({ note: "premium breakfast" })
  })
})
