import type { SupabaseClient, Session } from "@supabase/supabase-js"
import { createStore, type StoreApi } from "zustand/vanilla"
import type { AuthStore } from "../types.js"
import { fromSupabaseError } from "../errors.js"

type CreateAuthStoreOptions = {
  supabase: SupabaseClient
  devtools?: boolean
}

/**
 * Decode JWT claims from a Supabase session's access token.
 * Only reads the payload (no crypto verification — Supabase handles that).
 */
function parseJwtClaims(session: Session | null): Record<string, unknown> {
  if (!session?.access_token) return {}
  try {
    const parts = session.access_token.split(".")
    if (parts.length !== 3) return {}
    // base64url → base64 → decode
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/")
    const decoded = atob(b64)
    return JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Creates a Zustand store for Supabase auth state.
 */
export function createAuthStore(
  options: CreateAuthStoreOptions,
): StoreApi<AuthStore> {
  const { supabase } = options

  return createStore<AuthStore>()((set, get) => ({
    // State
    session: null,
    user: null,
    isLoading: true,
    error: null,
    claims: {},

    // Actions
    async initialize() {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession()

        set({
          session,
          user: session?.user ?? null,
          isLoading: false,
          error: error ? fromSupabaseError(error) : null,
          claims: parseJwtClaims(session),
        })
      } catch (err) {
        set({
          isLoading: false,
          error:
            err instanceof Error ? err : new Error(String(err)),
        })
      }
    },

    async signIn({ email, password }) {
      set({ isLoading: true, error: null })
      const { data, error } =
        await supabase.auth.signInWithPassword({ email, password })

      if (error) {
        set({ isLoading: false, error: fromSupabaseError(error) })
        throw fromSupabaseError(error)
      }

      set({
        session: data.session,
        user: data.user,
        isLoading: false,
        error: null,
        claims: parseJwtClaims(data.session),
      })
    },

    async signUp({ email, password }) {
      set({ isLoading: true, error: null })
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      })

      if (error) {
        set({ isLoading: false, error: fromSupabaseError(error) })
        throw fromSupabaseError(error)
      }

      set({
        session: data.session,
        user: data.user,
        isLoading: false,
        error: null,
        claims: parseJwtClaims(data.session),
      })
    },

    async signOut() {
      set({ isLoading: true })
      const { error } = await supabase.auth.signOut()

      if (error) {
        set({ isLoading: false, error: fromSupabaseError(error) })
        throw fromSupabaseError(error)
      }

      set({
        session: null,
        user: null,
        isLoading: false,
        error: null,
        claims: {},
      })
    },

    async signInWithOAuth({ provider, redirectTo }) {
      set({ isLoading: true, error: null })
      const { error } = await supabase.auth.signInWithOAuth({
        provider: provider as any,
        options: { redirectTo },
      })

      if (error) {
        set({ error: fromSupabaseError(error), isLoading: false })
        throw fromSupabaseError(error)
      }

      // OAuth redirects away; reset loading for SPA/webview contexts
      set({ isLoading: false })
    },

    async refreshSession() {
      try {
        const { data, error } = await supabase.auth.refreshSession()

        if (error) {
          set({ error: fromSupabaseError(error) })
          return
        }

        set({
          session: data.session,
          user: data.user,
          error: null,
          claims: parseJwtClaims(data.session),
        })
      } catch (err) {
        set({
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
    },

    onAuthStateChange() {
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        set({
          session,
          user: session?.user ?? null,
          isLoading: false,
          claims: parseJwtClaims(session),
        })
      })

      return () => subscription.unsubscribe()
    },

    getClaim(key: string) {
      return get().claims[key]
    },
  }))
}
