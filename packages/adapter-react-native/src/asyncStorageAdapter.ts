import type { PersistenceAdapter } from "@drakkar.software/anchor/persistence"

interface AsyncStorageModule {
  getAllKeys: () => Promise<readonly string[]>
  getItem: (key: string) => Promise<string | null>
  multiRemove: (keys: string[]) => Promise<void>
  multiSet: (pairs: [string, string][]) => Promise<void>
  removeItem: (key: string) => Promise<void>
  setItem: (key: string, value: string) => Promise<void>
}

/**
 * React Native persistence adapter using @react-native-async-storage/async-storage.
 * Simple key-value storage, good for smaller datasets.
 *
 * Pass the AsyncStorage default export as the argument to avoid bundler
 * resolution issues in pnpm virtual store environments.
 *
 * @example
 * import AsyncStorage from '@react-native-async-storage/async-storage'
 * new AsyncStorageAdapter(AsyncStorage)
 */
export class AsyncStorageAdapter implements PersistenceAdapter {
  private readonly storage: AsyncStorageModule

  constructor(AsyncStorage: AsyncStorageModule) {
    this.storage = AsyncStorage
  }

  async getItem<T>(key: string): Promise<T | null> {
    const raw = await this.storage.getItem(key)

    if (!raw) {return null}

    try {
      return JSON.parse(raw) as T
    } catch (error) {
      console.warn(`[anchor:asyncStorage] Failed to parse data for key "${key}":`, error)

      return null
    }
  }

  async setItem<T>(key: string, value: T): Promise<void> {
    await this.storage.setItem(key, JSON.stringify(value))
  }

  async removeItem(key: string): Promise<void> {
    await this.storage.removeItem(key)
  }

  async multiSet(entries: [string, unknown][]): Promise<void> {
    const pairs = entries.map(
      ([key, value]) => [key, JSON.stringify(value)] as [string, string],
    )

    await this.storage.multiSet(pairs)
  }

  async keys(prefix?: string): Promise<string[]> {
    const allKeys = await this.storage.getAllKeys()

    if (!prefix) {return Array.from(allKeys)}

    return allKeys.filter((k: string) => k.startsWith(prefix))
  }

  async clear(): Promise<void> {
    const zsKeys = await this.keys("anchor:")

    if (zsKeys.length > 0) {
      await this.storage.multiRemove(zsKeys)
    }
  }
}
