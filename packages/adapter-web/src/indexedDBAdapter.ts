import type { PersistenceAdapter } from "@drakkar.software/anchor/persistence"

const DB_NAME = "anchor"
const STORE_NAME = "kv"
const DB_VERSION = 1

/**
 * Web IndexedDB adapter. Good for large datasets.
 */
export class IndexedDBAdapter implements PersistenceAdapter {
  private dbPromise: Promise<IDBDatabase> | null = null

  private async getDB(): Promise<IDBDatabase> {
    this.dbPromise ||= openDB();

    return await this.dbPromise
  }

  async getItem<T>(key: string): Promise<T | null> {
    const database = await this.getDB()
    const store = tx(database, "readonly")
    const result = await promisify(store.get(key))

    return (result as T) ?? null
  }

  async setItem<T>(key: string, value: T): Promise<void> {
    const database = await this.getDB()
    const store = tx(database, "readwrite")

    await promisify(store.put(value, key))
  }

  async removeItem(key: string): Promise<void> {
    const database = await this.getDB()
    const store = tx(database, "readwrite")

    await promisify(store.delete(key))
  }

  async multiSet(entries: [string, unknown][]): Promise<void> {
    const database = await this.getDB()
    const transaction = database.transaction(STORE_NAME, "readwrite")
    const store = transaction.objectStore(STORE_NAME)

    for (const [key, value] of entries) {
      store.put(value, key)
    }

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve()
      }
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("IndexedDB transaction failed"))
      }
    })
  }

  async keys(prefix?: string): Promise<string[]> {
    const database = await this.getDB()
    const store = tx(database, "readonly")
    const allKeys = (await promisify(store.getAllKeys())) as string[]

    if (!prefix) {return allKeys}

    return allKeys.filter((k) => k.startsWith(prefix))
  }

  async clear(): Promise<void> {
    const database = await this.getDB()
    const store = tx(database, "readwrite")

    await promisify(store.clear())
  }
}

async function openDB(): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => { resolve(request.result); }
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB open failed"))
    }
  })
}

async function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return await new Promise((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result); }
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed"))
    }
  })
}

function tx(
  database: IDBDatabase,
  mode: IDBTransactionMode,
): IDBObjectStore {
  const transaction = database.transaction(STORE_NAME, mode)

  return transaction.objectStore(STORE_NAME)
}
