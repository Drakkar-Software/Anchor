"use client"

import { useEffect, useRef, useState } from "react"
import type { StoreApi } from "zustand"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { AuthStore } from "../types.js"
import {
  createSessionFromUrl,
  type AuthCallbackResult,
} from "../auth/authCallbacks.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export type UseAuthCallbackOptions = {
  /**
   * Returns the URL to inspect for Supabase auth tokens.
   *
   * Platform-specific — provide the appropriate value:
   * - **Web:** `() => window.location.href` (always available synchronously)
   * - **Native (Expo):** `() => url` where `url` is the result of `useURL()`
   *   from `expo-linking` (may be `null` until the deep link arrives)
   *
   * Return `null` or `undefined` to defer processing until a URL is available.
   */
  getUrl: () => string | null | undefined

  /**
   * Called once when a session is successfully established from the URL.
   * Use this callback to navigate the user to the appropriate screen.
   *
   * @example
   * onSuccess: ({ type }) => {
   *   if (type === 'recovery') router.replace('/reset-password')
   *   else router.replace('/home')
   * }
   */
  onSuccess?: (result: AuthCallbackResult) => void

  /**
   * Called when the URL contains an auth error, or when session
   * establishment fails.
   */
  onError?: (error: Error) => void
}

export type UseAuthCallbackResult = {
  /** `true` while the URL is being parsed and the session is being established */
  isProcessing: boolean
  /** Set when an error occurs during callback processing; `null` otherwise */
  error: Error | null
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Processes a Supabase auth callback URL (magic-link, password recovery,
 * or email confirmation) and establishes an authenticated session.
 *
 * - Calls `createSessionFromUrl` when the URL contains auth tokens
 * - Updates the anchor auth store via `setState`
 * - Fires `onSuccess` or `onError` once, then stops (one-shot processing)
 *
 * Works on both web (`window.location.href`) and native (Expo deep links).
 * Platform-specific URL retrieval is the caller's responsibility via `getUrl`.
 *
 * @example
 * // Web
 * const { isProcessing } = useAuthCallback(supabase, authStore, {
 *   getUrl: () => window.location.href,
 *   onSuccess: ({ type }) => {
 *     router.replace(type === 'recovery' ? '/settings/security' : '/home')
 *   },
 *   onError: () => router.replace('/login'),
 * })
 *
 * @example
 * // Native (Expo)
 * const url = useURL() // expo-linking
 * const { isProcessing } = useAuthCallback(supabase, authStore, {
 *   getUrl: () => url,
 *   onSuccess: ({ type }) => {
 *     router.replace(type === 'recovery' ? '/settings/security' : '/home')
 *   },
 * })
 */
export function useAuthCallback(
  supabase: SupabaseClient,
  authStore: StoreApi<AuthStore>,
  options: UseAuthCallbackOptions,
): UseAuthCallbackResult {
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const processed = useRef(false)

  // Call getUrl() in the render cycle so changes (native deep-link arriving)
  // trigger a re-render and re-run the effect.
  const url = options.getUrl()

  useEffect(() => {
    if (processed.current || !url) return

    processed.current = true
    setIsProcessing(true)
    setError(null)

    createSessionFromUrl(supabase, url)
      .then((result) => {
        setIsProcessing(false)

        if (!result) return // URL had no auth params — nothing to do

        // Update anchor auth store immediately (onAuthStateChange reconciles claims async)
        authStore.setState({
          session: result.session,
          user: result.session.user,
          isLoading: false,
          error: null,
          claims: {},
        })

        options.onSuccess?.(result)
      })
      .catch((err: unknown) => {
        const wrapped = err instanceof Error ? err : new Error(String(err))
        setError(wrapped)
        setIsProcessing(false)
        options.onError?.(wrapped)
      })
    // url and supabase/authStore are the only reactive deps;
    // options callbacks are intentionally excluded to avoid churn on inline functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, supabase, authStore])

  return { isProcessing, error }
}
