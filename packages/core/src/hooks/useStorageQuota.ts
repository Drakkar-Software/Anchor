"use client"

import { useCallback,useEffect, useState } from "react"

import { StorageQuotaManager,type StorageUsage  } from "../persistence/storageQuota.js"
import type { PersistenceAdapter } from "../types.js"

export type UseStorageQuotaResult = StorageUsage & {
  isLoading: boolean
  refresh: () => void
}

/**
 * React hook that monitors storage usage for a persistence adapter.
 *
 * @example
 * const { count, estimatedBytes, isLoading } = useStorageQuota(adapter)
 */
export function useStorageQuota(
  adapter: PersistenceAdapter,
  options?: { prefix?: string; refreshInterval?: number },
): UseStorageQuotaResult {
  const [usage, setUsage] = useState<StorageUsage>({ count: 0, estimatedBytes: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const prefix = options?.prefix ?? "anchor:"
  const refreshInterval = options?.refreshInterval

  const refresh = useCallback(() => {
    const manager = new StorageQuotaManager()

    setIsLoading(true)
    manager
      .getUsage(adapter, prefix)
      .then(setUsage)
      .catch(() => {})
      .finally(() => { setIsLoading(false); })
  }, [adapter, prefix])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!refreshInterval) {return}

    const id = setInterval(refresh, refreshInterval)

    return () => { clearInterval(id); }
  }, [refresh, refreshInterval])

  return { ...usage, isLoading, refresh }
}
