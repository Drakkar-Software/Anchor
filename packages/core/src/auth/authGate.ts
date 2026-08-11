import type { StoreApi } from "zustand"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { TableStore, AuthStore } from "../types.js"
import type { RealtimeManager } from "../realtime/realtimeManager.js"
import type { OfflineQueue } from "../mutation/offlineQueue.js"

export type AuthGateOptions = {
  /** Clear all table stores on sign-out */
  clearOnSignOut?: boolean
  /** Refetch all table stores on sign-in */
  refetchOnSignIn?: boolean
  /** Custom callback when auth state changes */
  onAuthChange?: (event: string, session: unknown) => void
  /** RealtimeManager to unsubscribe on sign-out */
  realtimeManager?: RealtimeManager
  /** OfflineQueue to clear on sign-out */
  offlineQueue?: OfflineQueue
}

/**
 * Detect if a Supabase error is an RLS policy violation.
 */
export function isRlsError(error: Error | null): boolean {
  if (!error) return false
  const msg = error.message.toLowerCase()
  return (
    msg.includes("row-level security") ||
    msg.includes("rls") ||
    msg.includes("new row violates row-level security policy") ||
    msg.includes("permission denied") ||
    msg.includes("42501") // PostgreSQL insufficient_privilege
  )
}

/**
 * Wire auth state changes to table store lifecycle.
 * Clears stores on sign-out, refetches on sign-in.
 */
export function setupAuthGate(
  supabase: SupabaseClient,
  _authStore: StoreApi<AuthStore>,
  tableStores: StoreApi<TableStore<any, any, any>>[],
  options: AuthGateOptions = {},
): () => void {
  const {
    clearOnSignOut = true,
    refetchOnSignIn = true,
    onAuthChange,
    realtimeManager,
    offlineQueue,
  } = options

  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    (event, session) => {
      onAuthChange?.(event, session)

      if (event === "SIGNED_OUT" && clearOnSignOut) {
        for (const store of tableStores) {
          store.getState().clearAll()
        }
        // Unsubscribe all realtime channels to prevent data leaks after sign-out
        realtimeManager?.destroy()
        // Clear offline queue to prevent orphaned mutations executing under wrong user
        offlineQueue?.clearQueue().catch(() => {
          // Best-effort: persistence may already be cleared
        })
      }

      if (event === "SIGNED_IN" && refetchOnSignIn) {
        for (const store of tableStores) {
          store.getState().fetch().catch((err: unknown) => {
            store.setState({ error: err instanceof Error ? err : new Error(String(err)) } as any)
          })
        }
      }

      if (event === "TOKEN_REFRESHED") {
        // REST/Storage/Functions requests auto-use the new token, but private
        // (RLS-checked) realtime channels need an explicit re-auth or they
        // keep running under the stale token until reconnect.
        supabase.realtime.setAuth(session?.access_token ?? null).catch(() => {
          // Best-effort: a dropped connection will re-auth on reconnect anyway
        })
      }
    },
  )

  return () => subscription.unsubscribe()
}
