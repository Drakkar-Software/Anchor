"use client"

import { useState, useCallback, useRef } from "react"
import type { StoreApi } from "zustand"
import type {
  TableStore,
  TrackedRow,
  FilterDescriptor,
  UpsertOptions,
} from "../types.js"

type MutationResult<
  Row,
  InsertRow,
  UpdateRow,
> = {
  insert: (row: InsertRow) => Promise<TrackedRow<Row>>
  insertMany: (rows: InsertRow[]) => Promise<TrackedRow<Row>[]>
  update: (id: string | number, changes: UpdateRow) => Promise<TrackedRow<Row>>
  upsert: (row: InsertRow, options?: UpsertOptions) => Promise<TrackedRow<Row>>
  remove: (id: string | number) => Promise<void>
  removeWhere: (filters: FilterDescriptor<Row>[]) => Promise<void>
  isLoading: boolean
  error: Error | null
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
  storeRef.current = store

  const wrap = useCallback(
    <T>(fn: () => Promise<T>): Promise<T> => {
      setIsLoading(true)
      setError(null)
      return fn()
        .then((result) => {
          setIsLoading(false)
          return result
        })
        .catch((err: Error) => {
          setIsLoading(false)
          setError(err)
          throw err
        })
    },
    [],
  )

  const insert = useCallback(
    (row: InsertRow) => wrap(() => storeRef.current.getState().insert(row)),
    [wrap],
  )

  const insertMany = useCallback(
    (rows: InsertRow[]) =>
      wrap(() => storeRef.current.getState().insertMany(rows)),
    [wrap],
  )

  const update = useCallback(
    (id: string | number, changes: UpdateRow) =>
      wrap(() => storeRef.current.getState().update(id, changes)),
    [wrap],
  )

  const upsert = useCallback(
    (row: InsertRow, options?: UpsertOptions) =>
      wrap(() => storeRef.current.getState().upsert(row, options)),
    [wrap],
  )

  const remove = useCallback(
    (id: string | number) =>
      wrap(() => storeRef.current.getState().remove(id)),
    [wrap],
  )

  const removeWhere = useCallback(
    (filters: FilterDescriptor<Row>[]) =>
      wrap(() => storeRef.current.getState().removeWhere(filters)),
    [wrap],
  )

  return { insert, insertMany, update, upsert, remove, removeWhere, isLoading, error }
}
