import type { FetchOptions, FilterDescriptor, FilterOperator,SortDescriptor } from "../types.js"

/**
 * Column-specific filter chain.
 */
class ColumnFilter<Row extends Record<string, unknown>, K extends string & keyof Row> {
  constructor(
    private readonly builder: QueryBuilder<Row>,
    private readonly column: K,
  ) {}

  private add(op: FilterOperator, value: unknown): QueryBuilder<Row> {
    return this.builder._addFilter({ column: this.column, op, value })
  }

  eq(value: Row[K]): QueryBuilder<Row> { return this.add("eq", value) }

  neq(value: Row[K]): QueryBuilder<Row> { return this.add("neq", value) }

  gt(value: Row[K]): QueryBuilder<Row> { return this.add("gt", value) }

  gte(value: Row[K]): QueryBuilder<Row> { return this.add("gte", value) }

  lt(value: Row[K]): QueryBuilder<Row> { return this.add("lt", value) }

  lte(value: Row[K]): QueryBuilder<Row> { return this.add("lte", value) }

  like(pattern: string): QueryBuilder<Row> { return this.add("like", pattern) }

  ilike(pattern: string): QueryBuilder<Row> { return this.add("ilike", pattern) }

  is(value: null | boolean): QueryBuilder<Row> { return this.add("is", value) }

  in(values: Row[K][]): QueryBuilder<Row> { return this.add("in", values) }

  contains(value: unknown): QueryBuilder<Row> { return this.add("contains", value) }

  containedBy(value: unknown): QueryBuilder<Row> { return this.add("containedBy", value) }

  overlaps(value: unknown): QueryBuilder<Row> { return this.add("overlaps", value) }
}

/**
 * Fluent query builder that produces FetchOptions.
 *
 * @example
 * ```typescript
 * const options = query<Todo>()
 *   .where('status').eq('active')
 *   .where('priority').gte(3)
 *   .orderBy('created_at', 'desc')
 *   .limit(10)
 *   .build()
 * ```
 */
export class QueryBuilder<Row extends Record<string, unknown> = Record<string, unknown>> {
  private readonly filters: FilterDescriptor<Row>[] = []

  private readonly sorts: SortDescriptor<Row>[] = []

  /** Start a filter chain on a column */
where<K extends string & keyof Row>(column: K): ColumnFilter<Row, K> {
    return new ColumnFilter(this, column)
  }

/** Add a raw filter */
filter(descriptor: FilterDescriptor<Row>): this {
    this.filters.push(descriptor)

    return this
  }

/** Add sort */
orderBy(column: string & keyof Row, direction: "asc" | "desc" = "asc"): this {
    this.sorts.push({
      ascending: direction === "asc",
      column,
    })

    return this
  }

/** Set result limit */
limit(n: number): this {
    this._limit = n

    return this
  }

/** Set result offset */
offset(n: number): this {
    this._offset = n

    return this
  }

/** Set select columns */
select(columns: string): this {
    this._select = columns

    return this
  }

/** Enable count */
count(mode: "exact" | "planned" | "estimated" = "exact"): this {
    this._count = mode

    return this
  }

/** Build the final FetchOptions */
build(): FetchOptions<Row> {
    return {
      count: this._count,
      filters: this.filters.length > 0 ? this.filters : undefined,
      limit: this._limit,
      offset: this._offset,
      select: this._select,
      sort: this.sorts.length > 0 ? this.sorts : undefined,
    }
  }

private _limit?: number

  private _offset?: number

  private _select?: string

  private _count?: "exact" | "planned" | "estimated"

  
  

  
  

  
  

  
  

  
  

  
  

  
  

  
  

  /** @internal - used by ColumnFilter to add filters */
  _addFilter(filter: FilterDescriptor<Row>): this {
    this.filters.push(filter)

    return this
  }
}

/**
 * Create a new fluent query builder.
 *
 * @example
 * ```typescript
 * const result = await store.getState().fetch(
 *   query<Todo>()
 *     .where('completed').eq(false)
 *     .orderBy('created_at', 'desc')
 *     .limit(20)
 *     .build()
 * )
 * ```
 */
export function query<Row extends Record<string, unknown> = Record<string, unknown>>(): QueryBuilder<Row> {
  return new QueryBuilder<Row>()
}
