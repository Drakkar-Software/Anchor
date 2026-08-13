import { describe, it, expect, vi } from "vitest"
import { invokeEdgeFunction, createEdgeFunctionAction } from "./edgeFunctions.js"

function mockSupabase(result: { data: any; error: any }) {
  return {
    functions: {
      invoke: vi.fn().mockResolvedValue(result),
    },
  } as any
}

describe("invokeEdgeFunction", () => {
  it("invokes a function and returns data", async () => {
    const supabase = mockSupabase({ data: { sent: true }, error: null })
    const result = await invokeEdgeFunction<{ sent: boolean }>(
      supabase, "send-email", { body: { to: "a@b.com" } },
    )
    expect(result.data).toEqual({ sent: true })
    expect(result.error).toBeNull()
    expect(supabase.functions.invoke).toHaveBeenCalledWith("send-email", {
      body: { to: "a@b.com" },
      headers: undefined,
      method: undefined,
    })
  })

  it("returns error on failure", async () => {
    const supabase = mockSupabase({ data: null, error: { message: "Not found" } })
    const result = await invokeEdgeFunction(supabase, "missing-fn")
    expect(result.data).toBeNull()
    expect(result.error!.message).toBe("Not found")
  })

  it("catches thrown exceptions", async () => {
    const supabase = {
      functions: { invoke: vi.fn().mockRejectedValue(new Error("Network error")) },
    } as any
    const result = await invokeEdgeFunction(supabase, "fn")
    expect(result.error!.message).toBe("Network error")
  })
})

describe("createEdgeFunctionAction", () => {
  it("creates reusable action", async () => {
    const supabase = mockSupabase({ data: "ok", error: null })
    const action = createEdgeFunctionAction<string>(supabase, "ping")

    const r1 = await action()
    const r2 = await action({ body: { test: true } })

    expect(r1.data).toBe("ok")
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(2)
  })
})

describe("invokeEdgeFunction error fidelity", () => {
  // `new Error(error.message)` collapsed three distinct failures into one and
  // discarded `FunctionsHttpError.context` — the Response carrying the real
  // status and the body the function itself wrote. `error.message` on an HTTP
  // error is only ever the generic "Edge Function returned a non-2xx status
  // code", so the diagnosis lived entirely in what was thrown away.

  it("keeps the status and the function's own body from FunctionsHttpError", async () => {
    const supabase = mockSupabase({
      data: null,
      error: {
        name: "FunctionsHttpError",
        message: "Edge Function returned a non-2xx status code",
        context: new Response(JSON.stringify({ reason: "quota exceeded" }), { status: 429 }),
      },
    })

    const { error } = await invokeEdgeFunction(supabase, "send-email")

    expect((error as { status?: number }).status).toBe(429)
    expect((error as { details?: string }).details).toContain("quota exceeded")
  })

  it("tells a function that ran apart from one that was never reached", async () => {
    const http = await invokeEdgeFunction(
      mockSupabase({
        data: null,
        error: { name: "FunctionsHttpError", message: "non-2xx", context: new Response("", { status: 500 }) },
      }),
      "fn",
    )
    const fetchFailed = await invokeEdgeFunction(
      mockSupabase({ data: null, error: { name: "FunctionsFetchError", message: "Failed to send a request" } }),
      "fn",
    )
    const relay = await invokeEdgeFunction(
      mockSupabase({ data: null, error: { name: "FunctionsRelayError", message: "Relay error" } }),
      "fn",
    )

    // The distinction decides whether retrying is sensible at all.
    expect((http.error as { code?: string }).code).toBe("FunctionsHttpError")
    expect((fetchFailed.error as { code?: string }).code).toBe("FunctionsFetchError")
    expect((relay.error as { code?: string }).code).toBe("FunctionsRelayError")
    // Only the one that reached the function has a status.
    expect((http.error as { status?: number }).status).toBe(500)
    expect((fetchFailed.error as { status?: number }).status).toBeUndefined()
  })

  it("leaves the caller's own copy of the response body unread", async () => {
    const context = new Response("boom", { status: 400 })
    const supabase = mockSupabase({
      data: null,
      error: { name: "FunctionsHttpError", message: "non-2xx", context },
    })

    await invokeEdgeFunction(supabase, "fn")

    // Read via clone(), so a caller reaching for context.text() still can.
    expect(context.bodyUsed).toBe(false)
    expect(await context.text()).toBe("boom")
  })

  it("survives a body that cannot be read, keeping the status", async () => {
    const context = { status: 503, clone: () => { throw new Error("unreadable") } }
    const supabase = mockSupabase({
      data: null,
      error: { name: "FunctionsHttpError", message: "non-2xx", context },
    })

    const { error } = await invokeEdgeFunction(supabase, "fn")

    expect((error as { status?: number }).status).toBe(503)
    expect((error as { details?: string }).details).toBeUndefined()
  })

  it("still reports the message, so existing callers reading it are unaffected", async () => {
    const supabase = mockSupabase({ data: null, error: { message: "Not found" } })
    const { error } = await invokeEdgeFunction(supabase, "missing-fn")
    expect(error!.message).toBe("Not found")
  })
})
