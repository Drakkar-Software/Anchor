import { describe, expect, it, vi } from "vitest"

import { ExpoSqliteAdapter } from "./expoSqliteAdapter.js"

function createMockSQLite() {
  const db = {
    execSync: vi.fn(),
    runSync: vi.fn(),
    getFirstSync: vi.fn().mockReturnValue(null),
    getAllSync: vi.fn().mockReturnValue([]),
    withTransactionSync: vi.fn((task: () => void) => task()),
  }

  return {
    module: { openDatabaseSync: vi.fn().mockReturnValue(db) },
    db,
  }
}

describe("ExpoSqliteAdapter", () => {
  describe("getItem", () => {
    it("parses the stored JSON value of the first matching row", async () => {
      const { module, db } = createMockSQLite()

      db.getFirstSync.mockReturnValueOnce({ value: JSON.stringify({ count: 2 }) })

      const adapter = new ExpoSqliteAdapter(module, "test-db")

      await expect(adapter.getItem<{ count: number }>("anchor:t:1")).resolves.toEqual({
        count: 2,
      })
      expect(db.getFirstSync).toHaveBeenCalledWith(
        "SELECT value FROM kv WHERE key = ?",
        ["anchor:t:1"],
      )
    })

    it("returns null when no row matches", async () => {
      const { module } = createMockSQLite()
      const adapter = new ExpoSqliteAdapter(module, "test-db")

      await expect(adapter.getItem("missing")).resolves.toBeNull()
    })
  })

  describe("keys", () => {
    it("maps the key column of every row for a prefix query", async () => {
      const { module, db } = createMockSQLite()

      db.getAllSync.mockReturnValueOnce([{ key: "anchor:a" }, { key: "anchor:b" }])

      const adapter = new ExpoSqliteAdapter(module, "test-db")

      await expect(adapter.keys("anchor:")).resolves.toEqual(["anchor:a", "anchor:b"])
      expect(db.getAllSync).toHaveBeenCalledWith("SELECT key FROM kv WHERE key LIKE ?", [
        "anchor:%",
      ])
    })

    it("lists every key when no prefix is given", async () => {
      const { module, db } = createMockSQLite()

      db.getAllSync.mockReturnValueOnce([{ key: "x" }])

      const adapter = new ExpoSqliteAdapter(module, "test-db")

      await expect(adapter.keys()).resolves.toEqual(["x"])
      expect(db.getAllSync).toHaveBeenCalledWith("SELECT key FROM kv", [])
    })
  })
})
