import { beforeEach,describe, expect, it } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { createAuthStore } from "./authStore.js"

describe("createAuthStore", () => {
  let supabase: any

  beforeEach(() => {
    supabase = createMockSupabase()
  })

  it("creates store with loading initial state", () => {
    const store = createAuthStore({ supabase })
    const state = store.getState()

    expect(state.session).toBeNull()
    expect(state.user).toBeNull()
    expect(state.isLoading).toBe(true)
    expect(state.error).toBeNull()
  })

  describe("initialize", () => {
    it("initializes with no session", async () => {
      const store = createAuthStore({ supabase })

      await store.getState().initialize()

      expect(store.getState().isLoading).toBe(false)
      expect(store.getState().session).toBeNull()
      expect(store.getState().user).toBeNull()
    })

    it("initializes with existing session", async () => {
      const session = { access_token: "token", user: { email: "a@b.com", id: "u1" } }

      supabase._setSession(session)

      const store = createAuthStore({ supabase })

      await store.getState().initialize()

      expect(store.getState().session).toEqual(session)
      expect(store.getState().user).toEqual(session.user)
      expect(store.getState().isLoading).toBe(false)
    })
  })

  describe("signIn", () => {
    it("signs in with email and password", async () => {
      const store = createAuthStore({ supabase })

      await store.getState().signIn({ email: "test@test.com", password: "pass" })

      expect(store.getState().user).toBeDefined()
      expect((store.getState().user as any).email).toBe("test@test.com")
      expect(store.getState().session).toBeDefined()
      expect(store.getState().isLoading).toBe(false)
    })
  })

  describe("signUp", () => {
    it("signs up with email and password", async () => {
      const store = createAuthStore({ supabase })

      await store.getState().signUp({ email: "new@test.com", password: "pass" })

      expect(store.getState().user).toBeDefined()
      expect((store.getState().user as any).email).toBe("new@test.com")
    })
  })

  describe("signOut", () => {
    it("clears session on sign out", async () => {
      const store = createAuthStore({ supabase })

      await store.getState().signIn({ email: "test@test.com", password: "pass" })

      expect(store.getState().session).not.toBeNull()

      await store.getState().signOut()

      expect(store.getState().session).toBeNull()
      expect(store.getState().user).toBeNull()
      expect(store.getState().isLoading).toBe(false)
    })
  })

  describe("claims", () => {
    it("starts with empty claims", () => {
      const store = createAuthStore({ supabase })

      expect(store.getState().claims).toEqual({})
    })

    it("parses JWT claims on sign-in", async () => {
      // Create a mock JWT with custom claims
      const payload = { org_id: "org-123", role: "admin", sub: "user-1" }
      const fakeJwt = `header.${btoa(JSON.stringify(payload))}.signature`

      supabase._setSession({ access_token: fakeJwt, user: { email: "a@b.com", id: "user-1" } })

      const store = createAuthStore({ supabase })

      await store.getState().initialize()

      expect(store.getState().claims.role).toBe("admin")
      expect(store.getState().claims.org_id).toBe("org-123")
    })

    it("getClaim returns specific claim value", async () => {
      const payload = { role: "editor", sub: "user-1" }
      const fakeJwt = `header.${btoa(JSON.stringify(payload))}.signature`

      supabase._setSession({ access_token: fakeJwt, user: { email: "a@b.com", id: "user-1" } })

      const store = createAuthStore({ supabase })

      await store.getState().initialize()

      expect(store.getState().getClaim("role")).toBe("editor")
      expect(store.getState().getClaim("nonexistent")).toBeUndefined()
    })

    it("clears claims on sign-out", async () => {
      const store = createAuthStore({ supabase })

      await store.getState().signIn({ email: "a@b.com", password: "x" })
      await store.getState().signOut()

      expect(store.getState().claims).toEqual({})
    })
  })

  describe("onAuthStateChange", () => {
    it("subscribes to auth changes and returns unsubscribe", () => {
      const store = createAuthStore({ supabase })
      const unsubscribe = store.getState().onAuthStateChange()

      expect(typeof unsubscribe).toBe("function")

      // Should not throw
      unsubscribe()
    })

    it("updates store when auth state changes", async () => {
      const store = createAuthStore({ supabase })

      store.getState().onAuthStateChange()

      // Sign in triggers auth state change
      await store.getState().signIn({ email: "test@test.com", password: "pass" })

      expect(store.getState().user).toBeDefined()
    })
  })
})

describe("getVerifiedClaims", () => {
  // `getClaim` reads an unverified local base64 decode. `getClaims()` — which
  // verifies against the project's JWKS — ships in the pinned SDK and was never
  // called.

  it("returns the verified claims", async () => {
    const supabase = createMockSupabase()

    supabase.auth.getClaims = vi.fn().mockResolvedValue({
      data: { claims: { role: "authenticated", sub: "user-1" }, headers: {}, signature: new Uint8Array() },
      error: null,
    })

    const store = createAuthStore({ supabase })

    const { claims, error } = await store.getState().getVerifiedClaims()

    expect(error).toBeNull()
    expect(claims).toEqual({ role: "authenticated", sub: "user-1" })
  })

  it("reports a rejected token as an error rather than as empty claims", async () => {
    const supabase = createMockSupabase()

    supabase.auth.getClaims = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "bad_jwt", message: "invalid signature" },
    })

    const store = createAuthStore({ supabase })

    const { claims, error } = await store.getState().getVerifiedClaims()

    expect(claims).toBeNull()
    expect((error as { code?: string }).code).toBe("bad_jwt")
  })

  it("returns null claims, not an error, when there is no session", async () => {
    const supabase = createMockSupabase()

    supabase.auth.getClaims = vi.fn().mockResolvedValue({ data: null, error: null })

    const store = createAuthStore({ supabase })

    const { claims, error } = await store.getState().getVerifiedClaims()

    expect(claims).toBeNull()
    expect(error).toBeNull()
  })

})
