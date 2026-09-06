import type { PersistenceAdapter } from "@drakkar.software/anchor/persistence"

interface SQLiteModule {
  openDatabaseSync: (name: string) => any
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
  private readonly db: any // SQLiteDatabase

  constructor(SQLite: SQLiteModule, databaseName = "anchor") {
    this.db = SQLite.openDatabaseSync(databaseName)
    this.db.execSync(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)",
    )
  }

  async getItem<T>(key: string): Promise<T | null> {
    const row = this.db.getFirstSync(
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
      ? this.db.getAllSync("SELECT key FROM kv WHERE key LIKE ?", [
          `${prefix}%`,
        ])
      : this.db.getAllSync("SELECT key FROM kv")

    return rows.map((r: any) => r.key as string)
  }

  async clear(): Promise<void> {
    this.db.runSync("DELETE FROM kv WHERE key LIKE 'anchor:%'")
  }
}
