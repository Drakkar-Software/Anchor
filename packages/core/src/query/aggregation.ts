import type { SupabaseClient } from "@supabase/supabase-js"

import { fromSupabaseError } from "../errors.js"

export type AggregateFunction = "sum" | "avg" | "min" | "max" | "count"

export type AggregateResult<T = number> = {
  data: T | null
  error: Error | null
}

/**
 * Compute aggregations locally on an array of records.
 * Works on data already in the store — no network call.
 *
 * @example
 * ```typescript
 * const records = store.getState().order.map(id => store.getState().records.get(id)!)
 * const total = aggregateLocal(records, 'price', 'sum')  // 150.50
 * const avg = aggregateLocal(records, 'price', 'avg')    // 30.10
 * ```
 */
export function aggregateLocal<Row extends Record<string, unknown>>(
  records: Row[],
  column: string & keyof Row,
  fn: AggregateFunction,
): number | null {
  if (records.length === 0) {return fn === "count" ? 0 : null}

  if (fn === "count") {return records.length}

  const values: number[] = []

  for (const r of records) {
    const v = r[column]

    if (typeof v === "number" && !Number.isNaN(v)) {
      values.push(v)
    }
  }

  if (values.length === 0) {return null}

  switch (fn) {
    case "avg": {
      return values.reduce((acc, v) => acc + v, 0) / values.length
    }
    case "max": {
      return Math.max(...values)
    }
    case "min": {
      return Math.min(...values)
    }
    case "sum": {
      return values.reduce((acc, v) => acc + v, 0)
    }

    default: {
      return null
    }
  }
}

/**
 * Perform an aggregation on a table column using RPC.
 *
 * This calls a Postgres function named `zs_{fn}_{table}_{column}`
 * (e.g., `zs_sum_orders_total`). You must create these functions in your
 * database. Example SQL:
 *
 * ```sql
 * CREATE OR REPLACE FUNCTION zs_sum_orders_total()
 * RETURNS numeric AS $$
 *   SELECT COALESCE(SUM(total), 0) FROM orders;
 * $$ LANGUAGE sql SECURITY DEFINER;
 * ```
 *
 * For a simpler approach that doesn't require RPC functions, use
 * `aggregateLocal()` to compute aggregations on already-fetched store data.
 */
export async function aggregateRpc<T = number>(
  supabase: SupabaseClient,
  table: string,
  column: string,
  fn: AggregateFunction,
  rpcName?: string,
): Promise<AggregateResult<T>> {
  const functionName = rpcName ?? `zs_${fn}_${table}_${column}`
  const { data, error } = await supabase.rpc(functionName)

  if (error) {return { data: null, error: fromSupabaseError(error) }}

  return { data: data as T, error: null }
}
