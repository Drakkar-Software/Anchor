import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BackgroundTaskAdapter } from "../types.js"
import { isBackgroundSyncRegistered,setupBackgroundSync } from "./backgroundSync.js"

function createMockBackgroundAdapter(): BackgroundTaskAdapter & {
  handlers: Map<string, () => Promise<void>>
} {
  const handlers = new Map<string, () => Promise<void>>()

  return {
    handlers,

    async isRegistered(taskName: string) {
      return handlers.has(taskName)
    },

    async register(taskName: string, handler: () => Promise<void>) {
      handlers.set(taskName, handler)
    },

    async unregister(taskName: string) {
      handlers.delete(taskName)
    },
  }
}

describe("setupBackgroundSync", () => {
  let adapter: ReturnType<typeof createMockBackgroundAdapter>
  let flush: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = createMockBackgroundAdapter()
    flush = vi.fn().mockResolvedValue(undefined)
  })

  it("registers a background task", async () => {
    await setupBackgroundSync({ flush }, adapter)
    expect(adapter.handlers.has("anchor:background-sync")).toBe(true)
  })

  it("registered handler calls queue.flush()", async () => {
    await setupBackgroundSync({ flush }, adapter)

    const handler = adapter.handlers.get("anchor:background-sync")!

    await handler()
    expect(flush).toHaveBeenCalledOnce()
  })

  it("uses custom task name", async () => {
    await setupBackgroundSync({ flush }, adapter, {
      taskName: "custom-sync",
    })
    expect(adapter.handlers.has("custom-sync")).toBe(true)
    expect(adapter.handlers.has("anchor:background-sync")).toBe(false)
  })

  it("cleanup unregisters the task", async () => {
    const cleanup = await setupBackgroundSync({ flush }, adapter)

    expect(adapter.handlers.has("anchor:background-sync")).toBe(true)

    await cleanup()
    expect(adapter.handlers.has("anchor:background-sync")).toBe(false)
  })

  it("cleanup unregisters custom task name", async () => {
    const cleanup = await setupBackgroundSync({ flush }, adapter, {
      taskName: "my-task",
    })

    expect(adapter.handlers.has("my-task")).toBe(true)

    await cleanup()
    expect(adapter.handlers.has("my-task")).toBe(false)
  })
})

describe("isBackgroundSyncRegistered", () => {
  it("returns false when not registered", async () => {
    const adapter = createMockBackgroundAdapter()

    expect(await isBackgroundSyncRegistered(adapter)).toBe(false)
  })

  it("returns true when registered", async () => {
    const adapter = createMockBackgroundAdapter()
    const flush = vi.fn().mockResolvedValue(undefined)

    await setupBackgroundSync({ flush }, adapter)
    expect(await isBackgroundSyncRegistered(adapter)).toBe(true)
  })

  it("supports custom task name", async () => {
    const adapter = createMockBackgroundAdapter()
    const flush = vi.fn().mockResolvedValue(undefined)

    await setupBackgroundSync({ flush }, adapter, { taskName: "custom" })
    expect(await isBackgroundSyncRegistered(adapter, "custom")).toBe(true)
    expect(await isBackgroundSyncRegistered(adapter)).toBe(false)
  })
})
