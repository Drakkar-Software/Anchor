import type { PersistenceAdapter } from "../types.js"

export type EvictionOptions = {
  /** Remove keys not accessed within this many milliseconds */
  maxAge?: number

  /** Maximum number of records to keep */
  maxRecords?: number

  /** Only consider keys with this prefix (default: "anchor:") */
  prefix?: string
}

export type StorageUsage = {
  count: number
  estimatedBytes: number
}

/**
 * Monitors and manages storage usage for persistence adapters.
 * Provides quota estimation and LRU-style eviction.
 */
export class StorageQuotaManager {
  private readonly tableLimits = new Map<string, number>()

  /**
   * Set a maximum record limit for a table's cached data.
   */
setTableLimit(table: string, maxRecords: number): void {
    this.tableLimits.set(table, maxRecords)
  }


/**
   * Get the configured limit for a table, or undefined if none set.
   */
getTableLimit(table: string): number | undefined {
    return this.tableLimits.get(table)
  }


/**
   * Estimate storage usage for keys with the given prefix.
   * Requires the adapter to support keys().
   */
  async getUsage(
    adapter: PersistenceAdapter,
    prefix = "anchor:",
  ): Promise<StorageUsage> {
    if (!adapter.keys) {
      throw new Error(
        "StorageQuotaManager: adapter does not support keys(). Use an adapter with keys() support.",
      )
    }

    const allKeys = await adapter.keys(prefix)
    const values = await Promise.all(
      allKeys.map(async (key) => await adapter.getItem<unknown>(key)),
    )

    let estimatedBytes = 0

    for (const [i, allKey] of allKeys.entries()) {
      const key = allKey
      const value = values[i]

      if (value !== null && value !== undefined) {
        const json = JSON.stringify(value)


        // UTF-16 encoding: ~2 bytes per character
        estimatedBytes += (key.length + json.length) * 2
      }
    }

    return { count: allKeys.length, estimatedBytes }
  }

  
  

  
  

  /**
   * Enforce the record limit for a specific table.
   * Removes the oldest records (by array position) when over the limit.
   * Returns the number of records removed.
   */
  async enforceLimit(
    adapter: PersistenceAdapter,
    table: string,
    schema = "public",
  ): Promise<number> {
    const limit = this.tableLimits.get(table)

    if (limit === undefined) {return 0}

    const key = `anchor:${schema}:${table}`
    const data = await adapter.getItem<Record<string, unknown>[]>(key)

    if (!data || !Array.isArray(data) || data.length <= limit) {return 0}

    const removed = data.length - limit
    const trimmed = data.slice(-limit) // Keep the newest (last) records

    await adapter.setItem(key, trimmed)

    return removed
  }

  /**
   * Evict the oldest entries by key prefix.
   * Returns the number of entries removed.
   */
  async evictByCount(
    adapter: PersistenceAdapter,
    options: EvictionOptions = {},
  ): Promise<number> {
    const { maxRecords, prefix = "anchor:" } = options

    if (!adapter.keys) {
      throw new Error("StorageQuotaManager: adapter does not support keys()")
    }

    if (maxRecords === undefined) {return 0}

    const allKeys = await adapter.keys(prefix)

    // Skip internal keys
    const dataKeys = allKeys.filter(
      (k) =>
        !k.startsWith("anchor:__") &&
        k !== "anchor:__schema_version" &&
        k !== "anchor:__mutation_queue" &&
        k !== "anchor:__temp_id_map",
    )

    if (dataKeys.length <= maxRecords) {return 0}

    // Remove oldest keys (first in list) to get under the limit
    const toRemove = dataKeys.slice(0, dataKeys.length - maxRecords)

    await Promise.all(toRemove.map(async (key) => { await adapter.removeItem(key); }))

    return toRemove.length
  }
}
