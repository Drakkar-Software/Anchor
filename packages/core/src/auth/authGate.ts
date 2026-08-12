import type { StoreApi } from "zustand"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { TableStore, AuthStore } from "../types.js"
import type { RealtimeManager } from "../realtime/realtimeManager.js"
import type { OfflineQueue } from "../mutation/offlineQueue.js"
import { PG_INSUFFICIENT_PRIVILEGE } from "../errors.js"

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
 *
 * Reads `code` first: an `AnchorError` from any boundary in this package now
 * carries Postgres' own `42501`, which is the fact this function wants. The
 * message arms below are the fallback, and they are still needed — a consumer
 * can hand us an error caught straight from supabase-js, or from a wrapper of
 * its own, and neither is an `AnchorError`. They were the ONLY mechanism before
 * structured codes existed, which meant this reduced to substring-matching the
 * literal text "42501" inside prose written for a log file.
 */
export function isRlsError(error: Error | null): boolean {
  if (!error) return false
  if ((error as { code?: unknown }).code === PG_INSUFFICIENT_PRIVILEGE) return true
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
        // The queue is deliberately NOT cleared here. It used to be, on the
        // grounds of "orphaned mutations executing under the wrong user" —
        // which `enqueue` tagging every mutation with `userId` and `flush`
        // filtering on the current one already prevent, without discarding
        // anything. Once `offlineQueue.queueWrites` gave the queue real
        // producers, clearing it became the destructive half: supabase-js emits
        // SIGNED_OUT on its own when a refresh token finally fails to renew,
        // which is how a long offline session ends, so every unsent write would
        // be dropped from memory and from disk without ever running — no error,
        // no `onRollback`, and the pre-edit server state waiting at the next
        // sign-in as though the work had never happened. `clearQueue()` remains
        // public for a caller who does want that.
        void offlineQueue
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
