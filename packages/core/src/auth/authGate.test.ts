import { describe, expect, it, vi } from "vitest"
import type { StoreApi } from "zustand"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import type { TableStore } from "../types.js"
import { isRlsError, setupAuthGate } from "./authGate.js"
import { createAuthStore } from "./authStore.js"

describe("isRlsError", () => {
  it("returns false for null", () => {
    expect(isRlsError(null)).toBe(false)
  })

  it("detects RLS policy violation", () => {
    expect(isRlsError(new Error("new row violates row-level security policy"))).toBe(true)
  })

  it("detects permission denied", () => {
    expect(isRlsError(new Error("permission denied for table users"))).toBe(true)
  })

  it("detects 42501 code", () => {
    expect(isRlsError(new Error("ERROR: 42501 insufficient_privilege"))).toBe(true)
  })

  it("returns false for unrelated errors", () => {
    expect(isRlsError(new Error("network timeout"))).toBe(false)
  })
})

describe("setupAuthGate", () => {
  function createMockTableStore() {
    // One state object, not a fresh one per `getState()` call — otherwise every
    // action is a brand-new spy and no assertion about what the gate called can
    // ever see it.
    const state = {
      clearAll: vi.fn(),
      fetch: vi.fn(async () => await Promise.resolve([])),
    }
    const store = {
      _state: state,
      getState: vi.fn(() => state),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }

    return store as unknown as StoreApi<TableStore<any, any, any>> & {
      _state: typeof state
    }
  }

  it("clears realtime on sign-out", async () => {
    const supabase = createMockSupabase()
    const authStore = createAuthStore({ supabase })
    const tableStore = createMockTableStore()
    const realtimeManager = { destroy: vi.fn() }

    setupAuthGate(supabase, authStore, [tableStore], {
      realtimeManager: realtimeManager as any,
    })

    await supabase.auth.signInWithPassword({ email: "a@b.com", password: "x" })
    await supabase.auth.signOut()

    expect(realtimeManager.destroy).toHaveBeenCalledTimes(1)
  })

  it("KEEPS the offline queue on sign-out", async () => {
    // It used to clear it. supabase-js emits SIGNED_OUT by itself when a
    // refresh token finally fails to renew — the way a long offline session
    // ends — so with `queueWrites` on, clearing here would discard every unsent
    // write with no error and no rollback. Multi-user isolation does not need
    // it: `enqueue` tags each mutation with `userId`, and `flush` runs a tagged
    // mutation only for the user that made it — never for the signed-out
    // session this very event creates.
    const supabase = createMockSupabase()
    const authStore = createAuthStore({ supabase })
    const tableStore = createMockTableStore()
    const offlineQueue = { clearQueue: vi.fn(async () => await Promise.resolve()) }

    setupAuthGate(supabase, authStore, [tableStore], {
      offlineQueue: offlineQueue as any,
    })

    await supabase.auth.signInWithPassword({ email: "a@b.com", password: "x" })
    await supabase.auth.signOut()

    expect(offlineQueue.clearQueue).not.toHaveBeenCalled()

    // The stores are still cleared, which is what sign-out is for.
    expect(tableStore._state.clearAll).toHaveBeenCalledTimes(1)
  })

  it("gives a dirty queue its chance when the user signs in", async () => {
    // `startAutoFlush` only reacts to a connectivity transition. Now that a
    // tagged mutation waits for its own user rather than running under none,
    // signing in is the moment that wait ends — and without this the writes sit
    // there until the network happens to change state, which on a device that
    // never left wifi is never.
    const supabase = createMockSupabase()
    const authStore = createAuthStore({ supabase })
    const tableStore = createMockTableStore()
    const offlineQueue = { isDirty: true, scheduleFlush: vi.fn() }

    setupAuthGate(supabase, authStore, [tableStore], {
      offlineQueue: offlineQueue as any,
    })

    await supabase.auth.signInWithPassword({ email: "a@b.com", password: "x" })

    expect(offlineQueue.scheduleFlush).toHaveBeenCalledTimes(1)
  })

  it("does not schedule a flush for an empty queue, or on sign-out", async () => {
    const supabase = createMockSupabase()
    const authStore = createAuthStore({ supabase })
    const tableStore = createMockTableStore()
    const offlineQueue = { isDirty: false, scheduleFlush: vi.fn() }

    setupAuthGate(supabase, authStore, [tableStore], {
      offlineQueue: offlineQueue as any,
    })

    await supabase.auth.signInWithPassword({ email: "a@b.com", password: "x" })
    expect(offlineQueue.scheduleFlush).not.toHaveBeenCalled()

    // And a sign-out never schedules one, dirty or not: there is no user for a
    // tagged mutation to belong to.
    ;(offlineQueue as { isDirty: boolean }).isDirty = true
    await supabase.auth.signOut()
    expect(offlineQueue.scheduleFlush).not.toHaveBeenCalled()
  })

  it("does not clear realtime/queue when clearOnSignOut is false", async () => {
    const supabase = createMockSupabase()
    const authStore = createAuthStore({ supabase })
    const tableStore = createMockTableStore()
    const realtimeManager = { destroy: vi.fn() }
    const offlineQueue = { clearQueue: vi.fn(async () => await Promise.resolve()) }

    setupAuthGate(supabase, authStore, [tableStore], {
      clearOnSignOut: false,
      offlineQueue: offlineQueue as any,
      realtimeManager: realtimeManager as any,
    })

    await supabase.auth.signInWithPassword({ email: "a@b.com", password: "x" })
    await supabase.auth.signOut()

    expect(realtimeManager.destroy).not.toHaveBeenCalled()
    expect(offlineQueue.clearQueue).not.toHaveBeenCalled()
  })

  it("signs out cleanly with no queue wired at all", async () => {
    const supabase = createMockSupabase()
    const authStore = createAuthStore({ supabase })
    const tableStore = createMockTableStore()

    setupAuthGate(supabase, authStore, [tableStore], {})

    await supabase.auth.signInWithPassword({ email: "a@b.com", password: "x" })
    await expect(supabase.auth.signOut()).resolves.toBeDefined()
    expect(tableStore._state.clearAll).toHaveBeenCalledTimes(1)
  })
})
