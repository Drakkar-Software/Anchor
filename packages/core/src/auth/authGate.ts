import type { SupabaseClient } from "@supabase/supabase-js"
import type { StoreApi } from "zustand"

import { PG_INSUFFICIENT_PRIVILEGE } from "../errors.js"
import type { OfflineQueue } from "../mutation/offlineQueue.js"
import type { RealtimeManager } from "../realtime/realtimeManager.js"
import type { AuthStore,TableStore } from "../types.js"

export type AuthGateOptions = {
  /** Clear all table stores on sign-out */
  clearOnSignOut?: boolean

  /** OfflineQueue to clear on sign-out */
  offlineQueue?: OfflineQueue

  /** Custom callback when auth state changes */
  onAuthChange?: (event: string, session: unknown) => void

  /** RealtimeManager to unsubscribe on sign-out */
  realtimeManager?: RealtimeManager

  /** Refetch all table stores on sign-in */
  refetchOnSignIn?: boolean
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
  if (!error) {return false}

  if ((error as { code?: unknown }).code === PG_INSUFFICIENT_PRIVILEGE) {return true}

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
    offlineQueue,
    onAuthChange,
    realtimeManager,
    refetchOnSignIn = true,
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
        // skipping every tag that is not the current user's already prevent,
        // without discarding anything. Once `offlineQueue.queueWrites` gave the
        // queue real producers, clearing it became the destructive half:
        // supabase-js emits SIGNED_OUT on its own when a refresh token finally
        // fails to renew, which is how a long offline session ends, so every
        // unsent write would be dropped from memory and from disk without ever
        // running — no error, no `onRollback`, and the pre-edit server state
        // waiting at the next sign-in as though the work had never happened.
        // `clearQueue()` remains public for a caller who does want that.
        //
        // What makes leaving it here safe is the flush filter refusing to run a
        // tagged mutation while there is no current user. That was NOT true
        // when this comment was first written: `!this.currentUserId` was an
        // eligibility arm, so a signed-out queue replayed everything as `anon`
        // and RLS refused it into a rollback. Both halves are load-bearing —
        // see `OfflineQueue.setUserId`.
        void offlineQueue
      }

      // A queue holding this user's writes has to be told its user is back.
      // `startAutoFlush` only reacts to a connectivity *transition*, so a queue
      // that hydrated at boot, or that was skipped while signed out, would
      // otherwise sit untouched until the network happened to change state.
      // INITIAL_SESSION as much as SIGNED_IN: a relaunch with a stored session
      // emits only the former, and that is the ordinary way a write queued in
      // the previous run gets its chance.
      if (
        (event === "SIGNED_IN" || event === "INITIAL_SESSION") &&
        session &&
        offlineQueue?.isDirty
      ) {
        offlineQueue.scheduleFlush()
      }

      if (event === "SIGNED_IN" && refetchOnSignIn) {
        for (const store of tableStores) {
          store.getState().fetch().catch((error: unknown) => {
            store.setState({ error: error instanceof Error ? error : new Error(String(error)) } as any)
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

  return () => { subscription.unsubscribe(); }
}
