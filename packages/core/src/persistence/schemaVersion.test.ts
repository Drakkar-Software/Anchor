import { beforeEach,describe, expect, it } from "vitest"

import { MemoryAdapter } from "./persistenceAdapter.js"
import { checkSchemaVersion, getSchemaVersion, setSchemaVersion } from "./schemaVersion.js"

describe("schemaVersion", () => {
  let adapter: MemoryAdapter

  beforeEach(() => {
    adapter = new MemoryAdapter()
  })

  describe("checkSchemaVersion", () => {
    it("returns no change on first run and stores version", async () => {
      const result = await checkSchemaVersion(adapter, 1)

      expect(result.versionChanged).toBe(true)
      expect(result.previousVersion).toBeNull()
      expect(await getSchemaVersion(adapter)).toBe(1)
    })

    it("returns no change when version matches", async () => {
      await setSchemaVersion(adapter, 2)

      const result = await checkSchemaVersion(adapter, 2)

      expect(result.versionChanged).toBe(false)
      expect(result.previousVersion).toBe(2)
    })

    it("clears cache and updates version on mismatch", async () => {
      await setSchemaVersion(adapter, 1)
      await adapter.setItem("anchor:public:todos", [{ id: 1, title: "Test" }])
      await adapter.setItem("anchor:public:profiles", [{ id: 1 }])
      await adapter.setItem("anchor:__mutation_queue", [{ id: "m1" }])

      const result = await checkSchemaVersion(adapter, 2)

      expect(result.versionChanged).toBe(true)
      expect(result.previousVersion).toBe(1)

      // Cache should be cleared
      expect(await adapter.getItem("anchor:public:todos")).toBeNull()
      expect(await adapter.getItem("anchor:public:profiles")).toBeNull()
      expect(await adapter.getItem("anchor:__mutation_queue")).toBeNull()

      // Version should be updated
      expect(await getSchemaVersion(adapter)).toBe(2)
    })

    it("preserves schema version key during clear", async () => {
      await setSchemaVersion(adapter, 1)
      await adapter.setItem("anchor:public:todos", [])

      await checkSchemaVersion(adapter, 2)

      // Version key should be the new version, not cleared
      expect(await getSchemaVersion(adapter)).toBe(2)
    })

    it("handles version downgrade", async () => {
      await setSchemaVersion(adapter, 5)
      await adapter.setItem("anchor:public:todos", [{ id: 1 }])

      const result = await checkSchemaVersion(adapter, 3)

      expect(result.versionChanged).toBe(true)
      expect(result.previousVersion).toBe(5)
      expect(await adapter.getItem("anchor:public:todos")).toBeNull()
    })
  })

  describe("getSchemaVersion", () => {
    it("returns null when no version stored", async () => {
      expect(await getSchemaVersion(adapter)).toBeNull()
    })

    it("returns stored version", async () => {
      await setSchemaVersion(adapter, 42)
      expect(await getSchemaVersion(adapter)).toBe(42)
    })
  })

  describe("setSchemaVersion", () => {
    it("stores the version without clearing cache", async () => {
      await adapter.setItem("anchor:public:todos", [{ id: 1 }])
      await setSchemaVersion(adapter, 5)

      expect(await getSchemaVersion(adapter)).toBe(5)

      // Data should not be cleared
      expect(await adapter.getItem("anchor:public:todos")).toEqual([{ id: 1 }])
    })
  })
})
