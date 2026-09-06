import { describe, expect,it } from "vitest"

import { createMockSupabase } from "./__tests__/mockSupabase.js"
import { createTableStore } from "./createTableStore.js"
import { createMutationExecutor } from "./mutation/mutationPipeline.js"
import { encodeKey } from "./utils/compositeKey.js"

/**
 * A join table shaped exactly like MetCare's `stay_services`/`blocked_profiles`/
 * `post_likes`: no surrogate `id`, both columns client-supplied, primary key
 * `(stay_id, service_id)`. This is the shape `createTableStore` used to reject
 * outright — see the deleted throw at the top of `createTableStore.ts`.
 */
type Link = {
  note?: string
  service_id: string
  stay_id: string
}

describe("createTableStore — composite primary keys", () => {
  function seedSupabase() {
    return createMockSupabase({
      stay_services: [
        { note: "breakfast", service_id: "svc1", stay_id: "s1" },
        { note: "spa", service_id: "svc2", stay_id: "s1" },
        { note: "breakfast", service_id: "svc1", stay_id: "s2" },
      ],
    })
  }

  function createStore(supabase: any) {
    return createTableStore<any, Link, Link, Partial<Link>>({
      primaryKey: ["stay_id", "service_id"],
      supabase,
      table: "stay_services",
    })
  }

  it("keys records by the JSON-encoded composite key on fetch", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)

    await store.getState().fetch()

    const state = store.getState()

    expect(state.records.size).toBe(3)

    const key = encodeKey({ service_id: "svc1", stay_id: "s1" }, ["stay_id", "service_id"])

    expect(state.records.get(key)).toMatchObject({ note: "breakfast", service_id: "svc1", stay_id: "s1" })
    expect(state.order).toContain(key)
  })

  it("insert requires every PK column in the payload", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)

    await expect(
      store.getState().insert({ stay_id: "s3" } as Link),
    ).rejects.toThrow(/requires every primary key column/v)

    // Nothing optimistically applied for the rejected insert.
    expect(store.getState().records.size).toBe(0)
  })

  it("insert with every PK column present writes through and confirms by the encoded key", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)

    const row = await store.getState().insert({ note: "late checkout", service_id: "svc9", stay_id: "s3" })

    expect(row.stay_id).toBe("s3")
    expect(row.service_id).toBe("svc9")

    const key = encodeKey({ service_id: "svc9", stay_id: "s3" }, ["stay_id", "service_id"])

    expect(store.getState().records.get(key)).toMatchObject({ note: "late checkout" })
  })

  it("update accepts a plain { column: value } object and normalizes it to the encoded key", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)

    await store.getState().fetch()

    const updated = await store.getState().update({ service_id: "svc2", stay_id: "s1" }, { note: "premium spa" })

    expect(updated.note).toBe("premium spa")

    const key = encodeKey({ service_id: "svc2", stay_id: "s1" }, ["stay_id", "service_id"])

    expect(store.getState().records.get(key)).toMatchObject({ note: "premium spa" })
  })

  it("remove accepts a plain object id and deletes the right row only", async () => {
    const supabase = seedSupabase()
    const store = createStore(supabase)

    await store.getState().fetch()

    await store.getState().remove({ service_id: "svc1", stay_id: "s1" })

    const state = store.getState()

    expect(state.records.size).toBe(2)

    const removedKey = encodeKey({ service_id: "svc1", stay_id: "s1" }, ["stay_id", "service_id"])

    expect(state.records.has(removedKey)).toBe(false)


    // The other s1 row survives — a naive single-column .eq() would have
    // deleted every row for stay_id "s1".
    const survivingKey = encodeKey({ service_id: "svc2", stay_id: "s1" }, ["stay_id", "service_id"])

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
      { note: "ignored", service_id: "svc1", stay_id: "s1" },
      { ignoreDuplicates: true, onConflict: "stay_id,service_id" },
    )

    expect(result.note).toBe("ignored")
    expect(result._anchor_pending).toBeUndefined()

    const key = encodeKey({ service_id: "svc1", stay_id: "s1" }, ["stay_id", "service_id"])

    expect(store.getState().records.get(key)?._anchor_pending).toBeUndefined()
  })

  it("subscribe() refuses a composite-key table rather than binding the wrong column", () => {
    const supabase = seedSupabase()
    const store = createTableStore<any, Link, Link, Partial<Link>>({
      // A fake manager, so the composite-key guard is what's under test here
      // rather than the (already-covered) "no manager at all" guard.
      _realtimeManager: {} as any,
      primaryKey: ["stay_id", "service_id"],
      supabase,
      table: "stay_services",
    })

    expect(() => store.getState().subscribe()).toThrow(/composite primary key/v)
  })
})

describe("createMutationExecutor — composite primary keys", () => {
  it("replays a queued UPDATE against the right composite row and rekeys the store on confirm", async () => {
    const supabase = createMockSupabase({
      stay_services: [{ note: "breakfast", service_id: "svc1", stay_id: "s1" }],
    })
    const store = createTableStore<any, Link, Link, Partial<Link>>({
      primaryKey: ["stay_id", "service_id"],
      supabase,
      table: "stay_services",
    })

    await store.getState().fetch()

    const executor = createMutationExecutor(
      supabase,
      "stay_services",
      ["stay_id", "service_id"],
      store,
    )

    const key = encodeKey({ service_id: "svc1", stay_id: "s1" }, ["stay_id", "service_id"])

    await executor(
      {
        createdAt: Date.now(),
        id: "m1",
        operation: "UPDATE",
        payload: { note: "premium breakfast" },
        primaryKey: { service_id: "svc1", stay_id: "s1" },
        retryCount: 0,
        rollbackSnapshot: null,
        status: "in_flight",
        table: "stay_services",
      },
      new Map(),
    )

    expect(store.getState().records.get(key)).toMatchObject({ note: "premium breakfast" })
  })
})
