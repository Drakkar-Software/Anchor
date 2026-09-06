import type { FilterDescriptor, SortDescriptor } from "../types.js"

export type CursorDirection = "forward" | "backward"

export type CursorPaginationOptions<Row = Record<string, unknown>> = {
  /** Current cursor value (null = start from beginning) */
  cursor?: unknown

  /** Column to paginate on (must be sortable, e.g. created_at, id) */
  cursorColumn: string & keyof Row

  /** Direction: forward (after cursor) or backward (before cursor) */
  direction?: CursorDirection

  /** Number of items per page */
  pageSize: number
}

export type PaginationState = {
  cursor: unknown
  hasNextPage: boolean
  hasPreviousPage: boolean
  pageSize: number
}

/**
 * Build filters and sort for cursor-based pagination.
 * Returns the filters/sort to append to a query.
 */
export function buildCursorQuery<Row>(
  options: CursorPaginationOptions<Row>,
): {
  filters: FilterDescriptor<Row>[]
  limit: number
  sort: SortDescriptor<Row>[]
} {
  const {
    cursor,
    cursorColumn,
    direction = "forward",
    pageSize,
  } = options

  const filters: FilterDescriptor<Row>[] = []
  const ascending = direction === "forward"

  if (cursor != null) {
    filters.push({
      column: cursorColumn,
      op: ascending ? "gt" : "lt",
      value: cursor,
    })
  }

  const sort: SortDescriptor<Row>[] = [
    { ascending, column: cursorColumn },
  ]

  // Fetch one extra to detect if there's a next page
  return { filters, limit: pageSize + 1, sort }
}

/**
 * Process cursor pagination results.
 * Trims the extra item and determines hasNextPage/hasPreviousPage.
 */
export function processCursorResults<Row>(
  rows: Row[],
  options: CursorPaginationOptions<Row>,
): {
  data: Row[]
  pagination: PaginationState
} {
  const { cursor, cursorColumn, direction = "forward", pageSize } = options
  const hasMore = rows.length > pageSize
  const data = hasMore ? rows.slice(0, pageSize) : rows

  // For backward direction, reverse to maintain expected order
  if (direction === "backward") {
    data.reverse()
  }

  const lastItem = data.at(-1) as Record<string, unknown> | undefined
  const firstItem = data[0] as Record<string, unknown> | undefined

  return {
    data,

    pagination: {
      cursor: direction === "forward"
        ? (lastItem?.[cursorColumn] ?? null)
        : (firstItem?.[cursorColumn] ?? null),

      hasNextPage: direction === "forward" ? hasMore : cursor != null,
      hasPreviousPage: direction === "forward" ? cursor != null : hasMore,
      pageSize,
    },
  }
}
