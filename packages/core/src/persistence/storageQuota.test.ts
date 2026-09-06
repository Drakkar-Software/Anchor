import { beforeEach,describe, expect, it } from "vitest"

import { MemoryAdapter } from "./persistenceAdapter.js"
import { StorageQuotaManager } from "./storageQuota.js"

describe("StorageQuotaManager", () => {
  let adapter: MemoryAdapter
  let manager: StorageQuotaManager

  beforeEach(() => {
    adapter = new MemoryAdapter()
    manager = new StorageQuotaManager()
  })

  describe("getUsage", () => {
    it("returns zero for empty adapter", async () => {
      const usage = await manager.getUsage(adapter)

      expect(usage.count).toBe(0)
      expect(usage.estimatedBytes).toBe(0)
    })

    it("counts keys with zs: prefix", async () => {
      await adapter.setItem("anchor:public:todos", [{ id: 1 }])
      await adapter.setItem("anchor:public:profiles", [{ id: 2 }])
      await adapter.setItem("other:key", "not counted by default")

      const usage = await manager.getUsage(adapter)

      expect(usage.count).toBe(2)
      expect(usage.estimatedBytes).toBeGreaterThan(0)
    })

    it("uses custom prefix", async () => {
      await adapter.setItem("custom:a", 1)
      await adapter.setItem("custom:b", 2)
      await adapter.setItem("anchor:c", 3)

      const usage = await manager.getUsage(adapter, "custom:")

      expect(usage.count).toBe(2)
    })

    it("estimates bytes reasonably", async () => {
      const data = { id: 1, title: "Hello World" }

      await adapter.setItem("anchor:test", data)

      const usage = await manager.getUsage(adapter)
      const json = JSON.stringify(data)

      // Key + value, ~2 bytes per char
      const expected = ("anchor:test".length + json.length) * 2

      expect(usage.estimatedBytes).toBe(expected)
    })

    it("throws if adapter has no keys()", async () => {
      const minimal: any = {
        getItem: async () => null,
        removeItem: async () => {},
        setItem: async () => {},
      }

      await expect(manager.getUsage(minimal)).rejects.toThrow(
        "does not support keys()",
      )
    })
  })

  describe("setTableLimit / getTableLimit", () => {
    it("stores and retrieves limits", () => {
      manager.setTableLimit("todos", 100)
      expect(manager.getTableLimit("todos")).toBe(100)
    })

    it("returns undefined for unset tables", () => {
      expect(manager.getTableLimit("unknown")).toBeUndefined()
    })
  })

  describe("enforceLimit", () => {
    it("does nothing when no limit set", async () => {
      await adapter.setItem("anchor:public:todos", [{ id: 1 }, { id: 2 }])

      const removed = await manager.enforceLimit(adapter, "todos")

      expect(removed).toBe(0)
    })

    it("does nothing when under limit", async () => {
      manager.setTableLimit("todos", 5)
      await adapter.setItem("anchor:public:todos", [{ id: 1 }, { id: 2 }])

      const removed = await manager.enforceLimit(adapter, "todos")

      expect(removed).toBe(0)
    })

    it("trims to limit, keeping newest records", async () => {
      manager.setTableLimit("todos", 2)
      await adapter.setItem("anchor:public:todos", [
        { id: 1, title: "oldest" },
        { id: 2, title: "middle" },
        { id: 3, title: "newest" },
      ])

      const removed = await manager.enforceLimit(adapter, "todos")

      expect(removed).toBe(1)

      const remaining = await adapter.getItem<any[]>("anchor:public:todos")

      expect(remaining).toHaveLength(2)
      expect(remaining![0].id).toBe(2)
      expect(remaining![1].id).toBe(3)
    })

    it("handles custom schema", async () => {
      manager.setTableLimit("todos", 1)
      await adapter.setItem("anchor:custom:todos", [
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ])

      const removed = await manager.enforceLimit(adapter, "todos", "custom")

      expect(removed).toBe(2)

      const remaining = await adapter.getItem<any[]>("anchor:custom:todos")

      expect(remaining).toHaveLength(1)
      expect(remaining![0].id).toBe(3)
    })

    it("handles missing data", async () => {
      manager.setTableLimit("todos", 5)

      const removed = await manager.enforceLimit(adapter, "todos")

      expect(removed).toBe(0)
    })
  })

  describe("evictByCount", () => {
    it("does nothing when under maxRecords", async () => {
      await adapter.setItem("anchor:public:a", [1])
      await adapter.setItem("anchor:public:b", [2])

      const removed = await manager.evictByCount(adapter, { maxRecords: 5 })

      expect(removed).toBe(0)
    })

    it("removes oldest keys when over maxRecords", async () => {
      await adapter.setItem("anchor:public:a", [1])
      await adapter.setItem("anchor:public:b", [2])
      await adapter.setItem("anchor:public:c", [3])

      const removed = await manager.evictByCount(adapter, { maxRecords: 1 })

      expect(removed).toBe(2)

      const keys = await adapter.keys("anchor:public:")

      expect(keys).toHaveLength(1)
    })

    it("skips internal keys", async () => {
      await adapter.setItem("anchor:__schema_version", 1)
      await adapter.setItem("anchor:__mutation_queue", [])
      await adapter.setItem("anchor:__temp_id_map", [])
      await adapter.setItem("anchor:public:todos", [1])

      const removed = await manager.evictByCount(adapter, { maxRecords: 1 })

      expect(removed).toBe(0)

      // Internal keys should still exist
      expect(await adapter.getItem("anchor:__schema_version")).toBe(1)
    })

    it("returns 0 when maxRecords is undefined", async () => {
      await adapter.setItem("anchor:a", 1)

      const removed = await manager.evictByCount(adapter, {})

      expect(removed).toBe(0)
    })

    it("throws if adapter has no keys()", async () => {
      const minimal: any = {
        getItem: async () => null,
        removeItem: async () => {},
        setItem: async () => {},
      }

      await expect(
        manager.evictByCount(minimal, { maxRecords: 1 }),
      ).rejects.toThrow("does not support keys()")
    })
  })
})
