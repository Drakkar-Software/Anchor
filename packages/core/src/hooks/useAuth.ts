"use client"

import { useEffect, useMemo } from "react"
import { useStore } from "zustand"
import type { StoreApi } from "zustand"
import type { AuthStore } from "../types.js"

/**
 * Hook for auth state and actions.
 * Automatically sets up onAuthStateChange listener.
 * Uses individual selectors to avoid unnecessary re-renders.
 */
export function useAuth(authStore: StoreApi<AuthStore>) {
  // Actions are stable references — get them once from store
  const actions = useMemo(() => {
    const s = authStore.getState()
    return {
      signIn: s.signIn,
      signUp: s.signUp,
      signOut: s.signOut,
      signInWithOAuth: s.signInWithOAuth,
      refreshSession: s.refreshSession,
    }
  }, [authStore])

  // Only subscribe to changing state fields
  const session = useStore(authStore, (s) => s.session)
  const user = useStore(authStore, (s) => s.user)
  const isLoading = useStore(authStore, (s) => s.isLoading)
  const error = useStore(authStore, (s) => s.error)

  useEffect(() => {
    // Listener first, then the snapshot. Both report the same fact — supabase-js
    // answers a new subscriber with `INITIAL_SESSION` carrying exactly what
    // `getSession()` would have returned — and both write `isLoading: false`,
    // so the order they settle in used to decide the result. Subscribing first
    // means the store knows a listener exists before the round-trip can resolve,
    // and `initialize()` defers to it rather than overwriting a transition that
    // arrived meanwhile.
    const unsubscribe = authStore.getState().onAuthStateChange()
    // Error is captured in authStore.error state; prevent unhandled rejection
    authStore.getState().initialize().catch(() => {})
    return unsubscribe
  }, [authStore])

  return {
    session,
    user,
    isLoading,
    error,
    ...actions,
  }
}
