import { describe, it, expect } from "vitest"
import { matchRow } from "./matchRow.js"
import { match } from "./filters.js"

const row = {
  id: 1,
  title: "Buy milk",
  done: false,
  owner: null,
  day: "2026-08-12",
  count: 5,
  tags: ["a", "b"],
}

describe("matchRow", () => {
  it("matches everything when there are no filters", () => {
    expect(matchRow(row)).toBe(true)
    expect(matchRow(row, [])).toBe(true)
  })

  it("ANDs the filters", () => {
    expect(
      matchRow(row, [
        { column: "done", op: "eq", value: false },
        { column: "count", op: "gte", value: 5 },
      ]),
    ).toBe(true)
    expect(
      matchRow(row, [
        { column: "done", op: "eq", value: false },
        { column: "count", op: "gte", value: 6 },
      ]),
    ).toBe(false)
  })

  it("handles eq and neq, including against null", () => {
    expect(matchRow(row, [{ column: "id", op: "eq", value: 1 }])).toBe(true)
    expect(matchRow(row, [{ column: "id", op: "eq", value: 2 }])).toBe(false)
    expect(matchRow(row, [{ column: "id", op: "neq", value: 2 }])).toBe(true)
    // A column present and null is a real value, judged rather than skipped.
    expect(matchRow(row, [{ column: "owner", op: "eq", value: null }])).toBe(true)
    expect(matchRow(row, [{ column: "owner", op: "eq", value: 7 }])).toBe(false)
  })

  it("compares numbers numerically and ISO dates lexically", () => {
    expect(matchRow(row, [{ column: "count", op: "gt", value: 4 }])).toBe(true)
    expect(matchRow(row, [{ column: "count", op: "lt", value: 5 }])).toBe(false)
    expect(matchRow(row, [{ column: "count", op: "lte", value: 5 }])).toBe(true)
    // The metcare case: today's journey tasks.
    expect(matchRow(row, [{ column: "day", op: "gte", value: "2026-08-12" }])).toBe(true)
    expect(matchRow(row, [{ column: "day", op: "gte", value: "2026-08-13" }])).toBe(false)
  })

  it("treats like/ilike wildcards as SQL, not as a regex", () => {
    expect(matchRow(row, [{ column: "title", op: "like", value: "Buy%" }])).toBe(true)
    expect(matchRow(row, [{ column: "title", op: "like", value: "buy%" }])).toBe(false)
    expect(matchRow(row, [{ column: "title", op: "ilike", value: "buy%" }])).toBe(true)
    expect(matchRow(row, [{ column: "title", op: "like", value: "%milk" }])).toBe(true)
    expect(matchRow(row, [{ column: "title", op: "like", value: "Buy_milk" }])).toBe(true)
    // A `.` is a literal in SQL LIKE, so it must not behave as "any character".
    expect(matchRow({ title: "ab" }, [{ column: "title", op: "like", value: "a.b" }])).toBe(false)
  })

  it("handles in and the array operators", () => {
    expect(matchRow(row, [{ column: "id", op: "in", value: [1, 2] }])).toBe(true)
    expect(matchRow(row, [{ column: "id", op: "in", value: [2, 3] }])).toBe(false)
    expect(matchRow(row, [{ column: "tags", op: "contains", value: ["a"] }])).toBe(true)
    expect(matchRow(row, [{ column: "tags", op: "contains", value: ["c"] }])).toBe(false)
    expect(matchRow(row, [{ column: "tags", op: "overlaps", value: ["b", "z"] }])).toBe(true)
    expect(matchRow(row, [{ column: "tags", op: "overlaps", value: ["z"] }])).toBe(false)
    expect(matchRow(row, [{ column: "tags", op: "containedBy", value: ["a", "b", "c"] }])).toBe(true)
    expect(matchRow(row, [{ column: "tags", op: "containedBy", value: ["a"] }])).toBe(false)
  })

  it("INCLUDES the row for an operator it cannot evaluate locally", () => {
    // Extra rows are corrected by the next fetch; missing rows are not, and a
    // missing row reads as a bug in the screen rather than in the predicate.
    for (const op of ["textSearch", "match", "not", "or", "filter"] as const) {
      expect(matchRow(row, [{ column: "title", op, value: "anything" }])).toBe(true)
    }
  })

  it("INCLUDES a row that simply does not carry the column", () => {
    // An optimistic insert holds only what the caller passed: no server
    // default, no created_at, no trigger output. Judging `undefined >= today`
    // as false makes the task a user just created vanish from the screen that
    // created it, then reappear when the insert confirms.
    const pending = { title: "just typed", _anchor_pending: true }
    expect(matchRow(pending, [{ column: "day", op: "gte", value: "2026-08-12" }])).toBe(true)
    expect(matchRow(pending, [{ column: "journey_id", op: "eq", value: "j1" }])).toBe(true)
    // The columns it DOES carry are still judged.
    expect(matchRow(pending, [{ column: "title", op: "eq", value: "something else" }])).toBe(false)
  })

  it("does not crash on a type mismatch, it includes", () => {
    expect(matchRow(row, [{ column: "count", op: "like", value: "5%" }])).toBe(true)
    expect(matchRow(row, [{ column: "title", op: "contains", value: "x" }])).toBe(true)
  })
})

describe("matchRow with a match descriptor", () => {
  // The `match()` helper expands to N `eq`s and never emits `op: "match"`, so
  // this shape only arrives hand-built. It used to fall through to the default
  // arm and include every row, which for a local read means showing rows the
  // server would not have returned.
  const row = { id: 1, status: "open", priority: 2 }

  it("keeps a row whose every named column agrees", () => {
    expect(matchRow(row, [{ column: "", op: "match", value: { status: "open", priority: 2 } }])).toBe(
      true,
    )
  })

  it("drops a row where one named column disagrees", () => {
    expect(matchRow(row, [{ column: "", op: "match", value: { status: "open", priority: 9 } }])).toBe(
      false,
    )
  })

  it("keeps a pending row that lacks the column entirely", () => {
    // Same rule as every other operator: an optimistic insert holds only what
    // the caller passed, and must not vanish from the screen that created it.
    expect(matchRow({ id: 1 }, [{ column: "", op: "match", value: { status: "open" } }])).toBe(true)
  })
})

describe("the match() helper's expansion", () => {
  it("emits eq descriptors, which matchRow can judge", () => {
    const filters = match<{ status: string; priority: number }>({ status: "open", priority: 2 })

    expect(filters.map((f) => f.op)).toEqual(["eq", "eq"])
    expect(matchRow({ id: 1, status: "open", priority: 2 }, filters)).toBe(true)
    expect(matchRow({ id: 2, status: "done", priority: 2 }, filters)).toBe(false)
  })
})
