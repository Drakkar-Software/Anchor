import { describe, expect,it } from "vitest"

import { buildCursorQuery, processCursorResults } from "./pagination.js"

type Todo = { created_at: string; id: number; title: string; }

describe("buildCursorQuery", () => {
  it("builds forward query without cursor", () => {
    const result = buildCursorQuery<Todo>({
      cursorColumn: "created_at",
      pageSize: 10,
    })

    expect(result.filters).toEqual([])
    expect(result.sort).toEqual([{ ascending: true, column: "created_at" }])
    expect(result.limit).toBe(11) // pageSize + 1 for hasNext detection
  })

  it("builds forward query with cursor", () => {
    const result = buildCursorQuery<Todo>({
      cursor: "2024-01-15",
      cursorColumn: "created_at",
      pageSize: 10,
    })

    expect(result.filters).toEqual([
      { column: "created_at", op: "gt", value: "2024-01-15" },
    ])
  })

  it("builds backward query with cursor", () => {
    const result = buildCursorQuery<Todo>({
      cursor: "2024-01-15",
      cursorColumn: "created_at",
      direction: "backward",
      pageSize: 10,
    })

    expect(result.filters).toEqual([
      { column: "created_at", op: "lt", value: "2024-01-15" },
    ])
    expect(result.sort[0]!.ascending).toBe(false)
  })
})

describe("processCursorResults", () => {
  it("detects hasNextPage when extra row exists", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      created_at: `2024-01-${String(i + 1).padStart(2, "0")}`,
      id: i,
      title: `Todo ${i}`,
    }))

    const result = processCursorResults(rows, {
      cursorColumn: "created_at",
      pageSize: 10,
    })

    expect(result.data).toHaveLength(10)
    expect(result.pagination.hasNextPage).toBe(true)
    expect(result.pagination.cursor).toBe("2024-01-10")
  })

  it("detects no next page when exact rows", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      created_at: `2024-01-${String(i + 1).padStart(2, "0")}`,
      id: i,
      title: `Todo ${i}`,
    }))

    const result = processCursorResults(rows, {
      cursorColumn: "created_at",
      pageSize: 10,
    })

    expect(result.data).toHaveLength(5)
    expect(result.pagination.hasNextPage).toBe(false)
  })

  it("hasPreviousPage when cursor is set", () => {
    const result = processCursorResults(
      [{ created_at: "2024-01-01", id: 1, title: "A" }],
      { cursor: "2024-01-01", cursorColumn: "created_at", pageSize: 10 },
    )

    expect(result.pagination.hasPreviousPage).toBe(true)
  })

  it("no previousPage on first page", () => {
    const result = processCursorResults(
      [{ created_at: "2024-01-01", id: 1, title: "A" }],
      { cursorColumn: "created_at", pageSize: 10 },
    )

    expect(result.pagination.hasPreviousPage).toBe(false)
  })
})
