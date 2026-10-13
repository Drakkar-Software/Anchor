import { describe, expect, it } from "vitest"

import type { FilterDescriptor } from "../types.js"
import { toRealtimeFilter } from "./realtimeFilter.js"

describe("toRealtimeFilter", () => {
  it("serializes supported operators into one postgres_changes filter", () => {
    const filter = toRealtimeFilter([
      { column: "user_id", op: "eq", value: "u-1" },
      { column: "score", op: "gte", value: 10 },
      { column: "status", op: "in", value: ["open", "closed"] },
      { column: "archived_at", op: "is", value: null },
    ]).build()

    expect(filter).toBe("user_id=eq.u-1,score=gte.10,status=in.(open,closed),archived_at=is.null")
  })

  it("quotes values containing PostgREST reserved characters", () => {
    const filter = toRealtimeFilter([{ column: "title", op: "eq", value: "a,b" }]).build()

    expect(filter).toBe('title=eq."a,b"')
  })

  it("rejects operators Realtime cannot evaluate, and still builds the supported ones", () => {
    const unsupported: FilterDescriptor["op"][] = [
      "contains",
      "containedBy",
      "overlaps",
      "textSearch",
      "match",
      "not",
      "or",
      "filter",
    ]

    expect(toRealtimeFilter([{ column: "id", op: "eq", value: 1 }]).build()).toBe("id=eq.1")

    for (const op of unsupported) {
      expect(() => toRealtimeFilter([{ column: "name", op, value: "x" }])).toThrow(
        /operator ".+" is not supported/,
      )
    }
  })

  it("never maps Anchor's match to a Realtime regex filter", () => {
    expect(() => toRealtimeFilter([{ column: "email", op: "match", value: ".*@acme\\.com$" }])).toThrow(
      /operator "match" is not supported/,
    )
    expect(toRealtimeFilter([{ column: "email", op: "eq", value: "a@acme.com" }]).build()).toBe(
      "email=eq.a@acme.com",
    )
  })

  it("throws when an unsupported filter follows supported ones instead of dropping it", () => {
    const filters: FilterDescriptor[] = [
      { column: "org_id", op: "eq", value: 7 },
      { column: "tags", op: "overlaps", value: ["a"] },
    ]

    expect(() => toRealtimeFilter(filters)).toThrow(/operator "overlaps" is not supported/)
    expect(toRealtimeFilter(filters.slice(0, 1)).build()).toBe("org_id=eq.7")
  })
})
