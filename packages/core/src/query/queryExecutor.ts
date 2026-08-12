import type { SupabaseClient } from "@supabase/supabase-js"
import type { FilterDescriptor, SortDescriptor, FetchOptions } from "../types.js"
import { fromSupabaseError } from "../errors.js"

/**
 * Returns a schema-aware query builder for a table.
 * Uses .schema(name) for non-public schemas (requires supabase-js >=2.39).
 */
export function fromTable(
  supabase: SupabaseClient,
  table: string,
  schema?: string,
): any {
  if (schema && schema !== "public") {
    return (supabase as any).schema(schema).from(table)
  }
  return supabase.from(table)
}

/**
 * Applies an array of FilterDescriptors to a Supabase query builder.
 */
export function applyFilters(
  builder: any,
  filters: FilterDescriptor[],
): any {
  let q = builder
  for (const f of filters) {
    switch (f.op) {
      case "eq":
        q = q.eq(f.column, f.value)
        break
      case "neq":
        q = q.neq(f.column, f.value)
        break
      case "gt":
        q = q.gt(f.column, f.value)
        break
      case "gte":
        q = q.gte(f.column, f.value)
        break
      case "lt":
        q = q.lt(f.column, f.value)
        break
      case "lte":
        q = q.lte(f.column, f.value)
        break
      case "like":
        q = q.like(f.column, f.value)
        break
      case "ilike":
        q = q.ilike(f.column, f.value)
        break
      case "is":
        q = q.is(f.column, f.value)
        break
      case "in":
        q = q.in(f.column, f.value)
        break
      case "contains":
        q = q.contains(f.column, f.value)
        break
      case "containedBy":
        q = q.containedBy(f.column, f.value)
        break
      case "overlaps":
        q = q.overlaps(f.column, f.value)
        break
      case "textSearch": {
        const opts = f.value as {
          query: string
          type?: string
          config?: string
        }
        q = q.textSearch(f.column, opts.query, {
          type: opts.type,
          config: opts.config,
        })
        break
      }
      case "match":
        q = q.match(f.value as Record<string, unknown>)
        break
      case "not": {
        const notOpts = f.value as { op: string; value: unknown }
        q = q.not(f.column, notOpts.op ?? "eq", notOpts.value ?? f.value)
        break
      }
      case "or":
        q = q.or(f.value as string)
        break
      case "filter": {
        const filterOpts = f.value as { op: string; value: unknown }
        q = q.filter(f.column, filterOpts.op ?? "eq", filterOpts.value ?? f.value)
        break
      }
    }
  }
  return q
}

/**
 * Applies sort descriptors to a Supabase query builder.
 */
export function applySort(
  builder: any,
  sorts: SortDescriptor[],
): any {
  let q = builder
  for (const s of sorts) {
    q = q.order(s.column, {
      ascending: s.ascending ?? true,
      nullsFirst: s.nullsFirst ?? false,
    })
  }
  return q
}

function applyPagination<Row>(builder: any, options: FetchOptions<Row>): any {
  if (options.offset != null) {
    // range() handles both offset and limit — don't also call .limit()
    const limit = options.limit ?? 1000
    return builder.range(options.offset, options.offset + limit - 1)
  }
  if (options.limit != null) return builder.limit(options.limit)
  return builder
}

/**
 * Execute a full query with filters, sort, and pagination.
 */
export async function executeQuery<Row>(
  supabase: SupabaseClient,
  table: string,
  schema: string,
  options: FetchOptions<Row> = {},
): Promise<{ data: Row[]; count: number | null; error: Error | null }> {
  let builder = fromTable(supabase, table, schema).select(options.select ?? "*", {
    count: options.count,
  })

  if (options.filters?.length) {
    builder = applyFilters(builder, options.filters as FilterDescriptor[])
  }

  // The escape hatch gets everything EXCEPT the sort, and the asymmetry is not
  // an oversight. `order` is the one PostgREST parameter that accumulates —
  // `.order()` appends to whatever is already in the query string, while
  // `limit`/`range` overwrite and filters compose as AND. So pre-applying the
  // store's sort would silently demote a `queryFn`'s own `.order()` from being
  // the query's ordering to a tiebreaker behind `defaultSort`, and ordering
  // through a referenced table is one of the gaps the escape hatch exists for.
  // Everything else pre-applies safely: a `queryFn` narrows what it is handed,
  // and its own `limit`/`range` wins.
  if (!options.queryFn) {
    if (options.sort?.length) {
      builder = applySort(builder, options.sort as SortDescriptor[])
    }
  }

  builder = applyPagination(builder, options)

  if (options.queryFn) {
    try {
      const result = await options.queryFn(builder)
      const r = result as { data: Row[] | null; count: number | null; error: any }
      if (r.error) return { data: [], count: null, error: fromSupabaseError(r.error) }
      return { data: r.data ?? [], count: r.count, error: null }
    } catch (err) {
      return {
        data: [],
        count: null,
        error: err instanceof Error ? err : new Error(String(err)),
      }
    }
  }

  const { data, error, count } = await builder

  if (error) {
    return { data: [], count: null, error: fromSupabaseError(error) }
  }

  return { data: (data ?? []) as Row[], count, error: null }
}

/**
 * Execute a single-row fetch by primary key.
 */
export async function executeQueryOne<Row>(
  supabase: SupabaseClient,
  table: string,
  primaryKey: string,
  id: string | number,
  select?: string,
  schema?: string,
): Promise<{ data: Row | null; error: Error | null }> {
  const { data, error } = await fromTable(supabase, table, schema)
    .select(select ?? "*")
    .eq(primaryKey, id)
    .maybeSingle()

  if (error) {
    return { data: null, error: fromSupabaseError(error) }
  }

  return { data: data as Row | null, error: null }
}
