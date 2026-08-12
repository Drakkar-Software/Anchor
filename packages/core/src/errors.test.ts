import { describe, it, expect } from "vitest"
import {
  AnchorError,
  fromSupabaseError,
  PG_INSUFFICIENT_PRIVILEGE,
  PG_UNIQUE_VIOLATION,
} from "./errors.js"
import { isRlsError } from "./auth/authGate.js"
import { createMockSupabase } from "./__tests__/mockSupabase.js"
import { executeQueryOne } from "./query/queryExecutor.js"
import { createTableStore } from "./createTableStore.js"

describe("AnchorError", () => {
  it("is an Error, so every existing catch and instanceof keeps working", () => {
    const e = new AnchorError("nope", { code: PG_UNIQUE_VIOLATION })
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe("nope")
    expect(e.name).toBe("AnchorError")
  })

  it("carries code, details and hint", () => {
    const e = new AnchorError("denied", {
      code: PG_INSUFFICIENT_PRIVILEGE,
      details: "row-level security",
      hint: "check the policy",
      status: 403,
    })
    expect(e.code).toBe("42501")
    expect(e.details).toBe("row-level security")
    expect(e.hint).toBe("check the policy")
    expect(e.status).toBe(403)
  })
})

describe("fromSupabaseError", () => {
  it("keeps the structured fields a bare Error would have dropped", () => {
    const e = fromSupabaseError({
      message: "duplicate key value violates unique constraint",
      code: "23505",
      details: "Key (email)=(a@b.c) already exists.",
      hint: null,
    })
    expect(e.message).toBe("duplicate key value violates unique constraint")
    expect(e.code).toBe("23505")
    expect(e.details).toBe("Key (email)=(a@b.c) already exists.")
    // `hint: null` is not a string, so it stays undefined rather than "null".
    expect(e.hint).toBeUndefined()
  })

  it("passes an AnchorError through, so a double wrap does not nest", () => {
    const original = new AnchorError("denied", { code: "42501" })
    expect(fromSupabaseError(original)).toBe(original)
  })

  it("falls back for a string and for a shapeless value", () => {
    expect(fromSupabaseError("boom").message).toBe("boom")
    expect(fromSupabaseError(undefined, "fallback").message).toBe("fallback")
    expect(fromSupabaseError({}).code).toBeUndefined()
  })
})

describe("isRlsError", () => {
  it("reads the code rather than the message text", () => {
    // No RLS wording anywhere in the message — only the code says so.
    const e = new AnchorError("request failed", { code: PG_INSUFFICIENT_PRIVILEGE })
    expect(isRlsError(e)).toBe(true)
  })

  it("still matches a foreign error by message, since not every error is ours", () => {
    expect(isRlsError(new Error("new row violates row-level security policy"))).toBe(true)
    expect(isRlsError(new Error("permission denied for table todos"))).toBe(true)
  })

  it("does not fire on an unrelated error", () => {
    expect(isRlsError(new AnchorError("duplicate key", { code: PG_UNIQUE_VIOLATION }))).toBe(false)
    expect(isRlsError(null)).toBe(false)
  })
})

/**
 * The mutation boundary is the one that matters to a consumer: a store write
 * refused by RLS and a store write refused by a unique constraint are the same
 * `Error` until the code survives. Both the thrown error and the one left in
 * store state are asserted, because `createTableStore` builds them separately.
 */
describe("the mutation boundary preserves the code", () => {
  function failingSupabase(error: Record<string, unknown>) {
    const result = { then: (resolve: (v: unknown) => void) => resolve({ data: null, error }) }
    return {
      from() {
        return { insert: () => ({ select: () => ({ single: () => result }) }) }
      },
    }
  }

  it("surfaces 42501 on the thrown error and in store state", async () => {
    const store = createTableStore<any, { title: string }, any, any>({
      supabase: failingSupabase({
        message: "new row violates row-level security policy for table \"todos\"",
        code: "42501",
        details: null,
        hint: null,
      }) as never,
      table: "todos",
    })

    const thrown = await store
      .getState()
      .insert({ title: "refused" })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(thrown).toBeInstanceOf(AnchorError)
    expect((thrown as AnchorError).code).toBe(PG_INSUFFICIENT_PRIVILEGE)
    expect(isRlsError(thrown as Error)).toBe(true)

    const stateError = store.getState().error
    expect((stateError as AnchorError | null)?.code).toBe(PG_INSUFFICIENT_PRIVILEGE)
  })

  it("distinguishes a unique violation from an RLS refusal", async () => {
    const store = createTableStore<any, { title: string }, any, any>({
      supabase: failingSupabase({
        message: "duplicate key value violates unique constraint \"todos_title_key\"",
        code: "23505",
      }) as never,
      table: "todos",
    })

    const thrown = await store
      .getState()
      .insert({ title: "dup" })
      .then(() => null)
      .catch((e: unknown) => e)

    expect((thrown as AnchorError).code).toBe(PG_UNIQUE_VIOLATION)
    expect(isRlsError(thrown as Error)).toBe(false)
  })
})

describe("the query boundary preserves the code", () => {
  it("hands PGRST116 through from a missing row", async () => {
    const supabase = createMockSupabase({ todos: [{ id: 1, title: "a" }] })
    // `.maybeSingle()` resolves `{data: null, error: null}` for a miss, so drive
    // the failing branch through the mock's `.single()` path instead.
    const { error } = await supabase.from("todos").select("*").eq("id", 999).single()
    const wrapped = fromSupabaseError(error)
    expect(wrapped.code).toBe("PGRST116")
  })

  it("returns a plain null error when the row is simply absent", async () => {
    const supabase = createMockSupabase({ todos: [{ id: 1, title: "a" }] })
    const { data, error } = await executeQueryOne<{ id: number }>(
      supabase as never,
      "todos",
      "id",
      999,
    )
    expect(data).toBeNull()
    expect(error).toBeNull()
  })
})
