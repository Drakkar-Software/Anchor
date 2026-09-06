import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AppLifecycleAdapter } from "../types.js"
import { setupAppLifecycle } from "./appLifecycle.js"

function createMockLifecycleAdapter(): AppLifecycleAdapter & {
  triggerBackground: () => void
  triggerForeground: () => void
} {
  const foregroundCbs = new Set<() => void>()
  const backgroundCbs = new Set<() => void>()

  return {
    onBackground(cb) {
      backgroundCbs.add(cb)

      return () => backgroundCbs.delete(cb)
    },

    onForeground(cb) {
      foregroundCbs.add(cb)

      return () => foregroundCbs.delete(cb)
    },

    triggerBackground: () => {
      for (const cb of backgroundCbs) {cb()}
    },

    triggerForeground: () => {
      for (const cb of foregroundCbs) {cb()}
    },
  }
}

function createMockStore(overrides: Record<string, unknown> = {}) {
  return {
    getInitialState: vi.fn(),

    getState: () => ({
      error: null,
      isHydrated: true,
      isLoading: false,
      isRestoring: false,
      lastFetchedAt: null,
      order: [],
      realtimeStatus: "disconnected" as const,
      records: new Map(),
      refetch: vi.fn().mockResolvedValue([]),
      ...overrides,
    }),

    setState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as any
}

describe("setupAppLifecycle", () => {
  let adapter: ReturnType<typeof createMockLifecycleAdapter>

  beforeEach(() => {
    adapter = createMockLifecycleAdapter()
  })

  it("flushes queue on foreground", () => {
    const flush = vi.fn().mockResolvedValue(undefined)

    setupAppLifecycle({
      adapter,
      queue: { flush },
    })

    adapter.triggerForeground()
    expect(flush).toHaveBeenCalledOnce()
  })

  it("refreshes auth session on foreground", () => {
    const refreshSession = vi.fn().mockResolvedValue(undefined)
    const authStore = {
      getState: () => ({ refreshSession }),
    } as any

    setupAppLifecycle({
      adapter,
      authStore,
    })

    adapter.triggerForeground()
    expect(refreshSession).toHaveBeenCalledOnce()
  })

  it("revalidates stale stores on foreground", () => {
    const refetch = vi.fn().mockResolvedValue([])

    // lastFetchedAt is old enough to be stale
    const store = createMockStore({
      lastFetchedAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      refetch,
    })

    setupAppLifecycle({
      adapter,
      staleTTL: 5 * 60 * 1000,
      stores: [store],
    })

    adapter.triggerForeground()
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("does not revalidate fresh stores", () => {
    const refetch = vi.fn().mockResolvedValue([])
    const store = createMockStore({
      lastFetchedAt: Date.now() - 1000, // 1 second ago
      refetch,
    })

    setupAppLifecycle({
      adapter,
      staleTTL: 5 * 60 * 1000,
      stores: [store],
    })

    adapter.triggerForeground()
    expect(refetch).not.toHaveBeenCalled()
  })

  it("skips operations when offline", () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const network = {
      isOnline: () => false,
      subscribe: () => () => {},
    }

    setupAppLifecycle({
      adapter,
      network,
      queue: { flush },
    })

    adapter.triggerForeground()
    expect(flush).not.toHaveBeenCalled()
  })

  it("respects flushQueueOnForeground: false", () => {
    const flush = vi.fn().mockResolvedValue(undefined)

    setupAppLifecycle({
      adapter,
      flushQueueOnForeground: false,
      queue: { flush },
    })

    adapter.triggerForeground()
    expect(flush).not.toHaveBeenCalled()
  })

  it("respects refreshAuthOnForeground: false", () => {
    const refreshSession = vi.fn().mockResolvedValue(undefined)
    const authStore = {
      getState: () => ({ refreshSession }),
    } as any

    setupAppLifecycle({
      adapter,
      authStore,
      refreshAuthOnForeground: false,
    })

    adapter.triggerForeground()
    expect(refreshSession).not.toHaveBeenCalled()
  })

  it("cleanup unsubscribes all listeners", () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const cleanup = setupAppLifecycle({
      adapter,
      queue: { flush },
    })

    cleanup()

    adapter.triggerForeground()
    expect(flush).not.toHaveBeenCalled()
  })

  it("handles errors in flush gracefully", () => {
    const flush = vi.fn().mockRejectedValue(new Error("flush failed"))

    setupAppLifecycle({
      adapter,
      queue: { flush },
    })

    // Should not throw
    expect(() => adapter.triggerForeground()).not.toThrow()
  })

  it("pauses realtime on background when configured", () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => () => {})
    const store = createMockStore({
      realtimeStatus: "connected" as const,
      subscribe,
      unsubscribe,
    })

    setupAppLifecycle({
      adapter,
      pauseRealtimeOnBackground: true,
      stores: [store],
    })

    adapter.triggerBackground()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it("resumes realtime on foreground after background pause", () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => () => {})
    const store = createMockStore({
      realtimeStatus: "disconnected" as const,
      subscribe,
      unsubscribe,
    })

    setupAppLifecycle({
      adapter,
      pauseRealtimeOnBackground: true,
      stores: [store],
    })

    // Foreground should call subscribe since status is disconnected
    adapter.triggerForeground()
    expect(subscribe).toHaveBeenCalledOnce()
  })

  it("does not pause realtime on background when not configured", () => {
    const unsubscribe = vi.fn()
    const store = createMockStore({
      realtimeStatus: "connected" as const,
      unsubscribe,
    })

    setupAppLifecycle({
      adapter,
      stores: [store],

      // pauseRealtimeOnBackground defaults to false
    })

    adapter.triggerBackground()
    expect(unsubscribe).not.toHaveBeenCalled()
  })
})
