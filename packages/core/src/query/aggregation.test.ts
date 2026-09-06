import { describe, expect,it } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { aggregateLocal, aggregateRpc } from "./aggregation.js"

describe("aggregateLocal", () => {
  const records = [
    { id: 1, name: "A", price: 10 },
    { id: 2, name: "B", price: 20 },
    { id: 3, name: "C", price: 30 },
  ]

  it("computes sum", () => {
    expect(aggregateLocal(records, "price", "sum")).toBe(60)
  })

  it("computes avg", () => {
    expect(aggregateLocal(records, "price", "avg")).toBe(20)
  })

  it("computes min", () => {
    expect(aggregateLocal(records, "price", "min")).toBe(10)
  })

  it("computes max", () => {
    expect(aggregateLocal(records, "price", "max")).toBe(30)
  })

  it("computes count", () => {
    expect(aggregateLocal(records, "price", "count")).toBe(3)
  })

  it("returns 0 count for empty array", () => {
    expect(aggregateLocal([], "price", "count")).toBe(0)
  })

  it("returns null for empty array with non-count fn", () => {
    expect(aggregateLocal([], "price", "sum")).toBeNull()
  })

  it("skips non-numeric values", () => {
    const mixed = [
      { id: 1, val: 10 },
      { id: 2, val: "hello" as any },
      { id: 3, val: 30 },
    ]

    expect(aggregateLocal(mixed, "val", "sum")).toBe(40)
  })

  it("returns null when all values are non-numeric", () => {
    const strings = [
      { id: 1, val: "a" as any },
      { id: 2, val: "b" as any },
    ]

    expect(aggregateLocal(strings, "val", "sum")).toBeNull()
  })
})

describe("aggregateRpc error routing", () => {
  it("carries the Postgres code rather than only the message", async () => {
    const supabase = createMockSupabase()

    supabase._setError("zs_sum_todos_amount", "rpc", {
      code: "42501",
      message: "permission denied for function",
    })

    const { data, error } = await aggregateRpc(supabase, "todos", "amount", "sum")

    expect(data).toBeNull()
    expect((error as { code?: string }).code).toBe("42501")
  })

  it("still returns the value when the function succeeds", async () => {
    const supabase = createMockSupabase()

    supabase._setRpc("zs_sum_todos_amount", () => 42)

    const { data, error } = await aggregateRpc(supabase, "todos", "amount", "sum")

    expect(error).toBeNull()
    expect(data).toBe(42)
  })
})
