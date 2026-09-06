import { describe, expect,it } from "vitest"

import { applyPkFilters, buildPkFilter, encodeKey, normalizePk } from "./compositeKey.js"

describe("encodeKey", () => {
  it("returns scalar value for single string PK", () => {
    expect(encodeKey({ id: 42, name: "test" }, "id")).toBe(42)
  })

  it("returns string value for single string PK", () => {
    expect(encodeKey({ id: "abc-123", name: "test" }, "id")).toBe("abc-123")
  })

  it("encodes composite key as JSON", () => {
    const result = encodeKey({ post_id: "p1", user_id: "u1" }, ["user_id", "post_id"])

    expect(result).toBe(JSON.stringify(["u1", "p1"]))
  })

  it("preserves numeric types in composite keys", () => {
    const result = encodeKey({ a: 1, b: 2 }, ["a", "b"])

    expect(result).toBe(JSON.stringify([1, 2]))
  })
})

describe("buildPkFilter", () => {
  it("builds single-key filter", () => {
    expect(buildPkFilter("id", 42)).toEqual({ id: 42 })
  })

  it("builds composite-key filter from JSON", () => {
    const encoded = JSON.stringify(["u1", "p1"])

    expect(buildPkFilter(["user_id", "post_id"], encoded)).toEqual({
      post_id: "p1",
      user_id: "u1",
    })
  })

  it("preserves numeric types in composite filter", () => {
    const encoded = JSON.stringify([1, 2])

    expect(buildPkFilter(["a", "b"], encoded)).toEqual({ a: 1, b: 2 })
  })
})

describe("applyPkFilters", () => {
  it("applies single eq for simple PK", () => {
    const calls: { col: string; val: unknown }[] = []
    const builder = {
      eq(col: string, val: unknown) {
        calls.push({ col, val })

        return builder
      },
    }

    applyPkFilters(builder, "id", 42)
    expect(calls).toEqual([{ col: "id", val: 42 }])
  })

  it("applies multiple eq for composite PK", () => {
    const calls: { col: string; val: unknown }[] = []
    const builder = {
      eq(col: string, val: unknown) {
        calls.push({ col, val })

        return builder
      },
    }

    const encoded = JSON.stringify(["u1", "p1"])

    applyPkFilters(builder, ["user_id", "post_id"], encoded)
    expect(calls).toEqual([
      { col: "user_id", val: "u1" },
      { col: "post_id", val: "p1" },
    ])
  })
})

describe("normalizePk", () => {
  it("wraps string in array", () => {
    expect(normalizePk("id")).toEqual(["id"])
  })

  it("returns array as-is", () => {
    expect(normalizePk(["a", "b"])).toEqual(["a", "b"])
  })
})
