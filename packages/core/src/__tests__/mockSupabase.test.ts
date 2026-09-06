import { describe, expect,it } from "vitest"

import { createMockSupabase } from "./mockSupabase.js"

/**
 * The mock is test infrastructure, so it needs its own tests: a mock that
 * silently ignores an argument makes every suite built on it agree with a
 * production path that would not.
 *
 * Each block below covers a behaviour the mock did not have: `select` was
 * recorded and never read, there was no `.rpc()` at all, and `count` was taken
 * after the page was sliced.
 */
describe("mockSupabase select projection", () => {
  function client() {
    return createMockSupabase({
      steps: [
        { id: 10, label: "step one", todo_id: 1 },
        { id: 11, label: "step two", todo_id: 1 },
        { id: 12, label: "other", todo_id: 2 },
      ],

      todos: [
        { id: 1, owner_id: 7, secret: "hidden", title: "a" },
        { id: 2, owner_id: 7, secret: "hidden", title: "b" },
      ],
    })
  }

  it("returns whole rows for '*'", async () => {
    const { data } = await client().from("todos").select("*")

    expect(data[0]).toHaveProperty("secret")
  })

  it("returns only the named columns, so a narrow defaultSelect is observable", async () => {
    const { data } = await client().from("todos").select("id, title")

    expect(data[0]).toEqual({ id: 1, title: "a" })
    expect(data[0]).not.toHaveProperty("secret")
  })

  it("resolves an embed into a nested array", async () => {
    const { data } = await client().from("todos").select("id, steps(*)")

    expect(data[0].id).toBe(1)
    expect(data[0].steps).toHaveLength(2)
    expect(data[1].steps).toHaveLength(1)
  })

  it("keeps '*' alongside an embed", async () => {
    const { data } = await client().from("todos").select("*, steps(*)")

    expect(data[0]).toHaveProperty("secret")
    expect(data[0].steps).toHaveLength(2)
  })

  it("does not let a comma inside an embed split the column list", async () => {
    const { data } = await client().from("todos").select("id, steps(id, label)")

    expect(Object.keys(data[0]).sort()).toEqual(["id", "steps"])
  })

  it("counts the rows matched, not the columns projected", async () => {
    const { count, data } = await client()
      .from("todos")
      .select("id", { count: "exact" })
      .limit(1)

    expect(data).toHaveLength(1)
    expect(count).toBe(2)
  })

  it("projects through single() too", async () => {
    const { data } = await client().from("todos").select("title").eq("id", 1).single()

    expect(data).toEqual({ title: "a" })
  })
})

/**
 * Every store mutation appends `.select(defaultSelect ?? '*')`, so the write
 * builders take a select string too — and each one dropped it. Reads and
 * writes go through different builders in this mock, so a projection test on
 * `.from().select()` proves nothing about them.
 */
describe("mockSupabase select projection on writes", () => {
  function client() {
    return createMockSupabase({
      todos: [{ id: 1, secret: "hidden", title: "a" }],
    })
  }

  it("projects an insert's returned row", async () => {
    const { data } = await client().from("todos").insert({ secret: "x", title: "new" }).select("title")

    expect(data[0]).toEqual({ title: "new" })
    expect(data[0]).not.toHaveProperty("secret")
  })

  it("projects an insert through single()", async () => {
    const { data } = await client()
      .from("todos")
      .insert({ secret: "x", title: "new" })
      .select("title")
      .single()

    expect(data).toEqual({ title: "new" })
  })

  it("projects an upsert's returned rows", async () => {
    const { data } = await client().from("todos").upsert({ id: 1, title: "b" }).select("id, title")

    expect(data[0]).toEqual({ id: 1, title: "b" })
    expect(data[0]).not.toHaveProperty("secret")
  })

  it("projects an update's returned rows", async () => {
    const { data } = await client().from("todos").update({ title: "c" }).eq("id", 1).select("title")

    expect(data[0]).toEqual({ title: "c" })
    expect(data[0]).not.toHaveProperty("secret")
  })

  it("projects an update through single()", async () => {
    const { data } = await client()
      .from("todos")
      .update({ title: "d" })
      .eq("id", 1)
      .select("title")
      .single()

    expect(data).toEqual({ title: "d" })
  })

  it("still returns whole rows when a write asks for '*'", async () => {
    const { data } = await client().from("todos").insert({ secret: "x", title: "new" }).select("*")

    expect(data[0]).toHaveProperty("secret")
    expect(data[0]).toHaveProperty("id")
  })

  it("returns whole rows when a write does not call select at all", async () => {
    const { data } = await client().from("todos").insert({ secret: "x", title: "new" })

    expect(data[0]).toHaveProperty("secret")
  })
})

/**
 * `count` is the total matching the filters, independent of the page returned.
 * The mock used to compute it after slicing, so `data.length < count` was
 * unreachable — which made `createTableStore`'s truncation warning untestable
 * and would make any assertion about a total pass whether or not the total was
 * right.
 */
describe("mockSupabase count", () => {
  function client() {
    return createMockSupabase({
      todos: [
        { done: false, id: 1, title: "a" },
        { done: false, id: 2, title: "b" },
        { done: true, id: 3, title: "c" },
        { done: false, id: 4, title: "d" },
        { done: true, id: 5, title: "e" },
      ],
    })
  }

  it("reports the full match count under a limit", async () => {
    const { count, data } = await client().from("todos").select("*", { count: "exact" }).limit(2)

    expect(data).toHaveLength(2)
    expect(count).toBe(5)
  })

  it("reports the full match count under a range", async () => {
    const { count, data } = await client().from("todos").select("*", { count: "exact" }).range(1, 2)

    expect(data).toHaveLength(2)
    expect(count).toBe(5)
  })

  it("counts only the rows the filters match", async () => {
    const { count, data } = await client()
      .from("todos")
      .select("*", { count: "exact" })
      .eq("done", false)
      .limit(1)

    expect(data).toHaveLength(1)
    expect(count).toBe(3)
  })

  it("returns a null count when none was asked for", async () => {
    const { count } = await client().from("todos").select("*").limit(2)

    expect(count).toBeNull()
  })
})

describe("mockSupabase rpc", () => {
  it("calls a registered handler with its arguments", async () => {
    const supabase = createMockSupabase()

    supabase._setRpc("add", (args: Record<string, unknown>) => (args.a as number) + (args.b as number))

    const { data, error } = await supabase.rpc("add", { a: 2, b: 3 })

    expect(error).toBeNull()
    expect(data).toBe(5)
  })

  it("reports a set-returning function's length as count", async () => {
    const supabase = createMockSupabase()

    supabase._setRpc("search", () => [{ id: 1 }, { id: 2 }])

    const { count, data } = await supabase.rpc("search", {})

    expect(data).toHaveLength(2)
    expect(count).toBe(2)
  })

  it("resolves an unregistered function to a PostgREST-shaped error rather than throwing", async () => {
    const { data, error } = await createMockSupabase().rpc("missing", {})

    expect(data).toBeNull()
    expect(error?.code).toBe("PGRST202")
  })

  it("is thenable, so it can be handed straight to a queryFn", async () => {
    const supabase = createMockSupabase()

    supabase._setRpc("rows", () => [{ id: 1 }])

    const result = await (supabase.rpc("rows") as unknown as Promise<{ data: unknown[] }>)

    expect(result.data).toHaveLength(1)
  })
})

/**
 * The operators below were all *accepted and ignored* until 2.3.0: the builder
 * methods pushed them into `filters` (or, for `not`/`or`/`filter`, recorded
 * nothing at all) and `applyFilters`' `switch` had no case for them, so its
 * `default: return true` matched every row.
 *
 * Nothing went red when they were implemented, which is the more uncomfortable
 * finding: no test in 657 had ever driven one of them through the mock. Each
 * block below therefore asserts both halves — the rows the filter keeps AND the
 * rows it removes. An assertion that only names what came back passes just as
 * well against a filter that does nothing.
 */
describe("mockSupabase filter operators", () => {
  function client() {
    return createMockSupabase({
      posts: [
        { id: 1, meta: { pinned: true }, tags: ["red", "blue"], title: "hello world", views: 10 },
        { id: 2, meta: { pinned: false }, tags: ["blue"], title: "goodbye", views: 20 },
        { id: 3, meta: { pinned: true }, tags: ["green"], title: "hello again", views: 30 },
      ],
    })
  }

  const ids = (data: any[]) => data.map((r: any) => r.id).sort((a: number, b: number) => a - b)

  it("contains keeps rows whose array holds every element asked for", async () => {
    const { data } = await client().from("posts").select("*").contains("tags", ["blue"])

    expect(ids(data)).toEqual([1, 2])

    const { data: none } = await client().from("posts").select("*").contains("tags", ["red", "green"])

    expect(none).toEqual([])
  })

  it("containedBy keeps rows whose array fits inside the one given", async () => {
    const { data } = await client().from("posts").select("*").containedBy("tags", ["blue", "green"])

    expect(ids(data)).toEqual([2, 3])
  })

  it("overlaps keeps rows sharing at least one element", async () => {
    const { data } = await client().from("posts").select("*").overlaps("tags", ["green", "red"])

    expect(ids(data)).toEqual([1, 3])

    const { data: none } = await client().from("posts").select("*").overlaps("tags", ["purple"])

    expect(none).toEqual([])
  })

  it("contains matches a jsonb column by key and value", async () => {
    const { data } = await client().from("posts").select("*").contains("meta", { pinned: true })

    expect(ids(data)).toEqual([1, 3])
  })

  it("textSearch requires every term, and rejects a row missing one", async () => {
    const { data } = await client().from("posts").select("*").textSearch("title", "hello")

    expect(ids(data)).toEqual([1, 3])

    const { data: none } = await client().from("posts").select("*").textSearch("title", "hello & missing")

    expect(none).toEqual([])
  })

  it("match expands to one eq per key", async () => {
    const { data } = await client().from("posts").select("*").match({ id: 2, views: 20 })

    expect(ids(data)).toEqual([2])

    // Second key disagrees, so nothing matches — proving both were applied.
    const { data: none } = await client().from("posts").select("*").match({ id: 2, views: 99 })

    expect(none).toEqual([])
  })

  it("not inverts the operator it wraps", async () => {
    const { data } = await client().from("posts").select("*").not("id", "eq", 1)

    expect(ids(data)).toEqual([2, 3])
  })

  it("or keeps a row matching any clause and drops one matching none", async () => {
    const { data } = await client().from("posts").select("*").or("id.eq.1,views.gte.30")

    expect(ids(data)).toEqual([1, 3])

    const { data: none } = await client().from("posts").select("*").or("id.eq.99,views.gt.100")

    expect(none).toEqual([])
  })

  it("or parses a not. prefix and an in.() list", async () => {
    const { data } = await client().from("posts").select("*").or("id.in.(1,2)")

    expect(ids(data)).toEqual([1, 2])

    const { data: negated } = await client().from("posts").select("*").or("id.not.eq.1")

    expect(ids(negated)).toEqual([2, 3])
  })

  it("filter applies a raw operator, and its not. prefix negates", async () => {
    const { data } = await client().from("posts").select("*").filter("views", "gte", 20)

    expect(ids(data)).toEqual([2, 3])

    const { data: negated } = await client().from("posts").select("*").filter("views", "not.gte", 20)

    expect(ids(negated)).toEqual([1])
  })

  it("accepts PostgREST's own operator spelling in filter()", async () => {
    const { data } = await client().from("posts").select("*").filter("tags", "cs", ["blue"])

    expect(ids(data)).toEqual([1, 2])
  })

  it("anchors like, so a pattern is not treated as a substring search", async () => {
    const { data } = await client().from("posts").select("*").like("title", "hello%")

    expect(ids(data)).toEqual([1, 3])

    // 'world' appears inside row 1's title but the pattern is anchored.
    const { data: none } = await client().from("posts").select("*").like("title", "world")

    expect(none).toEqual([])
  })

  it("throws on an operator it has not implemented instead of matching everything", async () => {
    const supabase = createMockSupabase({ posts: [{ id: 1 }] })
    const builder = supabase.from("posts").select("*")

    builder.filter("id", "rangeGt", "[1,2]")
    await expect(builder).rejects.toThrow(/unimplemented filter operator/v)
  })

  it("throws on a nested or() group rather than dropping it", async () => {
    const supabase = createMockSupabase({ posts: [{ id: 1 }] })

    expect(() => supabase.from("posts").select("*").or("and(id.eq.1,views.eq.2)")).toThrow(
      /nested/v,
    )
  })
})

describe("mockSupabase update and delete honour every filter", () => {
  function client() {
    return createMockSupabase({
      posts: [
        { archived: false, id: 1, views: 10 },
        { archived: false, id: 2, views: 20 },
        { archived: false, id: 3, views: 30 },
      ],
    })
  }

  it("updates only the rows a gt filter matches", async () => {
    const supabase = client()

    await supabase.from("posts").update({ archived: true }).gt("views", 15)

    const rows = supabase._tables.posts as any[]

    expect(rows.filter((r) => r.archived).map((r) => r.id)).toEqual([2, 3])
    expect(rows.find((r) => r.id === 1).archived).toBe(false)
  })

  it("deletes only the rows an in filter matches", async () => {
    const supabase = client()

    await supabase.from("posts").delete().in("id", [1, 3])

    expect((supabase._tables.posts as any[]).map((r) => r.id)).toEqual([2])
  })

  it("delete returns the removed rows when a select is chained, and null without one", async () => {
    const withSelect = client()
    const { data } = await withSelect.from("posts").delete().eq("id", 1).select("id")

    expect(data).toEqual([{ id: 1 }])

    const without = client()
    const bare = await without.from("posts").delete().eq("id", 1)

    expect(bare.data).toBeNull()
    expect((without._tables.posts as any[]).map((r) => r.id)).toEqual([2, 3])
  })

  it("update().single() on no match reports PGRST116 rather than a silent null", async () => {
    const { data, error } = await client().from("posts").update({ views: 1 }).eq("id", 99).single()

    expect(data).toBeNull()
    expect(error?.code).toBe("PGRST116")
  })
})

describe("mockSupabase non-public schemas", () => {
  it("routes .schema(name).from(table) to a schema-scoped table", async () => {
    const supabase = createMockSupabase({
      "app.things": [{ id: 1, name: "scoped" }],
      things: [{ id: 2, name: "public" }],
    })

    const scoped = await supabase.schema("app").from("things").select("*")

    expect(scoped.data).toEqual([{ id: 1, name: "scoped" }])

    const pub = await supabase.from("things").select("*")

    expect(pub.data).toEqual([{ id: 2, name: "public" }])
  })

  it("treats .schema('public') as the unprefixed table", async () => {
    const supabase = createMockSupabase({ things: [{ id: 2 }] })
    const { data } = await supabase.schema("public").from("things").select("*")

    expect(data).toEqual([{ id: 2 }])
  })

  it("scopes rpc to the schema too", async () => {
    const supabase = createMockSupabase()

    supabase._setRpc("app.tally", () => 7)

    const scoped = await supabase.schema("app").rpc("tally")

    expect(scoped.data).toBe(7)

    // The same name on the root client is a different function, and missing.
    const root = await supabase.rpc("tally")

    expect(root.error?.code).toBe("PGRST202")
  })
})

describe("mockSupabase error injection", () => {
  it("fails a select with the injected error and status", async () => {
    const supabase = createMockSupabase({ posts: [{ id: 1 }] })

    supabase._setError("posts", "select", { code: "42501", message: "boom" }, { status: 403 })

    const { data, error, status } = await supabase.from("posts").select("*")

    expect(data).toBeNull()
    expect(error?.code).toBe("42501")
    expect(status).toBe(403)
  })

  it("injects status 0, which is what isTransportError requires", async () => {
    const supabase = createMockSupabase({ posts: [] })

    supabase._setError("posts", "insert", { code: "", message: "fetch failed" }, { status: 0 })

    const { error, status } = await supabase.from("posts").insert({ id: 1 }).select("*").single()

    expect(error?.message).toBe("fetch failed")
    expect(status).toBe(0)

    // The write must not have landed.
    expect(supabase._tables.posts).toEqual([])
  })

  it("consumes a once error, so the retry succeeds", async () => {
    const supabase = createMockSupabase({ posts: [{ id: 1 }] })

    supabase._setError("posts", "select", { message: "flaky" }, { once: true })

    const first = await supabase.from("posts").select("*")

    expect(first.error?.message).toBe("flaky")

    const second = await supabase.from("posts").select("*")

    expect(second.error).toBeNull()
    expect(second.data).toHaveLength(1)
  })

  it("keeps a persistent error until it is cleared", async () => {
    const supabase = createMockSupabase({ posts: [{ id: 1 }] })

    supabase._setError("posts", "select", { message: "down" })

    expect((await supabase.from("posts").select("*")).error?.message).toBe("down")
    expect((await supabase.from("posts").select("*")).error?.message).toBe("down")

    supabase._clearErrors()
    expect((await supabase.from("posts").select("*")).error).toBeNull()
  })
})

describe("mockSupabase write responses", () => {
  it("reports PGRST116 when an ignoreDuplicates upsert wrote nothing", async () => {
    const supabase = createMockSupabase({ posts: [{ id: 1, title: "kept" }] })

    const { data, error } = await supabase
      .from("posts")
      .upsert({ id: 1, title: "ignored" }, { ignoreDuplicates: true })
      .select("*")
      .single()

    expect(data).toBeNull()
    expect(error?.code).toBe("PGRST116")

    // The conflicting row was left exactly as it was.
    expect((supabase._tables.posts as any[])[0].title).toBe("kept")
  })

  it("still replaces on conflict when ignoreDuplicates is absent", async () => {
    const supabase = createMockSupabase({ posts: [{ id: 1, title: "old" }] })

    const { data, error } = await supabase.from("posts").upsert({ id: 1, title: "new" }).select("*").single()

    expect(error).toBeNull()
    expect(data.title).toBe("new")
  })

  it("carries a status on a successful write", async () => {
    const supabase = createMockSupabase({ posts: [] })
    const { status } = await supabase.from("posts").insert({ title: "x" }).select("*").single()

    expect(status).toBe(201)
  })

  it("returns the count without a body for head: true", async () => {
    const supabase = createMockSupabase({ posts: [{ id: 1 }, { id: 2 }] })
    const { count, data } = await supabase.from("posts").select("*", { count: "exact", head: true })

    expect(data).toBeNull()
    expect(count).toBe(2)
  })
})

describe("mockSupabase realtime channels", () => {
  it("delivers a postgres_changes payload to the matching binding only", async () => {
    const supabase = createMockSupabase()
    const inserts: any[] = []
    const deletes: any[] = []

    const channel = supabase.channel("anchor:public:posts")

    channel.on("postgres_changes", { event: "INSERT", table: "posts" }, (p: any) => inserts.push(p))
    channel.on("postgres_changes", { event: "DELETE", table: "posts" }, (p: any) => deletes.push(p))
    channel.subscribe()

    channel._fireEvent("postgres_changes", { eventType: "INSERT", new: { id: 1 } })

    expect(inserts).toHaveLength(1)
    expect(deletes).toEqual([])
  })

  it("reports subscribe status, including one the manager must not call connecting", () => {
    const supabase = createMockSupabase()
    const seen: string[] = []
    const channel = supabase.channel("t")

    channel.subscribe((status: string) => seen.push(status))

    channel._fireStatus("TIMED_OUT")
    expect(seen).toEqual(["SUBSCRIBED", "TIMED_OUT"])
  })

  it("records what was broadcast, so a fire-and-forget send is observable", async () => {
    const supabase = createMockSupabase()
    const channel = supabase.channel("sync")

    await channel.send({ event: "sync", payload: { a: 1 }, type: "broadcast" })

    expect(channel._sent).toEqual([{ event: "sync", payload: { a: 1 }, type: "broadcast" }])
  })

  it("tracks and untracks presence state", async () => {
    const supabase = createMockSupabase()
    const channel = supabase.channel("room")

    await channel.track({ user: "u1" })
    expect(channel.presenceState().room[0]).toMatchObject({ user: "u1" })

    await channel.untrack()
    expect(channel.presenceState()).toEqual({})
  })

  it("keeps channels per client, so one test cannot see another's", () => {
    const a = createMockSupabase()
    const b = createMockSupabase()

    a.channel("one")

    expect(a.getChannels()).toHaveLength(1)
    expect(b.getChannels()).toHaveLength(0)
  })

  it("drops a channel on removeChannel", () => {
    const supabase = createMockSupabase()
    const channel = supabase.channel("one")

    supabase.removeChannel(channel)
    expect(supabase.getChannels()).toHaveLength(0)
  })
})

describe("mockSupabase injected failures accept the whole chain", () => {
  // The failed builder first shipped implementing only the handful of methods
  // one test happened to use. A method it lacks throws
  // `TypeError: builder.gt is not a function`, and the caller sees that instead
  // of the error under test — the mock answering something other than what was
  // asked, which is the failure this file exists to prevent.

  it("injects on a write filtered by something other than eq", async () => {
    const supabase = createMockSupabase({ posts: [{ id: 1, views: 30 }] })

    supabase._setError("posts", "update", { code: "42501", message: "denied" })

    const { error } = await supabase.from("posts").update({ views: 0 }).gt("views", 10).select("*")

    expect(error?.code).toBe("42501")
  })

  it.each([
    "gte", "lt", "lte", "like", "ilike", "is", "contains", "containedBy",
    "overlaps", "not", "or", "filter", "order", "limit", "range",
  ])("survives a chained .%s()", async (method) => {
    const supabase = createMockSupabase({ posts: [{ id: 1 }] })

    supabase._setError("posts", "delete", { code: "42501", message: "denied" })

    const builder: any = supabase.from("posts").delete()
    const { error } = await builder[method]("views", 1)

    expect(error?.code).toBe("42501")
  })
})
