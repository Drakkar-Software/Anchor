import { describe, expect,it } from "vitest"

import type { ConflictContext, TrackedRow } from "../types.js"
import {
  fieldLevelMerge,
  lastWriteWins,
  localWins,
  remoteWins,
  resolveConflict,
} from "./conflictResolution.js"

type Row = {
  completed: boolean
  id: number
  priority: number
  title: string
  updated_at: string
}

const baseContext: ConflictContext = {
  hasPendingMutations: false,
  pendingMutations: [],
  primaryKey: { id: 1 },
  table: "todos",
}

describe("remoteWins", () => {
  it("always returns the remote row", () => {
    const resolver = remoteWins<Row>()
    const local: TrackedRow<Row> = {
      _anchor_pending: "update", completed: false, id: 1, priority: 1, title: "Local",
      updated_at: "2024-01-01",
    }
    const remote: Row = {
      completed: true, id: 1, priority: 2, title: "Remote", updated_at: "2024-01-02",
    }

    expect(resolver(local, remote, baseContext)).toEqual(remote)
  })
})

describe("localWins", () => {
  it("returns the local row without metadata", () => {
    const resolver = localWins<Row>()
    const local: TrackedRow<Row> = {
      _anchor_mutationId: "m1", _anchor_optimistic: true, _anchor_pending: "update", completed: false, id: 1,
      priority: 1,
      title: "Local",
      updated_at: "2024-01-01",
    }
    const remote: Row = {
      completed: true, id: 1, priority: 2, title: "Remote", updated_at: "2024-01-02",
    }

    const result = resolver(local, remote, baseContext)

    expect(result).toEqual({
      completed: false, id: 1, priority: 1, title: "Local", updated_at: "2024-01-01",
    })

    // Verify metadata stripped
    expect(result).not.toHaveProperty("_anchor_pending")
    expect(result).not.toHaveProperty("_anchor_optimistic")
    expect(result).not.toHaveProperty("_anchor_mutationId")
  })
})

describe("lastWriteWins", () => {
  it("returns remote when remote is newer", () => {
    const resolver = lastWriteWins<Row>()
    const local: TrackedRow<Row> = {
      completed: false, id: 1, priority: 1, title: "Local", updated_at: "2024-01-01T00:00:00Z",
    }
    const remote: Row = {
      completed: true, id: 1, priority: 2, title: "Remote", updated_at: "2024-01-02T00:00:00Z",
    }

    expect(resolver(local, remote, baseContext)).toEqual(remote)
  })

  it("returns local (without meta) when local is newer", () => {
    const resolver = lastWriteWins<Row>()
    const local: TrackedRow<Row> = {
      _anchor_pending: "update", completed: false, id: 1, priority: 1, title: "Local",
      updated_at: "2024-01-03T00:00:00Z",
    }
    const remote: Row = {
      completed: true, id: 1, priority: 2, title: "Remote", updated_at: "2024-01-02T00:00:00Z",
    }

    const result = resolver(local, remote, baseContext)

    expect((result as any).title).toBe("Local")
    expect(result).not.toHaveProperty("_anchor_pending")
  })

  it("returns remote on tie (server wins as authoritative source)", () => {
    const resolver = lastWriteWins<Row>()
    const ts = "2024-01-01T00:00:00Z"
    const local: TrackedRow<Row> = {
      completed: false, id: 1, priority: 1, title: "Local", updated_at: ts,
    }
    const remote: Row = {
      completed: true, id: 1, priority: 2, title: "Remote", updated_at: ts,
    }

    const result = resolver(local, remote, baseContext)

    expect((result as any).title).toBe("Remote")
  })

  it("returns remote when timestamps are missing", () => {
    const resolver = lastWriteWins<Row>()
    const local: TrackedRow<Row> = {
      completed: false, id: 1, priority: 1, title: "Local", updated_at: "",
    }
    const remote: Row = {
      completed: true, id: 1, priority: 2, title: "Remote", updated_at: "",
    }

    expect(resolver(local, remote, baseContext)).toEqual(remote)
  })

  it("supports custom timestamp column", () => {
    type RowWithModified = Row & { modified_at: string }

    const resolver = lastWriteWins<RowWithModified>("modified_at")
    const local: TrackedRow<RowWithModified> = {
      completed: false, id: 1, modified_at: "2024-01-03T00:00:00Z", priority: 1,
      title: "Local", updated_at: "2024-01-01",
    }
    const remote: RowWithModified = {
      completed: true, id: 1, modified_at: "2024-01-01T00:00:00Z", priority: 2,
      title: "Remote", updated_at: "2024-01-02",
    }

    const result = resolver(local, remote, baseContext)

    expect((result as any).title).toBe("Local")
  })
})

describe("fieldLevelMerge", () => {
  it("uses local values when local is newer", () => {
    const resolver = fieldLevelMerge<Row>()
    const local: TrackedRow<Row> = {
      completed: false, id: 1, priority: 3, title: "Local title",
      updated_at: "2024-01-02T00:00:00Z",
    }
    const remote: Row = {
      completed: true, id: 1, priority: 1, title: "Remote title",
      updated_at: "2024-01-01T00:00:00Z",
    }

    const result = resolver(local, remote, baseContext)

    expect((result as any).title).toBe("Local title")
    expect((result as any).priority).toBe(3)
  })

  it("respects serverOwnedFields", () => {
    const resolver = fieldLevelMerge<Row>({
      serverOwnedFields: ["priority"],
    })
    const local: TrackedRow<Row> = {
      completed: false, id: 1, priority: 99, title: "Local",
      updated_at: "2024-01-02T00:00:00Z",
    }
    const remote: Row = {
      completed: true, id: 1, priority: 1, title: "Remote",
      updated_at: "2024-01-01T00:00:00Z",
    }

    const result = resolver(local, remote, baseContext)


    // priority is server-owned, should use remote value
    expect((result as any).priority).toBe(1)

    // title is not server-owned, local is newer
    expect((result as any).title).toBe("Local")
  })

  it("respects clientOwnedFields", () => {
    const resolver = fieldLevelMerge<Row>({
      clientOwnedFields: ["title"],
    })
    const local: TrackedRow<Row> = {
      completed: false, id: 1, priority: 1, title: "Client title",
      updated_at: "2024-01-01T00:00:00Z", // older
    }
    const remote: Row = {
      completed: true, id: 1, priority: 5, title: "Server title",
      updated_at: "2024-01-02T00:00:00Z", // newer
    }

    const result = resolver(local, remote, baseContext)


    // title is client-owned, always use local
    expect((result as any).title).toBe("Client title")

    // Other fields use remote since remote is newer
    expect((result as any).completed).toBe(true)
  })
})

describe("resolveConflict", () => {
  it("returns remote when local is undefined", () => {
    const remote: Row = { completed: false, id: 1, priority: 1, title: "Remote", updated_at: "" }
    const result = resolveConflict(undefined, remote, {}, baseContext)

    expect(result).toEqual(remote)
  })

  it("uses configured strategy", () => {
    const local: TrackedRow<Row> = {
      completed: false, id: 1, priority: 1, title: "Local", updated_at: "2024-01-02",
    }
    const remote: Row = {
      completed: true, id: 1, priority: 2, title: "Remote", updated_at: "2024-01-01",
    }

    const lww = resolveConflict(local, remote, { strategy: "last-write-wins" }, baseContext)

    expect((lww as any).title).toBe("Local")

    const sw = resolveConflict(local, remote, { strategy: "server-wins" }, baseContext)

    expect((sw as any).title).toBe("Remote")
  })

  it("uses custom resolver when provided", () => {
    const local: TrackedRow<Row> = {
      completed: false, id: 1, priority: 1, title: "Local", updated_at: "",
    }
    const remote: Row = {
      completed: true, id: 1, priority: 2, title: "Remote", updated_at: "",
    }

    const result = resolveConflict(
      local,
      remote,
      {
        resolver: (l, r) => ({
          ...r,
          title: l.title, // Keep local title but use remote for everything else
        }),
      },
      baseContext,
    )

    expect((result as any).title).toBe("Local")
    expect((result as any).completed).toBe(true)
  })
})
