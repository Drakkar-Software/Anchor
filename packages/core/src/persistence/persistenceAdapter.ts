import type { PersistenceAdapter } from "../types.js"

export type { PersistenceAdapter }

/**
 * In-memory persistence adapter for testing.
 */
export class MemoryAdapter implements PersistenceAdapter {
  private readonly store = new Map<string, unknown>()

  async getItem<T>(key: string): Promise<T | null> {
    const value = this.store.get(key)

    return (value as T) ?? null
  }

  async setItem<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value)
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key)
  }

  async multiSet(entries: [string, unknown][]): Promise<void> {
    for (const [key, value] of entries) {
      this.store.set(key, value)
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    const allKeys = Array.from(this.store.keys())

    if (!prefix) {return allKeys}

    return allKeys.filter((k) => k.startsWith(prefix))
  }

  async clear(): Promise<void> {
    this.store.clear()
  }
}
