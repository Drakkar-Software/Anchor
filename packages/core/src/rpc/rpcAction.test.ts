import { describe, it, expect, vi, beforeEach } from "vitest"
import { callRpc, createRpcAction, createSchemaRpc, invalidateRpcCache } from "./rpcAction.js"

function createMockSupabase(rpcResult: { data: any; error: any }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as any
}

describe("callRpc", () => {
  it("calls supabase.rpc with function name and args", async () => {
    const supabase = createMockSupabase({
      data: { count: 42, avg: 3.5 },
      error: null,
    })

    const result = await callRpc<{ count: number; avg: number }>(
      supabase,
      "get_stats",
      { user_id: "123" },
    )

    expect(supabase.rpc).toHaveBeenCalledWith("get_stats", { user_id: "123" })
    expect(result.data).toEqual({ count: 42, avg: 3.5 })
    expect(result.error).toBeNull()
  })

  it("returns error on failure", async () => {
    const supabase = createMockSupabase({
      data: null,
      error: { message: "Function not found" },
    })

    const result = await callRpc(supabase, "nonexistent")

    expect(result.data).toBeNull()
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error!.message).toBe("Function not found")
  })

  it("works without args", async () => {
    const supabase = createMockSupabase({
      data: [1, 2, 3],
      error: null,
    })

    const result = await callRpc(supabase, "get_all")

    expect(supabase.rpc).toHaveBeenCalledWith("get_all", undefined)
    expect(result.data).toEqual([1, 2, 3])
  })
})

describe("createRpcAction", () => {
  it("creates a reusable action function", async () => {
    const supabase = createMockSupabase({
      data: { total: 100 },
      error: null,
    })

    const getTotal = createRpcAction<{ total: number }>(supabase, "get_total")
    const result = await getTotal({ category: "books" })

    expect(supabase.rpc).toHaveBeenCalledWith("get_total", { category: "books" })
    expect(result.data).toEqual({ total: 100 })
  })

  it("can be called multiple times", async () => {
    const supabase = createMockSupabase({
      data: "ok",
      error: null,
    })

    const action = createRpcAction(supabase, "ping")
    await action()
    await action()

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })
})

describe("RPC caching", () => {
  beforeEach(() => {
    invalidateRpcCache()
  })

  it("caches results within TTL", async () => {
    const supabase = createMockSupabase({ data: 42, error: null })

    await callRpc(supabase, "get_count", undefined, { cache: { ttlMs: 5000 } })
    await callRpc(supabase, "get_count", undefined, { cache: { ttlMs: 5000 } })

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it("deduplicates in-flight requests", async () => {
    let resolveRpc: (val: any) => void
    const supabase = {
      rpc: vi.fn().mockReturnValue(new Promise(r => { resolveRpc = r })),
    } as any

    const p1 = callRpc(supabase, "slow_fn", undefined, { cache: { ttlMs: 5000 } })
    const p2 = callRpc(supabase, "slow_fn", undefined, { cache: { ttlMs: 5000 } })

    resolveRpc!({ data: "done", error: null })
    const [r1, r2] = await Promise.all([p1, p2])

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(r1.data).toBe("done")
    expect(r2.data).toBe("done")
  })

  it("invalidateRpcCache clears specific function cache", async () => {
    const supabase = createMockSupabase({ data: 1, error: null })

    await callRpc(supabase, "fn_a", undefined, { cache: { ttlMs: 5000 } })
    invalidateRpcCache("fn_a")
    await callRpc(supabase, "fn_a", undefined, { cache: { ttlMs: 5000 } })

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it("does not cache errors", async () => {
    const supabase = createMockSupabase({ data: null, error: { message: "fail" } })

    await callRpc(supabase, "bad_fn", undefined, { cache: { ttlMs: 5000 } })
    await callRpc(supabase, "bad_fn", undefined, { cache: { ttlMs: 5000 } })

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })
})

/**
 * The name, the arguments and the return type come from the generated
 * `Database` here rather than from the call site. The type half of that is
 * asserted in `types.check.ts`, which `tsc` reads; this covers the runtime,
 * which is `callRpc` with nothing added.
 */
describe("createSchemaRpc", () => {
  type DB = {
    public: {
      Tables: Record<string, never>
      Functions: {
        record_consent: {
          Args: { p_kind: string; p_granted: boolean }
          Returns: string
        }
        current_day: { Args: Record<string, never>; Returns: number }
      }
    }
  }

  it("forwards the name and args to supabase.rpc", async () => {
    const supabase = createMockSupabase({ data: "consent-1", error: null })
    const rpc = createSchemaRpc<DB>(supabase)

    const result = await rpc("record_consent", { p_kind: "care", p_granted: true })

    expect(supabase.rpc).toHaveBeenCalledWith("record_consent", {
      p_kind: "care",
      p_granted: true,
    })
    expect(result.data).toBe("consent-1")
    expect(result.error).toBeNull()
  })

  it("carries the same structured error as callRpc", async () => {
    const supabase = createMockSupabase({
      data: null,
      error: { message: "permission denied for function", code: "42501" },
    })
    const rpc = createSchemaRpc<DB>(supabase)

    const result = await rpc("current_day")

    expect(result.data).toBeNull()
    expect((result.error as { code?: string })?.code).toBe("42501")
  })

  it("takes a no-argument function without inventing an empty object", async () => {
    const supabase = createMockSupabase({ data: 8, error: null })
    const rpc = createSchemaRpc<DB>(supabase)

    await rpc("current_day")
    expect(supabase.rpc).toHaveBeenCalledWith("current_day", undefined)
  })
})
