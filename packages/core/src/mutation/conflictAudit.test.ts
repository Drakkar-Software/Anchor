import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ConflictConfig, ConflictContext, TrackedRow } from "../types.js"
import { ConflictAuditLog } from "./conflictAudit.js"
import { resolveConflict } from "./conflictResolution.js"

describe("ConflictAuditLog", () => {
  let auditLog: ConflictAuditLog

  beforeEach(() => {
    auditLog = new ConflictAuditLog()
  })

  it("record() adds entry with auto-timestamp", () => {
    const before = Date.now()

    auditLog.record({
      localValue: { id: 1, title: "local" },
      remoteValue: { id: 1, title: "remote" },
      resolvedValue: { id: 1, title: "remote" },
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
    })

    const after = Date.now()

    const log = auditLog.getLog()

    expect(log).toHaveLength(1)
    expect(log[0].timestamp).toBeGreaterThanOrEqual(before)
    expect(log[0].timestamp).toBeLessThanOrEqual(after)
    expect(log[0].table).toBe("todos")
    expect(log[0].rowId).toBe(1)
  })

  it("getLog() returns all entries", () => {
    auditLog.record({
      localValue: { id: 1 },
      remoteValue: { id: 1 },
      resolvedValue: { id: 1 },
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
    })
    auditLog.record({
      localValue: { id: 2 },
      remoteValue: { id: 2 },
      resolvedValue: { id: 2 },
      rowId: 2,
      strategy: "client-wins",
      table: "users",
    })

    const log = auditLog.getLog()

    expect(log).toHaveLength(2)
  })

  it("getLog() returns a copy, not the internal array", () => {
    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
    })

    const log1 = auditLog.getLog()
    const log2 = auditLog.getLog()

    expect(log1).not.toBe(log2)
    expect(log1).toEqual(log2)
  })

  it("getLog({ table }) filters by table", () => {
    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
    })
    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 2,
      strategy: "server-wins",
      table: "users",
    })
    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 3,
      strategy: "client-wins",
      table: "todos",
    })

    const todosLog = auditLog.getLog({ table: "todos" })

    expect(todosLog).toHaveLength(2)
    expect(todosLog.every((e) => e.table === "todos")).toBe(true)
  })

  it("getLog({ since }) filters by timestamp", () => {
    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
    })

    const midpoint = Date.now() + 1

    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 2,
      strategy: "server-wins",
      table: "todos",
    })

    // The second entry may have the same timestamp as midpoint,
    // so we use a future time to verify filtering works
    const futureLog = auditLog.getLog({ since: midpoint + 10_000 })

    expect(futureLog).toHaveLength(0)

    const allLog = auditLog.getLog({ since: 0 })

    expect(allLog).toHaveLength(2)
  })

  it("clearLog() empties the log", () => {
    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
    })
    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 2,
      strategy: "server-wins",
      table: "todos",
    })

    expect(auditLog.getLog()).toHaveLength(2)
    auditLog.clearLog()
    expect(auditLog.getLog()).toHaveLength(0)
  })

  it("onConflict callback fires on record", () => {
    const cb = vi.fn()

    auditLog.onConflict(cb)

    auditLog.record({
      localValue: { id: 1 },
      remoteValue: { id: 1 },
      resolvedValue: { id: 1 },
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
    })

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        rowId: 1,
        strategy: "server-wins",
        table: "todos",
        timestamp: expect.any(Number),
      }),
    )
  })

  it("multiple subscribers receive events", () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()

    auditLog.onConflict(cb1)
    auditLog.onConflict(cb2)

    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
    })

    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
  })

  it("unsubscribe stops callbacks", () => {
    const cb = vi.fn()
    const unsub = auditLog.onConflict(cb)

    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
    })
    expect(cb).toHaveBeenCalledTimes(1)

    unsub()

    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 2,
      strategy: "server-wins",
      table: "todos",
    })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it("integration: resolveConflict with auditLog logs the conflict", () => {
    type Row = { id: number; title: string }

    const local: TrackedRow<Row> = {
      _anchor_mutationId: "mut-1",
      _anchor_optimistic: true,
      _anchor_pending: "update",
      id: 1,
      title: "local title",
    }
    const remote: Row = { id: 1, title: "remote title" }
    const config: ConflictConfig<Row> = { strategy: "server-wins" }
    const context: ConflictContext = {
      hasPendingMutations: true,
      pendingMutations: [],
      primaryKey: { id: 1 },
      table: "todos",
    }

    const result = resolveConflict(local, remote, config, context, auditLog)

    expect(result).toEqual({ id: 1, title: "remote title" })

    const log = auditLog.getLog()

    expect(log).toHaveLength(1)
    expect(log[0].table).toBe("todos")
    expect(log[0].rowId).toBe(1)
    expect(log[0].strategy).toBe("server-wins")
    expect(log[0].localValue).toEqual(local)
    expect(log[0].remoteValue).toEqual(remote)
    expect(log[0].resolvedValue).toEqual({ id: 1, title: "remote title" })
  })

  it("records userId when provided", () => {
    auditLog.record({
      localValue: { id: 1 },
      remoteValue: { id: 1 },
      resolvedValue: { id: 1 },
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
      userId: "user-A",
    })

    const log = auditLog.getLog()

    expect(log[0].userId).toBe("user-A")
  })

  it("getLog({ userId }) filters by user", () => {
    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 1,
      strategy: "server-wins",
      table: "todos",
      userId: "user-A",
    })
    auditLog.record({
      localValue: {},
      remoteValue: {},
      resolvedValue: {},
      rowId: 2,
      strategy: "server-wins",
      table: "todos",
      userId: "user-B",
    })

    const userALog = auditLog.getLog({ userId: "user-A" })

    expect(userALog).toHaveLength(1)
    expect(userALog[0].rowId).toBe(1)
  })

  it("integration: resolveConflict without auditLog does not throw", () => {
    type Row = { id: number; title: string }

    const local: TrackedRow<Row> = { id: 1, title: "local" }
    const remote: Row = { id: 1, title: "remote" }
    const config: ConflictConfig<Row> = { strategy: "client-wins" }
    const context: ConflictContext = {
      hasPendingMutations: false,
      pendingMutations: [],
      primaryKey: { id: 1 },
      table: "todos",
    }

    const result = resolveConflict(local, remote, config, context)

    expect(result).toEqual({ id: 1, title: "local" })
    expect(auditLog.getLog()).toHaveLength(0)
  })
})
