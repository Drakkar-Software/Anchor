import { describe, expect, it, vi } from "vitest"

import type { QueuedMutation } from "../types.js"
import { OfflineQueue } from "./offlineQueue.js"

function createMutation(
  overrides: Partial<QueuedMutation> = {},
): QueuedMutation {
  return {
    createdAt: Date.now(),
    id: crypto.randomUUID(),
    operation: "INSERT",
    payload: { title: "Test" },
    primaryKey: { id: 1 },
    retryCount: 0,
    rollbackSnapshot: null,
    status: "pending",
    table: "todos",
    ...overrides,
  }
}

describe("OfflineQueue dependsOn enforcement", () => {
  it("skips mutation when dependency has not succeeded", async () => {
    const queue = new OfflineQueue()
    const executor = vi.fn().mockResolvedValue({})

    queue.registerExecutor("todos", executor)

    const parentId = "parent-1"
    const childId = "child-1"

    // Parent mutation fails
    const failingExecutor = vi.fn().mockRejectedValue(new Error("fail"))

    queue.registerExecutor("todos", failingExecutor)

    await queue.enqueue(createMutation({
      id: parentId,
      operation: "INSERT",
      payload: { title: "Parent" },
    }))

    await queue.enqueue(createMutation({
      dependsOn: parentId,
      id: childId,
      operation: "INSERT",
      payload: { parentId: "temp-id" },
    }))

    const result = await queue.flush()

    // Parent failed (not rolled back, retryCount < maxRetries)
    expect(result.failed).toContain(parentId)

    // Child was skipped (not in succeeded, failed, or rolledBack)
    expect(result.succeeded).not.toContain(childId)
    expect(result.failed).not.toContain(childId)

    // Child is still pending for next flush
    expect(queue.pendingCount).toBe(2)
  })

  it("executes mutation when dependency has succeeded", async () => {
    const queue = new OfflineQueue()
    const executor = vi.fn().mockResolvedValue({ serverId: 42 })

    queue.registerExecutor("todos", executor)

    const parentId = "parent-2"
    const childId = "child-2"

    await queue.enqueue(createMutation({
      id: parentId,
      operation: "INSERT",
      payload: { title: "Parent" },
      primaryKey: { id: "_temp:abc" },
    }))

    await queue.enqueue(createMutation({
      dependsOn: parentId,
      id: childId,
      operation: "INSERT",
      payload: { title: "Child" },
    }))

    const result = await queue.flush()

    // Both should succeed
    expect(result.succeeded).toContain(parentId)
    expect(result.succeeded).toContain(childId)
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it("cascades rollback when dependency is rolled back", async () => {
    const onRollback = vi.fn()
    const queue = new OfflineQueue({ maxRetries: 0, onRollback })

    const failingExecutor = vi.fn().mockRejectedValue(new Error("permanent"))

    queue.registerExecutor("todos", failingExecutor)

    const parentId = "parent-3"
    const childId = "child-3"

    await queue.enqueue(createMutation({
      id: parentId,
      operation: "INSERT",
      payload: { title: "Parent" },
    }))

    await queue.enqueue(createMutation({
      dependsOn: parentId,
      id: childId,
      operation: "INSERT",
      payload: { title: "Child" },
    }))

    const result = await queue.flush()

    // Parent rolled back
    expect(result.rolledBack).toContain(parentId)

    // Child cascaded rollback
    expect(result.rolledBack).toContain(childId)
    expect(onRollback).toHaveBeenCalledTimes(2)

    // Both removed from queue
    expect(queue.pendingCount).toBe(0)
  })
})

/**
 * `dependsOn` had no producer until `offlineQueue.queueWrites` (2.2.0) started
 * setting it on every write to a row that already had one queued. These two
 * cases strand a mutation in the queue permanently, and neither is reachable
 * while nothing sets the field — which is why they survived this long.
 */
describe("a dependency that is no longer in the queue", () => {
  it("does not strand its dependent when it succeeded in an earlier flush", async () => {
    const queue = new OfflineQueue()
    const parentId = "parent-1"
    const childId = "child-1"

    let call = 0

    queue.registerExecutor("todos", async (m) => {
      call++


      // The child fails once, which stops the flush; the parent has already
      // succeeded and is pruned before the retry.
      if (m.id === childId && call === 2) {throw new Error("transient")}

      return {}
    })

    // Two different rows: a dependency between mutations on the *same* row is
    // coalesced away by compact() before flush ever sees it, so the same-row
    // version of this proves nothing.
    await queue.enqueue(
      createMutation({ id: parentId, operation: "INSERT", primaryKey: { id: 1 } }),
    )
    await queue.enqueue(
      createMutation({
        dependsOn: parentId,
        id: childId,
        operation: "INSERT",
        primaryKey: { id: 2 },
      }),
    )

    await queue.flush()

    const second = await queue.flush()

    expect(second.succeeded).toContain(childId)
    expect(queue.pendingCount).toBe(0)
  })

  it("does not strand a delete that compact() merged its dependency into", async () => {
    // compact() turns UPDATE+DELETE on one row into the DELETE alone, keeping
    // the DELETE's id — and the DELETE depends on the UPDATE it just replaced.
    const queue = new OfflineQueue()
    const executor = vi.fn().mockResolvedValue({})

    queue.registerExecutor("todos", executor)

    await queue.enqueue(
      createMutation({ id: "u1", operation: "UPDATE", payload: { title: "B" } }),
    )
    await queue.enqueue(
      createMutation({ dependsOn: "u1", id: "d1", operation: "DELETE", payload: null }),
    )

    const result = await queue.flush()

    expect(result.succeeded).toContain("d1")
    expect(queue.pendingCount).toBe(0)
  })
})
