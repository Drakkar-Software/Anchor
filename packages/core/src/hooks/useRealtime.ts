"use client"

import { useEffect } from "react"
import { type StoreApi , useStore } from "zustand"

import type { FilterDescriptor,RealtimeStatus, TableStore } from "../types.js"

type UseRealtimeResult = {
  status: RealtimeStatus
}

/**
 * Hook that manages realtime subscription lifecycle.
 * Subscribes on mount, unsubscribes on unmount.
 */
export function useRealtime<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
  options?: {
    enabled?: boolean
    filter?: FilterDescriptor<Row>[]
  },
): UseRealtimeResult {
  const enabled = options?.enabled ?? true
  const status = useStore(store, (s) => s.realtimeStatus)
  const filterKey = JSON.stringify(options?.filter ?? null)

  useEffect(() => {
    if (!enabled) {return}

    return store.getState().subscribe(options?.filter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, store, filterKey])

  return { status }
}
