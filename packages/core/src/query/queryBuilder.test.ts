import { describe, expect,it } from "vitest"

import { query } from "./queryBuilder.js"

type Todo = {
  completed: boolean
  created_at: string
  id: number
  priority: number
  title: string
}

describe("QueryBuilder", () => {
  it("builds empty options by default", () => {
    const opts = query<Todo>().build()

    expect(opts.filters).toBeUndefined()
    expect(opts.sort).toBeUndefined()
    expect(opts.limit).toBeUndefined()
  })

  it("builds eq filter via where().eq()", () => {
    const opts = query<Todo>().where("completed").eq(false).build()

    expect(opts.filters).toEqual([{ column: "completed", op: "eq", value: false }])
  })

  it("chains multiple where clauses", () => {
    const opts = query<Todo>()
      .where("completed").eq(false)
      .where("priority").gte(3)
      .build()

    expect(opts.filters).toHaveLength(2)
    expect(opts.filters![0]).toEqual({ column: "completed", op: "eq", value: false })
    expect(opts.filters![1]).toEqual({ column: "priority", op: "gte", value: 3 })
  })

  it("supports all filter operators", () => {
    const b = query<Todo>()

    b.where("title").neq("x")
    b.where("priority").gt(1)
    b.where("priority").lt(10)
    b.where("priority").lte(9)
    b.where("title").like("%milk%")
    b.where("title").ilike("%MILK%")
    b.where("completed").is(null)
    b.where("priority").in([1, 2, 3])

    const opts = b.build()

    expect(opts.filters).toHaveLength(8)
  })

  it("builds orderBy", () => {
    const opts = query<Todo>()
      .orderBy("created_at", "desc")
      .orderBy("priority", "asc")
      .build()

    expect(opts.sort).toEqual([
      { ascending: false, column: "created_at" },
      { ascending: true, column: "priority" },
    ])
  })

  it("builds limit and offset", () => {
    const opts = query<Todo>().limit(20).offset(40).build()

    expect(opts.limit).toBe(20)
    expect(opts.offset).toBe(40)
  })

  it("builds select and count", () => {
    const opts = query<Todo>().select("id, title").count("exact").build()

    expect(opts.select).toBe("id, title")
    expect(opts.count).toBe("exact")
  })

  it("supports full chain", () => {
    const opts = query<Todo>()
      .where("completed").eq(false)
      .where("priority").gte(3)
      .orderBy("created_at", "desc")
      .limit(10)
      .build()

    expect(opts.filters).toHaveLength(2)
    expect(opts.sort).toHaveLength(1)
    expect(opts.limit).toBe(10)
  })
})
