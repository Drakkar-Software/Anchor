import { describe, expect,it } from "vitest"

import {
  asc,
  containedBy,
  contains,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inValues,
  is,
  like,
  lt,
  lte,
  match,
  neq,
  overlaps,
  textSearch,
} from "./filters.js"

type Todo = {
  completed: boolean
  created_at: string
  id: number
  priority: number
  tags: string[]
  title: string
}

describe("Filter helpers", () => {
  it("eq creates an equality filter", () => {
    const filter = eq<Todo, "title">("title", "Buy milk")

    expect(filter).toEqual({ column: "title", op: "eq", value: "Buy milk" })
  })

  it("neq creates a not-equal filter", () => {
    const filter = neq<Todo, "completed">("completed", true)

    expect(filter).toEqual({ column: "completed", op: "neq", value: true })
  })

  it("gt creates a greater-than filter", () => {
    const filter = gt<Todo, "priority">("priority", 3)

    expect(filter).toEqual({ column: "priority", op: "gt", value: 3 })
  })

  it("gte creates a greater-than-or-equal filter", () => {
    const filter = gte<Todo, "priority">("priority", 3)

    expect(filter).toEqual({ column: "priority", op: "gte", value: 3 })
  })

  it("lt creates a less-than filter", () => {
    const filter = lt<Todo, "priority">("priority", 3)

    expect(filter).toEqual({ column: "priority", op: "lt", value: 3 })
  })

  it("lte creates a less-than-or-equal filter", () => {
    const filter = lte<Todo, "priority">("priority", 3)

    expect(filter).toEqual({ column: "priority", op: "lte", value: 3 })
  })

  it("like creates a case-sensitive pattern filter", () => {
    const filter = like<Todo, "title">("title", "%milk%")

    expect(filter).toEqual({ column: "title", op: "like", value: "%milk%" })
  })

  it("ilike creates a case-insensitive pattern filter", () => {
    const filter = ilike<Todo, "title">("title", "%MILK%")

    expect(filter).toEqual({ column: "title", op: "ilike", value: "%MILK%" })
  })

  it("is creates an IS filter for null/boolean", () => {
    const nullFilter = is<Todo, "title">("title", null)

    expect(nullFilter).toEqual({ column: "title", op: "is", value: null })

    const boolFilter = is<Todo, "completed">("completed", true)

    expect(boolFilter).toEqual({ column: "completed", op: "is", value: true })
  })

  it("inValues creates an IN filter", () => {
    const filter = inValues<Todo, "priority">("priority", [1, 2, 3])

    expect(filter).toEqual({ column: "priority", op: "in", value: [1, 2, 3] })
  })

  it("contains creates a contains filter", () => {
    const filter = contains<Todo, "tags">("tags", ["urgent"])

    expect(filter).toEqual({ column: "tags", op: "contains", value: ["urgent"] })
  })

  it("containedBy creates a containedBy filter", () => {
    const filter = containedBy<Todo, "tags">("tags", ["urgent", "important"])

    expect(filter).toEqual({ column: "tags", op: "containedBy", value: ["urgent", "important"] })
  })

  it("overlaps creates an overlaps filter", () => {
    const filter = overlaps<Todo, "tags">("tags", ["urgent"])

    expect(filter).toEqual({ column: "tags", op: "overlaps", value: ["urgent"] })
  })

  it("textSearch creates a text search filter", () => {
    const filter = textSearch<Todo, "title">("title", "milk & eggs")

    expect(filter).toEqual({
      column: "title",
      op: "textSearch",
      value: { query: "milk & eggs" },
    })
  })

  it("textSearch with options", () => {
    const filter = textSearch<Todo, "title">("title", "milk", {
      config: "english",
      type: "websearch",
    })

    expect(filter).toEqual({
      column: "title",
      op: "textSearch",
      value: { config: "english", query: "milk", type: "websearch" },
    })
  })

  it("match creates multiple eq filters", () => {
    const filters = match<Todo>({ completed: false, title: "Buy milk" })

    expect(filters).toHaveLength(2)
    expect(filters).toContainEqual({ column: "title", op: "eq", value: "Buy milk" })
    expect(filters).toContainEqual({ column: "completed", op: "eq", value: false })
  })
})

describe("Sort helpers", () => {
  it("asc creates ascending sort", () => {
    const sort = asc<Todo, "created_at">("created_at")

    expect(sort).toEqual({ ascending: true, column: "created_at", nullsFirst: undefined })
  })

  it("desc creates descending sort", () => {
    const sort = desc<Todo, "priority">("priority")

    expect(sort).toEqual({ ascending: false, column: "priority", nullsFirst: undefined })
  })

  it("asc with nullsFirst option", () => {
    const sort = asc<Todo, "priority">("priority", { nullsFirst: true })

    expect(sort).toEqual({ ascending: true, column: "priority", nullsFirst: true })
  })
})
