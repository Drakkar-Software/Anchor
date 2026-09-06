import type { PersistenceAdapter } from "@drakkar.software/anchor/persistence"

/**
 * Web localStorage adapter. Good for small datasets (<5MB).
 */
export class LocalStorageAdapter implements PersistenceAdapter {
  async getItem<T>(key: string): Promise<T | null> {
    try {
      const raw = localStorage.getItem(key)

      return raw ? (JSON.parse(raw) as T) : null
    } catch (error) {
      console.warn(`[anchor:localStorage] Failed to parse data for key "${key}":`, error)

      return null
    }
  }

  async setItem<T>(key: string, value: T): Promise<void> {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch (error) {
      throw new Error(
        `Failed to persist data for key "${key}": ${error instanceof Error ? error.message : String(error)}. Consider using IndexedDBAdapter for larger datasets.`,
      )
    }
  }

  async removeItem(key: string): Promise<void> {
    localStorage.removeItem(key)
  }

  async multiSet(entries: [string, unknown][]): Promise<void> {
    for (const [key, value] of entries) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch (error) {
        throw new Error(
          `Failed to persist data for key "${key}" during multiSet: ${error instanceof Error ? error.message : String(error)}. Consider using IndexedDBAdapter for larger datasets.`,
        )
      }
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    const allKeys: string[] = []

    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)

      if (key) {allKeys.push(key)}
    }

    if (!prefix) {return allKeys}

    return allKeys.filter((k) => k.startsWith(prefix))
  }

  async clear(): Promise<void> {
    const zsKeys = await this.keys("anchor:")

    for (const key of zsKeys) {
      localStorage.removeItem(key)
    }
  }
}
