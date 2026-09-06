"use client"

import { useCallback, useEffect,useRef, useState } from "react"
import type { StoreApi } from "zustand"

import type {
  FilterDescriptor,
  TableStore,
  TrackedRow,
  UpsertOptions,
} from "../types.js"

type MutationResult<
  Row,
  InsertRow,
  UpdateRow,
> = {
  error: Error | null
  insert: (row: InsertRow) => Promise<TrackedRow<Row>>
  insertMany: (rows: InsertRow[]) => Promise<TrackedRow<Row>[]>
  isLoading: boolean
  remove: (id: string | number) => Promise<void>
  removeWhere: (filters: FilterDescriptor<Row>[]) => Promise<void>
  update: (id: string | number, changes: UpdateRow) => Promise<TrackedRow<Row>>
  upsert: (row: InsertRow, options?: UpsertOptions) => Promise<TrackedRow<Row>>
}

/**
 * Mutation hook with loading/error state tracking.
 * Preserves InsertRow/UpdateRow type safety from the store.
 */
export function useMutation<
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
>(
  store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
): MutationResult<Row, InsertRow, UpdateRow> {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const storeRef = useRef(store)

  useEffect(() => {
    storeRef.current = store
  }, [store])

  const wrap = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T> => {
      setIsLoading(true)
      setError(null)

      return await fn()
        .then((result) => result)
        .catch((error_: unknown) => {
          const err = error_ instanceof Error ? error_ : new Error(String(error_))

          setError(err)

          throw err
        })
        .finally(() => {
          setIsLoading(false)
        })
    },
    [],
  )

  const insert = useCallback(
    async (row: InsertRow) => await wrap(async () => await storeRef.current.getState().insert(row)),
    [wrap],
  )

  const insertMany = useCallback(
    async (rows: InsertRow[]) =>
      await wrap(async () => await storeRef.current.getState().insertMany(rows)),
    [wrap],
  )

  const update = useCallback(
    async (id: string | number, changes: UpdateRow) =>
      await wrap(async () => await storeRef.current.getState().update(id, changes)),
    [wrap],
  )

  const upsert = useCallback(
    async (row: InsertRow, options?: UpsertOptions) =>
      await wrap(async () => await storeRef.current.getState().upsert(row, options)),
    [wrap],
  )

  const remove = useCallback(
    async (id: string | number) =>
      { await wrap(async () => { await storeRef.current.getState().remove(id); }); },
    [wrap],
  )

  const removeWhere = useCallback(
    async (filters: FilterDescriptor<Row>[]) =>
      { await wrap(async () => { await storeRef.current.getState().removeWhere(filters); }); },
    [wrap],
  )

  return { error, insert, insertMany, isLoading, remove, removeWhere, update, upsert }
}
