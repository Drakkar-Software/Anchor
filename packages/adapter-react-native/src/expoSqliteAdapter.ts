import type { PersistenceAdapter } from "@drakkar.software/anchor/persistence"

type SQLiteBindValue = string | number | null | boolean | Uint8Array

interface SQLiteDatabase {
  execSync: (source: string) => void
  runSync: (source: string, params: SQLiteBindValue[]) => unknown
  getFirstSync: <T = Record<string, unknown>>(source: string, params: SQLiteBindValue[]) => T | null
  getAllSync: <T = Record<string, unknown>>(source: string, params: SQLiteBindValue[]) => T[]
  withTransactionSync: (task: () => void) => void
}

interface SQLiteModule {
  openDatabaseSync: (name: string) => SQLiteDatabase
}

/**
 * React Native persistence adapter using expo-sqlite.
 * Stores data as JSON in a key-value table.
 *
 * Pass the expo-sqlite module as the first argument to avoid bundler
 * resolution issues in pnpm virtual store environments.
 *
 * @example
 * import * as SQLite from 'expo-sqlite'
 * new ExpoSqliteAdapter(SQLite, 'anchor-kv')
 */
export class ExpoSqliteAdapter implements PersistenceAdapter {
  private readonly db: SQLiteDatabase

  constructor(SQLite: SQLiteModule, databaseName = "anchor") {
    this.db = SQLite.openDatabaseSync(databaseName)
    this.db.execSync(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)",
    )
  }

  async getItem<T>(key: string): Promise<T | null> {
    const row = this.db.getFirstSync<{ value?: string | null }>(
      "SELECT value FROM kv WHERE key = ?",
      [key],
    )

    if (!row?.value) {return null}

    try {
      return JSON.parse(row.value) as T
    } catch (error) {
      console.warn(`[anchor:expoSqlite] Failed to parse data for key "${key}":`, error)

      return null
    }
  }

  async setItem<T>(key: string, value: T): Promise<void> {
    this.db.runSync(
      "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
      [key, JSON.stringify(value)],
    )
  }

  async removeItem(key: string): Promise<void> {
    this.db.runSync("DELETE FROM kv WHERE key = ?", [key])
  }

  async multiSet(entries: [string, unknown][]): Promise<void> {
    this.db.withTransactionSync(() => {
      for (const [key, value] of entries) {
        this.db.runSync(
          "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
          [key, JSON.stringify(value)],
        )
      }
    })
  }

  async keys(prefix?: string): Promise<string[]> {
    const rows = prefix
      ? this.db.getAllSync<{ key: string }>("SELECT key FROM kv WHERE key LIKE ?", [
          `${prefix}%`,
        ])
      : this.db.getAllSync<{ key: string }>("SELECT key FROM kv", [])

    return rows.map((r) => r.key)
  }

  async clear(): Promise<void> {
    this.db.runSync("DELETE FROM kv WHERE key LIKE 'anchor:%'", [])
  }
}
