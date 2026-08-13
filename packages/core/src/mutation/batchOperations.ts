import type { SupabaseClient } from "@supabase/supabase-js"
import type { StoreApi } from "zustand"
import type { TableStore, TrackedRow, FilterDescriptor } from "../types.js"
import { randomId } from "../types.js"
import { fromTable, applyFilters } from "../query/queryExecutor.js"
import { fromSupabaseError } from "../errors.js"

/**
 * Update multiple rows matching filters.
 * Applies optimistic updates and confirms with server response.
 */
export async function updateMany<
  Row extends Record<string, unknown>,
>(
  supabase: SupabaseClient,
  table: string,
  primaryKey: string,
  store: StoreApi<TableStore<Row, any, any>>,
  filters: FilterDescriptor<Row>[],
  changes: Partial<Row>,
  schema?: string,
): Promise<TrackedRow<Row>[]> {
  // Find matching rows for optimistic update
  const state = store.getState()
  const matchingIds: (string | number)[] = []
  const snapshots = new Map<string | number, TrackedRow<Row>>()

  for (const [id, record] of state.records) {
    const matches = filters.every((f) => {
      const val = (record as Record<string, unknown>)[f.column]
      switch (f.op) {
        case "eq": return val === f.value
        case "neq": return val !== f.value
        default: return true // Server will do the actual filtering
      }
    })
    if (matches) {
      matchingIds.push(id)
      snapshots.set(id, record)
    }
  }

  // Optimistic apply with CAS mutation ID
  const mutationId = randomId()
  store.setState((prev: any) => {
    const records = new Map(prev.records)
    for (const id of matchingIds) {
      const existing = records.get(id)
      if (existing) {
        records.set(id, {
          ...existing,
          ...changes,
          _anchor_pending: "update",
          _anchor_optimistic: true,
          _anchor_mutationId: mutationId,
        })
      }
    }
    return { ...prev, records }
  })

  try {
    // Execute remote
    let builder = fromTable(supabase, table, schema).update(changes as any)
    builder = applyFilters(builder, filters as FilterDescriptor[])
    const { data, error } = await builder.select("*")

    if (error) throw fromSupabaseError(error)

    // Confirm with server response
    const serverRows = (data ?? []) as Row[]
    store.setState((prev: any) => {
      const records = new Map(prev.records)
      for (const row of serverRows) {
        const id = (row as Record<string, unknown>)[primaryKey] as string | number
        records.set(id, row as TrackedRow<Row>)
      }
      return { ...prev, records }
    })

    return serverRows as TrackedRow<Row>[]
  } catch (err) {
    // Compare-and-swap rollback: only restore rows still owned by this mutation
    store.setState((prev: any) => {
      const records = new Map(prev.records)
      for (const [id, snapshot] of snapshots) {
        const current = records.get(id) as TrackedRow<Row> | undefined
        if (current?._anchor_mutationId === mutationId) {
          records.set(id, snapshot)
        }
      }
      return { ...prev, records, error: err instanceof Error ? err : new Error(String(err)) }
    })
    throw err
  }
}

/**
 * Delete multiple rows matching filters.
 * Applies optimistic removal and confirms with server.
 */
export async function removeMany<
  Row extends Record<string, unknown>,
>(
  supabase: SupabaseClient,
  table: string,
  _primaryKey: string,
  store: StoreApi<TableStore<Row, any, any>>,
  filters: FilterDescriptor<Row>[],
  schema?: string,
): Promise<void> {
  // Find matching rows for optimistic removal
  const state = store.getState()
  const matchingIds: (string | number)[] = []
  const snapshots = new Map<string | number, TrackedRow<Row>>()

  for (const [id, record] of state.records) {
    const matches = filters.every((f) => {
      const val = (record as Record<string, unknown>)[f.column]
      switch (f.op) {
        case "eq": return val === f.value
        case "neq": return val !== f.value
        default: return true
      }
    })
    if (matches) {
      matchingIds.push(id)
      snapshots.set(id, record)
    }
  }

  // Optimistic remove
  const matchingIdSet = new Set(matchingIds)
  store.setState((prev: any) => {
    const records = new Map(prev.records)
    const order = (prev.order as (string | number)[]).filter(
      (o) => !matchingIdSet.has(o),
    )
    for (const id of matchingIds) {
      records.delete(id)
    }
    return { ...prev, records, order }
  })

  try {
    // Execute remote
    let builder = fromTable(supabase, table, schema).delete()
    builder = applyFilters(builder, filters as FilterDescriptor[])
    const { error } = await builder

    if (error) throw fromSupabaseError(error)
  } catch (err) {
    // Rollback — re-insert rows into current order (preserves concurrent changes)
    store.setState((prev: any) => {
      const records = new Map(prev.records)
      const order = [...prev.order] as (string | number)[]
      for (const [id, snapshot] of snapshots) {
        records.set(id, snapshot)
        if (!order.includes(id)) order.push(id)
      }
      return { ...prev, records, order, error: err instanceof Error ? err : new Error(String(err)) }
    })
    throw err
  }
}
