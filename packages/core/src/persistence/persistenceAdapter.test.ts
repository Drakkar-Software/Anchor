import { describe, expect,it } from "vitest"

import { MemoryAdapter } from "./persistenceAdapter.js"

describe("MemoryAdapter", () => {
  it("stores and retrieves items", async () => {
    const adapter = new MemoryAdapter()

    await adapter.setItem("key1", { data: "hello" })

    const result = await adapter.getItem<{ data: string }>("key1")

    expect(result).toEqual({ data: "hello" })
  })

  it("returns null for missing keys", async () => {
    const adapter = new MemoryAdapter()
    const result = await adapter.getItem("nonexistent")

    expect(result).toBeNull()
  })

  it("removes items", async () => {
    const adapter = new MemoryAdapter()

    await adapter.setItem("key1", "value")
    await adapter.removeItem("key1")
    expect(await adapter.getItem("key1")).toBeNull()
  })

  it("multiSet writes multiple items atomically", async () => {
    const adapter = new MemoryAdapter()

    await adapter.multiSet([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ])
    expect(await adapter.getItem("a")).toBe(1)
    expect(await adapter.getItem("b")).toBe(2)
    expect(await adapter.getItem("c")).toBe(3)
  })

  it("keys returns all keys", async () => {
    const adapter = new MemoryAdapter()

    await adapter.setItem("anchor:todos", [])
    await adapter.setItem("anchor:profiles", [])
    await adapter.setItem("other", "x")

    const all = await adapter.keys()

    expect(all).toHaveLength(3)
  })

  it("keys with prefix filters results", async () => {
    const adapter = new MemoryAdapter()

    await adapter.setItem("anchor:todos", [])
    await adapter.setItem("anchor:profiles", [])
    await adapter.setItem("other", "x")

    const zsKeys = await adapter.keys("anchor:")

    expect(zsKeys).toHaveLength(2)
    expect(zsKeys).toContain("anchor:todos")
    expect(zsKeys).toContain("anchor:profiles")
  })

  it("clear removes all data", async () => {
    const adapter = new MemoryAdapter()

    await adapter.setItem("a", 1)
    await adapter.setItem("b", 2)
    await adapter.clear()

    expect(await adapter.getItem("a")).toBeNull()
    expect(await adapter.getItem("b")).toBeNull()
    expect(await adapter.keys()).toHaveLength(0)
  })

  it("overwrites existing values", async () => {
    const adapter = new MemoryAdapter()

    await adapter.setItem("key", "old")
    await adapter.setItem("key", "new")
    expect(await adapter.getItem("key")).toBe("new")
  })
})
