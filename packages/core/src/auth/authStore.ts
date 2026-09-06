import type { Session,SupabaseClient } from "@supabase/supabase-js"
import { createStore, type StoreApi } from "zustand/vanilla"

import { fromSupabaseError } from "../errors.js"
import type { AuthStore } from "../types.js"

type CreateAuthStoreOptions = {
  devtools?: boolean
  supabase: SupabaseClient
}

/**
 * Creates a Zustand store for Supabase auth state.
 */
export function createAuthStore(
  options: CreateAuthStoreOptions,
): StoreApi<AuthStore> {
  const { supabase } = options

  /**
   * Whether `onAuthStateChange` has delivered anything yet.
   *
   * `useAuth` calls `initialize()` — a `getSession()` round-trip — and registers
   * a listener, and supabase-js answers the listener with `INITIAL_SESSION`
   * carrying the same session. Two reads of one fact, and two writes of
   * `isLoading: false` racing each other. The order is not fixed: whichever
   * settles last wins, so a `SIGNED_OUT` arriving while the `getSession()`
   * promise was in flight could be overwritten by the stale session it had
   * already resolved with.
   *
   * A listener is always the fresher source — it reports transitions, not a
   * snapshot — so once one has spoken, `initialize()` stops writing session
   * state and only clears the loading flag.
   */
  let sawAuthEvent = false

  return createStore<AuthStore>()((set, get) => ({
    claims: {},
    error: null,

    getClaim(key: string) {
      return get().claims[key]
    },

    async getVerifiedClaims() {
      // `getClaims()` verifies the signature against the project's JWKS —
      // asymmetric keys are checked locally, a legacy HS256 secret by asking
      // the auth server. It has shipped in the pinned SDK all along and was
      // never called; `getClaim` read an unverified local decode instead.
      const auth = supabase.auth as unknown as {
        getClaims: (jwt?: string) => Promise<{ data: unknown; error: unknown }>
      }
      const { data, error } = await auth.getClaims()

      if (error) {return { claims: null, error: fromSupabaseError(error) }}

      // supabase-js returns `{claims, headers, signature}`; a session-less
      // client returns null rather than erroring.
      const claims = (data as { claims?: Record<string, unknown> } | null)?.claims ?? null

      return { claims, error: null }
    },


    // Actions
    async initialize() {
      try {
        const { data, error } = await supabase.auth.getSession()

        // A listener answered while this round-trip was in flight; its answer is
        // the newer one. Clearing the flag is still this call's job — nothing
        // else does it when `getSession()` resolves last.
        if (sawAuthEvent) {
          set({ error: error ? fromSupabaseError(error) : null, isLoading: false })

          return
        }

        const session = data.session ?? null

        set({
          claims: parseJwtClaims(session),
          error: error ? fromSupabaseError(error) : null,
          isLoading: false,
          session,
          user: session?.user ?? null,
        })
      } catch (error) {
        set({
          error:
            error instanceof Error ? error : new Error(String(error)),

          isLoading: false,
        })
      }
    },

    isLoading: true,

    onAuthStateChange() {
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        sawAuthEvent = true
        set({
          claims: parseJwtClaims(session),
          isLoading: false,
          session,
          user: session?.user ?? null,
        })
      })

      return () => { subscription.unsubscribe(); }
    },

    async refreshSession() {
      try {
        const { data, error } = await supabase.auth.refreshSession()

        if (error) {
          set({ error: fromSupabaseError(error) })

          return
        }

        set({
          claims: parseJwtClaims(data.session),
          error: null,
          session: data.session,
          user: data.user,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    },

    // State
    session: null,

    async signIn({ email, password }) {
      set({ error: null, isLoading: true })

      const { data, error } =
        await supabase.auth.signInWithPassword({ email, password })

      if (error) {
        set({ error: fromSupabaseError(error), isLoading: false })

        throw fromSupabaseError(error)
      }

      set({
        claims: parseJwtClaims(data.session),
        error: null,
        isLoading: false,
        session: data.session,
        user: data.user,
      })
    },

    async signInWithOAuth({ provider, redirectTo }) {
      set({ error: null, isLoading: true })

      const { error } = await supabase.auth.signInWithOAuth({
        options: { redirectTo },
        provider: provider as any,
      })

      if (error) {
        set({ error: fromSupabaseError(error), isLoading: false })

        throw fromSupabaseError(error)
      }

      // OAuth redirects away; reset loading for SPA/webview contexts
      set({ isLoading: false })
    },

    async signOut() {
      set({ isLoading: true })

      const { error } = await supabase.auth.signOut()

      if (error) {
        set({ error: fromSupabaseError(error), isLoading: false })

        throw fromSupabaseError(error)
      }

      set({
        claims: {},
        error: null,
        isLoading: false,
        session: null,
        user: null,
      })
    },

    async signUp({ email, password }) {
      set({ error: null, isLoading: true })

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      })

      if (error) {
        set({ error: fromSupabaseError(error), isLoading: false })

        throw fromSupabaseError(error)
      }

      set({
        claims: parseJwtClaims(data.session),
        error: null,
        isLoading: false,
        session: data.session,
        user: data.user,
      })
    },

    user: null,
  }))
}

/**
 * Decode the payload of a session's access token. **Nothing is verified.**
 *
 * The previous docstring said "no crypto verification — Supabase handles that",
 * which is true of the token's use on the *server* and irrelevant here: this
 * reads a string the client already holds, and a client that has been handed a
 * forged token will parse the forged claims out of it just as happily.
 *
 * That is fine for what it is for — deciding which tab to show, rendering a
 * plan name — because no client-side check is a security boundary in the first
 * place; RLS is. It is not fine as the only claims API, which is why
 * `getVerifiedClaims()` exists alongside it.
 */
function parseJwtClaims(session: Session | null): Record<string, unknown> {
  if (!session?.access_token) {return {}}

  try {
    const parts = session.access_token.split(".")

    if (parts.length !== 3) {return {}}

    // base64url → base64 → decode
    const b64 = parts[1]!.replaceAll("-", "+").replaceAll("_", "/")
    const decoded = atob(b64)

    return JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return {}
  }
}
