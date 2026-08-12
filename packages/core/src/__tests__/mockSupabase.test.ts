import { describe, it, expect } from "vitest"
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
      todos: [
        { id: 1, title: "a", secret: "hidden", owner_id: 7 },
        { id: 2, title: "b", secret: "hidden", owner_id: 7 },
      ],
      steps: [
        { id: 10, todo_id: 1, label: "step one" },
        { id: 11, todo_id: 1, label: "step two" },
        { id: 12, todo_id: 2, label: "other" },
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
    const { data, count } = await client()
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
      todos: [{ id: 1, title: "a", secret: "hidden" }],
    })
  }

  it("projects an insert's returned row", async () => {
    const { data } = await client().from("todos").insert({ title: "new", secret: "x" }).select("title")
    expect(data[0]).toEqual({ title: "new" })
    expect(data[0]).not.toHaveProperty("secret")
  })

  it("projects an insert through single()", async () => {
    const { data } = await client()
      .from("todos")
      .insert({ title: "new", secret: "x" })
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
    const { data } = await client().from("todos").insert({ title: "new", secret: "x" }).select("*")
    expect(data[0]).toHaveProperty("secret")
    expect(data[0]).toHaveProperty("id")
  })

  it("returns whole rows when a write does not call select at all", async () => {
    const { data } = await client().from("todos").insert({ title: "new", secret: "x" })
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
        { id: 1, title: "a", done: false },
        { id: 2, title: "b", done: false },
        { id: 3, title: "c", done: true },
        { id: 4, title: "d", done: false },
        { id: 5, title: "e", done: true },
      ],
    })
  }

  it("reports the full match count under a limit", async () => {
    const { data, count } = await client().from("todos").select("*", { count: "exact" }).limit(2)
    expect(data).toHaveLength(2)
    expect(count).toBe(5)
  })

  it("reports the full match count under a range", async () => {
    const { data, count } = await client().from("todos").select("*", { count: "exact" }).range(1, 2)
    expect(data).toHaveLength(2)
    expect(count).toBe(5)
  })

  it("counts only the rows the filters match", async () => {
    const { data, count } = await client()
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

    const { data, count } = await supabase.rpc("search", {})
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
