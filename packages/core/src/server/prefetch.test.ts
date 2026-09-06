import { describe, expect,it } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { deserializePrefetchResult,prefetch, serializePrefetchResult } from "./prefetch.js"

describe("prefetch", () => {
  it("fetches data from supabase", async () => {
    const supabase = createMockSupabase({
      todos: [
        { created_at: "2024-01-01", id: 1, title: "A" },
        { created_at: "2024-01-02", id: 2, title: "B" },
      ],
    })

    const result = await prefetch(supabase, "todos")

    expect(result.data).toHaveLength(2)
    expect(result.error).toBeNull()
    expect(result.fetchedAt).toBeTypeOf("number")
  })

  it("returns empty data and error on failure", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          then: (resolve: any) => resolve({ data: null, error: { message: "Table not found" } }),
        }),
      }),
    } as any

    const result = await prefetch(supabase, "nonexistent")

    expect(result.data).toEqual([])
    expect(result.error).not.toBeNull()
  })
})

describe("serialize/deserialize", () => {
  it("round-trips data correctly", () => {
    const original = {
      data: [{ id: 1, title: "Test" }],
      error: null,
      fetchedAt: 1_700_000_000_000,
    }

    const serialized = serializePrefetchResult(original)
    const deserialized = deserializePrefetchResult<{ id: number; title: string }>(serialized)

    expect(deserialized.data).toEqual(original.data)
    expect(deserialized.error).toBeNull()
    expect(deserialized.fetchedAt).toBe(1_700_000_000_000)
  })

  it("round-trips error correctly", () => {
    const original = {
      data: [],
      error: new Error("Server error"),
      fetchedAt: 1_700_000_000_000,
    }

    const serialized = serializePrefetchResult(original)
    const deserialized = deserializePrefetchResult(serialized)

    expect(deserialized.data).toEqual([])
    expect(deserialized.error!.message).toBe("Server error")
  })

  it("handles malformed JSON gracefully", () => {
    const result = deserializePrefetchResult("not valid json {{{")

    expect(result.data).toEqual([])
    expect(result.error!.message).toContain("invalid JSON")
  })
})

describe("prefetch error routing", () => {
  it("carries the Postgres code, so an RSC can tell RLS from a bad query", async () => {
    const supabase = createMockSupabase({ todos: [{ id: 1, title: "A" }] })

    supabase._setError("todos", "select", {
      code: "42501",
      message: "permission denied for table todos",
    })

    const result = await prefetch(supabase, "todos")

    expect(result.data).toEqual([])
    expect((result.error as { code?: string } | null)?.code).toBe("42501")
  })

  it("returns rows and no error on the happy path", async () => {
    const supabase = createMockSupabase({ todos: [{ id: 1, title: "A" }] })
    const result = await prefetch(supabase, "todos")

    expect(result.error).toBeNull()
    expect(result.data).toHaveLength(1)
  })
})
