// @vitest-environment jsdom

import { afterEach,beforeEach, describe, expect, it, vi } from "vitest"

import { LocalStorageAdapter } from "./localStorageAdapter.js"

/**
 * The first test in this package. `adapter-web` had none, and no `test` script
 * to run them with, so nothing here was ever exercised.
 */
describe("LocalStorageAdapter", () => {
  let adapter: LocalStorageAdapter

  beforeEach(() => {
    localStorage.clear()
    adapter = new LocalStorageAdapter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("round-trips a value through JSON", async () => {
    await adapter.setItem("anchor:todos", [{ id: 1, title: "a" }])
    expect(await adapter.getItem("anchor:todos")).toEqual([{ id: 1, title: "a" }])
  })

  it("returns null for a key that was never set", async () => {
    expect(await adapter.getItem("anchor:missing")).toBeNull()
  })

  it("returns null rather than throwing when the stored value is not JSON", async () => {
    localStorage.setItem("anchor:corrupt", "{not json")

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(await adapter.getItem("anchor:corrupt")).toBeNull()

    // A silent null would be indistinguishable from an empty store.
    expect(warn).toHaveBeenCalledOnce()
  })

  it("removes a single key and leaves the rest", async () => {
    await adapter.setItem("anchor:a", 1)
    await adapter.setItem("anchor:b", 2)

    await adapter.removeItem("anchor:a")

    expect(await adapter.getItem("anchor:a")).toBeNull()
    expect(await adapter.getItem("anchor:b")).toBe(2)
  })

  it("writes every entry of a multiSet", async () => {
    await adapter.multiSet([
      ["anchor:a", 1],
      ["anchor:b", { nested: true }],
    ])

    expect(await adapter.getItem("anchor:a")).toBe(1)
    expect(await adapter.getItem("anchor:b")).toEqual({ nested: true })
  })

  it("filters keys by prefix, and returns all of them without one", async () => {
    await adapter.setItem("anchor:a", 1)
    localStorage.setItem("other:b", "2")

    expect(await adapter.keys("anchor:")).toEqual(["anchor:a"])
    expect((await adapter.keys()).sort()).toEqual(["anchor:a", "other:b"])
  })

  it("clear() removes only the anchor-prefixed keys", async () => {
    await adapter.setItem("anchor:a", 1)
    localStorage.setItem("session-token", "keep me")

    await adapter.clear()

    expect(await adapter.getItem("anchor:a")).toBeNull()

    // The paired positive: a clear that wiped everything would also pass the
    // assertion above, and would sign the user out.
    expect(localStorage.getItem("session-token")).toBe("keep me")
  })

  it("throws a quota message naming the key when the write is rejected", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("exceeded the quota", "QuotaExceededError")
    })

    await expect(adapter.setItem("anchor:big", [1, 2, 3])).rejects.toThrow(
      /anchor:big.*IndexedDBAdapter/sv,
    )
  })
})
