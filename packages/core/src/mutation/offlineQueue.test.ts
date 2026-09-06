import { describe, expect, it, vi } from "vitest"

import { ManualNetworkStatus } from "../network/onlineManager.js"
import { MemoryAdapter } from "../persistence/persistenceAdapter.js"
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

describe("OfflineQueue", () => {
  describe("enqueue", () => {
    it("adds a mutation to the queue", async () => {
      const queue = new OfflineQueue()
      const mutation = createMutation()

      await queue.enqueue(mutation)

      expect(queue.pendingCount).toBe(1)
      expect(queue.isDirty).toBe(true)
    })

    it("persists to adapter when configured", async () => {
      const adapter = new MemoryAdapter()
      const queue = new OfflineQueue({ adapter })

      await queue.enqueue(createMutation())

      const persisted = await adapter.getItem<QueuedMutation[]>(
        "anchor:__mutation_queue",
      )

      expect(persisted).toHaveLength(1)
    })
  })

  describe("compact", () => {
    it("merges INSERT + UPDATE into single INSERT", async () => {
      const queue = new OfflineQueue()

      await queue.enqueue(
        createMutation({
          id: "m1",
          operation: "INSERT",
          payload: { id: 1, title: "Original" },
          primaryKey: { id: 1 },
        }),
      )
      await queue.enqueue(
        createMutation({
          id: "m2",
          operation: "UPDATE",
          payload: { title: "Updated" },
          primaryKey: { id: 1 },
        }),
      )

      queue.compact()

      expect(queue.pendingCount).toBe(1)

      const pending = queue.pendingMutations

      expect(pending[0]!.operation).toBe("INSERT")
      expect(pending[0]!.payload).toEqual({ id: 1, title: "Updated" })
    })

    it("removes INSERT + DELETE pair entirely", async () => {
      const queue = new OfflineQueue()

      await queue.enqueue(
        createMutation({
          id: "m1",
          operation: "INSERT",
          primaryKey: { id: 1 },
        }),
      )
      await queue.enqueue(
        createMutation({
          id: "m2",
          operation: "DELETE",
          payload: null,
          primaryKey: { id: 1 },
        }),
      )

      queue.compact()

      expect(queue.pendingCount).toBe(0)
    })

    it("merges UPDATE + UPDATE into single UPDATE", async () => {
      const queue = new OfflineQueue()

      await queue.enqueue(
        createMutation({
          id: "m1",
          operation: "UPDATE",
          payload: { title: "First" },
          primaryKey: { id: 1 },
        }),
      )
      await queue.enqueue(
        createMutation({
          id: "m2",
          operation: "UPDATE",
          payload: { completed: true },
          primaryKey: { id: 1 },
        }),
      )

      queue.compact()

      expect(queue.pendingCount).toBe(1)
      expect(queue.pendingMutations[0]!.payload).toEqual({
        completed: true,
        title: "First",
      })
    })

    it("replaces UPDATE + DELETE with DELETE", async () => {
      const queue = new OfflineQueue()

      await queue.enqueue(
        createMutation({
          id: "m1",
          operation: "UPDATE",
          payload: { title: "Updated" },
          primaryKey: { id: 1 },
          rollbackSnapshot: { id: 1, title: "Original" },
        }),
      )
      await queue.enqueue(
        createMutation({
          id: "m2",
          operation: "DELETE",
          payload: null,
          primaryKey: { id: 1 },
        }),
      )

      queue.compact()

      expect(queue.pendingCount).toBe(1)
      expect(queue.pendingMutations[0]!.operation).toBe("DELETE")

      // Should keep the original rollback snapshot
      expect(queue.pendingMutations[0]!.rollbackSnapshot).toEqual({
        id: 1,
        title: "Original",
      })
    })

    it("does not compact mutations for different rows", async () => {
      const queue = new OfflineQueue()

      await queue.enqueue(
        createMutation({
          operation: "UPDATE",
          payload: { title: "A" },
          primaryKey: { id: 1 },
        }),
      )
      await queue.enqueue(
        createMutation({
          operation: "UPDATE",
          payload: { title: "B" },
          primaryKey: { id: 2 },
        }),
      )

      queue.compact()

      expect(queue.pendingCount).toBe(2)
    })

    it("does not compact two users' writes to the same row", async () => {
      // Coalescing defeated the isolation the flush filter provides, one line
      // earlier. `UPDATE + UPDATE` merges the newer payload into the OLDER
      // mutation, and the older one carries the older `userId` — so B's edit
      // went out under A's session, or waited for an A who never signed back
      // in. Two people on one device is the whole reason mutations are tagged.
      const queue = new OfflineQueue()
      const executor = vi.fn().mockResolvedValue({})

      queue.registerExecutor("todos", executor)

      queue.setUserId("user-A")
      await queue.enqueue(
        createMutation({
          id: "m1",
          operation: "UPDATE",
          payload: { title: "A" },
          primaryKey: { id: 1 },
        }),
      )
      queue.setUserId("user-B")
      await queue.enqueue(
        createMutation({
          id: "m2",
          operation: "UPDATE",
          payload: { title: "B" },
          primaryKey: { id: 1 },
        }),
      )

      const result = await queue.flush()

      // B is the one signed in: B's write goes out, unmerged, and A's waits.
      expect(executor).toHaveBeenCalledTimes(1)
      expect(executor.mock.calls[0]![0].payload).toEqual({ title: "B" })
      expect(result.succeeded).toHaveLength(1)
      expect(queue.pendingCount).toBe(1)
    })
  })

  describe("flush", () => {
    it("executes mutations via registered executor", async () => {
      const queue = new OfflineQueue()
      const executor = vi.fn().mockResolvedValue({})

      queue.registerExecutor("todos", executor)

      await queue.enqueue(createMutation())

      const result = await queue.flush()

      expect(executor).toHaveBeenCalledTimes(1)
      expect(result.succeeded).toHaveLength(1)
      expect(result.complete).toBe(true)
    })

    it("stops on first failure", async () => {
      const queue = new OfflineQueue({ maxRetries: 3 })
      const executor = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValue({})

      queue.registerExecutor("todos", executor)

      await queue.enqueue(createMutation({ id: "m1" }))
      await queue.enqueue(createMutation({ id: "m2" }))

      const result = await queue.flush()

      expect(executor).toHaveBeenCalledTimes(1) // Stopped after first failure
      expect(result.failed).toHaveLength(1)
      expect(result.complete).toBe(false)
    })

    it("rolls back after max retries", async () => {
      const onRollback = vi.fn()
      const queue = new OfflineQueue({ maxRetries: 0, onRollback })
      const executor = vi.fn().mockRejectedValue(new Error("Permanent error"))

      queue.registerExecutor("todos", executor)

      await queue.enqueue(createMutation())

      // First flush: retryCount goes to 1, hits maxRetries
      const result = await queue.flush()

      expect(result.rolledBack).toHaveLength(1)
      expect(onRollback).toHaveBeenCalledTimes(1)
      expect(queue.pendingCount).toBe(0) // Rolled back mutation removed
    })

    it("does not flush when already flushing", async () => {
      const queue = new OfflineQueue()

      let resolveExecutor: () => void

      const executor = vi.fn().mockImplementation(
        async () => await new Promise<{}>((resolve) => {
          resolveExecutor = () => resolve({})
        }),
      )

      queue.registerExecutor("todos", executor)
      await queue.enqueue(createMutation())

      // Start first flush
      const flush1 = queue.flush()

      // Try second flush immediately
      const flush2 = queue.flush()

      const result2 = await flush2

      expect(result2.complete).toBe(false) // Skipped because already flushing

      resolveExecutor!()
      await flush1
    })

    it("comes back for work that arrived while it was running", async () => {
      // The other half of the test above, and the reason declining a concurrent
      // flush is not free. `pending` is filtered before the first `await`, so a
      // mutation enqueued mid-flush is in neither batch: not this one, which
      // never saw it, and not a next one, because the request that would have
      // started it was dropped on the floor.
      //
      // Since 2.2.1 there are only two other triggers — a connectivity
      // transition and an auth event — and a signed-in device sitting on wifi
      // produces neither, so the write waited for a relaunch. Same stranding
      // 2.2.2 fixed at boot, one layer along.
      const queue = new OfflineQueue({ flushDebounceMs: 1 })

      let release!: () => void

      const gate = new Promise<void>((r) => { release = r })
      const executor = vi.fn(async (m: QueuedMutation) => {
        if (m.id === "m1") {await gate}

        return {}
      })

      queue.registerExecutor("todos", executor as never)

      await queue.enqueue(createMutation({ id: "m1", primaryKey: { id: 1 } }))

      // Let the debounced flush start and park on the gate.
      await new Promise((r) => setTimeout(r, 20))

      await queue.enqueue(createMutation({ id: "m2", primaryKey: { id: 2 } }))

      // Its own debounced flush fires here and finds one already running.
      await new Promise((r) => setTimeout(r, 20))

      release()

      // Nothing else is coming: no network transition, no auth event, no third
      // enqueue. Draining is the queue's own business.
      // Waited on the executor, not on `pendingCount`: a mutation that was
      // pruned, rolled back or dropped reaches a count of zero too, so the
      // count alone cannot tell "drained" from "gone".
      await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2))
      expect(executor.mock.calls[1]![0].id).toBe("m2")
      expect(queue.pendingCount).toBe(0)
    })

    it("does not flush when offline", async () => {
      const network = new ManualNetworkStatus()

      network.setOnline(false)

      const queue = new OfflineQueue({ network })
      const executor = vi.fn().mockResolvedValue({})

      queue.registerExecutor("todos", executor)

      await queue.enqueue(createMutation())

      const result = await queue.flush()

      expect(executor).not.toHaveBeenCalled()
      expect(result.complete).toBe(false)
    })
  })

  describe("hydrate", () => {
    it("loads queue from persistence", async () => {
      const adapter = new MemoryAdapter()

      await adapter.setItem("anchor:__mutation_queue", [
        createMutation({ id: "persisted-1", status: "pending" }),
        createMutation({ id: "persisted-2", status: "failed" }),
        createMutation({ id: "done", status: "succeeded" }), // Should be filtered out
      ])

      const queue = new OfflineQueue({ adapter })

      await queue.hydrate()

      expect(queue.pendingCount).toBe(2)
    })
  })

  describe("clearQueue", () => {
    it("clears all mutations and persisted state", async () => {
      const adapter = new MemoryAdapter()
      const queue = new OfflineQueue({ adapter })

      await queue.enqueue(createMutation({ id: "m1" }))
      await queue.enqueue(createMutation({ id: "m2" }))

      expect(queue.pendingCount).toBe(2)

      await queue.clearQueue()

      expect(queue.pendingCount).toBe(0)


      // Verify persistence was also cleared
      const persisted = await adapter.getItem<any[]>("anchor:__mutation_queue")

      expect(persisted).toEqual([])
    })
  })

  describe("user isolation", () => {
    it("tags enqueued mutations with current userId", async () => {
      const queue = new OfflineQueue()

      queue.setUserId("user-A")

      const executor = vi.fn().mockResolvedValue({})

      queue.registerExecutor("todos", executor)

      const mutation = createMutation({ id: "m1" })

      await queue.enqueue(mutation)

      expect(mutation.userId).toBe("user-A")
    })

    it("skips mutations from a different user on flush", async () => {
      const queue = new OfflineQueue()
      const executor = vi.fn().mockResolvedValue({})

      queue.registerExecutor("todos", executor)

      // Enqueue as user-A
      queue.setUserId("user-A")
      await queue.enqueue(createMutation({ id: "m1" }))

      // Switch to user-B
      queue.setUserId("user-B")

      const result = await queue.flush()

      // user-A's mutation should be skipped
      expect(executor).not.toHaveBeenCalled()
      expect(result.succeeded).toHaveLength(0)

      // mutation still pending
      expect(queue.pendingCount).toBe(1)
    })

    it("flushes untagged mutations regardless of current user", async () => {
      const queue = new OfflineQueue()
      const executor = vi.fn().mockResolvedValue({})

      queue.registerExecutor("todos", executor)

      // Enqueue without userId
      await queue.enqueue(createMutation({ id: "m1" }))

      // Set user context
      queue.setUserId("user-A")

      const result = await queue.flush()

      // Untagged mutation should flush for any user
      expect(executor).toHaveBeenCalledTimes(1)
      expect(result.succeeded).toHaveLength(1)
    })

    it("holds a tagged mutation while nobody is signed in", async () => {
      // No current user is a signed-out session, not a wildcard. The filter
      // used to read `!m.userId || !this.currentUserId || m.userId === ...`,
      // whose middle arm made every tagged mutation eligible the moment the
      // gate cleared the user — which is exactly what SIGNED_OUT does, and
      // supabase-js emits that by itself once a refresh token fails to renew.
      // The replay then goes out with no JWT, as `anon`, RLS refuses it 42501,
      // and a refusal is correctly not retried as transport: the write is
      // rolled back and gone. Not clearing the queue on sign-out only helps if
      // the queue also declines to run it.
      const queue = new OfflineQueue()
      const executor = vi.fn().mockResolvedValue({})

      queue.registerExecutor("todos", executor)

      queue.setUserId("user-A")
      await queue.enqueue(createMutation({ id: "m1" }))

      queue.setUserId(undefined)

      const result = await queue.flush()

      expect(executor).not.toHaveBeenCalled()
      expect(result.succeeded).toHaveLength(0)
      expect(queue.pendingCount).toBe(1)
    })

    it("runs it once its own user is back", async () => {
      // The other half: holding it forever would be its own kind of data loss.
      const queue = new OfflineQueue()
      const executor = vi.fn().mockResolvedValue({})

      queue.registerExecutor("todos", executor)

      queue.setUserId("user-A")
      await queue.enqueue(createMutation({ id: "m1" }))
      queue.setUserId(undefined)
      await queue.flush()

      queue.setUserId("user-A")

      const result = await queue.flush()

      expect(executor).toHaveBeenCalledTimes(1)
      expect(result.succeeded).toHaveLength(1)
      expect(queue.pendingCount).toBe(0)
    })
  })

  describe("auto-flush on reconnect", () => {
    it("schedules flush when coming online", async () => {
      const network = new ManualNetworkStatus()

      network.setOnline(false)

      const queue = new OfflineQueue({ flushDebounceMs: 10, network })
      const executor = vi.fn().mockResolvedValue({})

      queue.registerExecutor("todos", executor)

      await queue.enqueue(createMutation())
      queue.startAutoFlush()

      // Come online
      network.setOnline(true)

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(executor).toHaveBeenCalledTimes(1)

      queue.destroy()
    })
  })
})
