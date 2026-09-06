import type { Session,SupabaseClient } from "@supabase/supabase-js"

import { fromSupabaseError } from "../errors.js"

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of a successful auth callback */
export type AuthCallbackResult = {
  session: Session

  /** auth flow type from the callback URL */
  type: AuthCallbackType
}

/**
 * Maps auth-callback types to post-login destination routes.
 * Used with the `routes` option of `useAuthCallback`.
 *
 * @example
 * const routes: AuthCallbackRoutes = {
 *   recovery: '/settings/security',
 *   signup:   '/onboarding',
 *   default:  '/home',
 * }
 */
export type AuthCallbackRoutes = {
  [type: string]: string | undefined

  /** Fallback for any type without an explicit entry. */
  default?: string
  email?: string
  email_change?: string
  invite?: string
  magiclink?: string
  recovery?: string
  signup?: string
}

/** The `type` field from a Supabase auth callback URL */
export type AuthCallbackType =
  | "recovery"
  | "signup"
  | "magiclink"
  | "email"
  | "email_change"
  | "invite"
  | string

/** Parsed parameters from a Supabase auth callback URL */
export type ParsedAuthCallback = {
  /** access_token from the hash fragment (implicit flow) */
  accessToken: string | null

  /** authorization code from query params (PKCE flow) */
  code: string | null

  /** OAuth/Supabase error code */
  error: string | null

  /** Human-readable error description */
  errorDescription: string | null

  /**
   * `sb_flow_id` from query params — present only when the client that
   * started the flow set `appendPkceFlowIdToRedirects: true`. Identifies
   * which concurrent PKCE flow (e.g. two OAuth providers started in
   * different tabs) this callback belongs to; forwarded to
   * `exchangeCodeForSession` so the right verifier is used.
   */
  flowId: string | null

  /** refresh_token from the hash fragment (implicit flow) */
  refreshToken: string | null

  /** auth flow type (recovery, signup, magiclink, email, email_change, invite) */
  type: AuthCallbackType | null
}

/** Every OTP flow Supabase can verify, by which identifier it arrives on. */
export type VerifyOtpParams =
  | {
      email: string
      options?: { captchaToken?: string; redirectTo?: string; }
      token: string
      type: "signup" | "invite" | "magiclink" | "recovery" | "email_change" | "email"
    }
  | {
      options?: { captchaToken?: string }
      phone: string
      token: string
      type: "sms" | "phone_change"
    }
  | {
      options?: { captchaToken?: string; redirectTo?: string; }

      /** From a `?token_hash=` callback link, where no address is echoed back. */
      token_hash: string
      type: "signup" | "invite" | "magiclink" | "recovery" | "email_change" | "email"
    }

// ─── URL Parsing ──────────────────────────────────────────────────────────────

/**
 * Establish a Supabase session from an auth callback URL.
 *
 * Handles implicit flow (access_token + refresh_token in hash fragment) and
 * PKCE flow (authorization code in query params).
 *
 * Returns `null` if the URL contains no auth parameters.
 * Throws if the URL contains an error or if session establishment fails.
 *
 * @example
 * // Web: always available synchronously
 * const result = await createSessionFromUrl(supabase, window.location.href)
 *
 * // Native: deep-link URL from the OS
 * const result = await createSessionFromUrl(supabase, deepLinkUrl)
 *
 * if (result) {
 *   console.log(result.type) // "recovery" | "signup" | "magiclink" | …
 * }
 */
export async function createSessionFromUrl(
  supabase: SupabaseClient,
  url: string,
): Promise<AuthCallbackResult | null> {
  const parsed = parseAuthCallbackUrl(url)

  if (parsed.error) {
    throw new Error(parsed.errorDescription ?? parsed.error)
  }

  const type: AuthCallbackType = parsed.type ?? "email"

  // Implicit flow: tokens directly in the URL hash fragment
  if (parsed.accessToken && parsed.refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: parsed.accessToken,
      refresh_token: parsed.refreshToken,
    })

    if (error) {throw fromSupabaseError(error)}

    if (!data.session) {throw new Error("Session could not be established")}

    return { session: data.session, type }
  }

  // PKCE flow: exchange authorization code for session.
  // parsed.flowId (from `sb_flow_id`) is only present when the client that
  // started the flow set `appendPkceFlowIdToRedirects: true` — pass it
  // through so overlapping flows (e.g. two OAuth providers started in
  // different tabs) don't fight over the same verifier slot. On web,
  // supabase-js also reads `sb_flow_id` off `window.location.href` itself
  // when no explicit `flowId` is given; passing it here matters most where
  // `window.location` doesn't exist, i.e. React Native deep links.
  if (parsed.code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(
      parsed.code,
      parsed.flowId ? { flowId: parsed.flowId } : undefined,
    )

    if (error) {throw fromSupabaseError(error)}

    if (!data.session) {throw new Error("Session could not be established")}

    return { session: data.session, type }
  }

  return null
}

/**
 * Build a Supabase auth redirect URL for web environments.
 * Uses `window.location.origin` — only call in browser contexts.
 *
 * The returned URL must be allow-listed in your Supabase project
 * (Authentication → URL Configuration → Redirect URLs).
 *
 * @param path - Route path for the auth callback (default: "auth-callback")
 *
 * @example
 * const redirectTo = getWebAuthRedirectTo() // "https://example.com/auth-callback"
 */
export function getWebAuthRedirectTo(path = "auth-callback"): string {
  if (typeof globalThis === "undefined") {
    throw new TypeError(
      "getWebAuthRedirectTo() is only available in browser environments. " +
        "For native (React Native / Expo), use your app scheme: " +
        '`Linking.createURL("auth-callback")` from expo-linking.',
    )
  }

  const cleanPath = path.replace(/^\//v, "")

  return `${globalThis.location.origin}/${cleanPath}`
}

// ─── Session from URL ─────────────────────────────────────────────────────────

/**
 * Detect whether a URL contains Supabase auth callback parameters
 * (access_token, code, or error) that require processing.
 */
export function hasAuthCallbackParams(url: string): boolean {
  const parsed = parseAuthCallbackUrl(url)

  return Boolean(parsed.accessToken ?? parsed.code ?? parsed.error)
}

// ─── Redirect URL Helpers ─────────────────────────────────────────────────────

/**
 * Parse auth parameters from a Supabase auth callback URL.
 *
 * Handles both:
 * - Implicit flow: tokens in the URL hash fragment (`#access_token=…&refresh_token=…`)
 * - PKCE flow: authorization code in query params (`?code=…`)
 *
 * @example
 * const { accessToken, type } = parseAuthCallbackUrl(window.location.href)
 */
export function parseAuthCallbackUrl(url: string): ParsedAuthCallback {
  const hashIndex = url.indexOf("#")
  const hashString = hashIndex === -1 ? "" : url.slice(hashIndex + 1)
  const hashParams = new URLSearchParams(hashString)

  const queryString = url.split("?")[1]?.split("#")[0] ?? ""
  const queryParams = new URLSearchParams(queryString)

  return {
    accessToken: hashParams.get("access_token"),
    code: queryParams.get("code"),
    error: hashParams.get("error") ?? queryParams.get("error"),

    errorDescription:
      hashParams.get("error_description") ??
      queryParams.get("error_description"),

    flowId: queryParams.get("sb_flow_id"),
    refreshToken: hashParams.get("refresh_token"),
    type: hashParams.get("type") ?? queryParams.get("type"),
  }
}

// ─── Auth Flow Helpers ────────────────────────────────────────────────────────

/**
 * Resolves a post-login destination path from a callback type and a routes map.
 *
 * Returns the type-specific route if present, otherwise `routes.default`,
 * otherwise `null` (no navigation should occur).
 *
 * @example
 * resolveAuthRedirect('recovery', { recovery: '/settings/security', default: '/home' })
 * // => '/settings/security'
 *
 * resolveAuthRedirect('signup', { default: '/home' })
 * // => '/home'
 *
 * resolveAuthRedirect('email', { recovery: '/settings/security' })
 * // => null
 */
export function resolveAuthRedirect(
  type: AuthCallbackType,
  routes: AuthCallbackRoutes | undefined,
): string | null {
  if (!routes) {return null}

  return routes[type] ?? routes.default ?? null
}

/**
 * Send a password recovery email with a one-click link.
 *
 * The `redirectTo` URL must be allow-listed in your Supabase project.
 * Emails also include a 6-digit OTP code as a manual fallback
 * (usable with `verifyRecoveryOTP`).
 *
 * @example
 * const { error } = await sendPasswordRecovery(supabase, email, {
 *   redirectTo: getWebAuthRedirectTo(),          // web
 *   // redirectTo: Linking.createURL('auth-callback'), // native (expo-linking)
 * })
 */
export async function sendPasswordRecovery(
  supabase: SupabaseClient,
  email: string,
  options?: { redirectTo?: string },
): Promise<{ error: Error | null }> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: options?.redirectTo,
  })

  return { error: error ? fromSupabaseError(error) : null }
}

/**
 * Verify any OTP, not only a password recovery one.
 *
 * `verifyRecoveryOTP` hardcodes `type: "recovery"` — correctly, since that is
 * what its name promises — and it was the only path in. That left every other
 * flow unreachable through Anchor: email confirmation after `signup`, an
 * `invite`, a `magiclink`, an `email_change`, an SMS `sms` or `phone_change`
 * code, and the `token_hash` form a callback link carries when no address comes
 * back with it.
 *
 * @example
 * // Confirm a sign-up from a 6-digit code
 * const { session } = await verifyOtp(supabase, {
 *   email, token: code, type: 'signup',
 * })
 *
 * @example
 * // A `?token_hash=...&type=recovery` link, verified server-side
 * const { session } = await verifyOtp(supabase, { token_hash, type: 'recovery' })
 */
export async function verifyOtp(
  supabase: SupabaseClient,
  params: VerifyOtpParams,
): Promise<{ error: Error | null; session: Session | null; }> {
  const { data, error } = await supabase.auth.verifyOtp(params as never)


  // Error first: `data.session` is null on failure and reading it first reports
  // a refused code as a successful sign-in with no session.
  if (error) {return { error: fromSupabaseError(error), session: null }}

  return { error: null, session: data.session ?? null }
}

/**
 * Verify a 6-digit OTP code from a password recovery email.
 * Use as a manual fallback when the one-click link cannot be opened
 * (e.g. the link expired, or opened on a different device).
 *
 * @example
 * const { session, error } = await verifyRecoveryOTP(supabase, email, otp)
 * if (session) router.replace('/settings/security')
 */
export async function verifyRecoveryOTP(
  supabase: SupabaseClient,
  email: string,
  otp: string,
): Promise<{ error: Error | null; session: Session | null; }> {
  return await verifyOtp(supabase, { email, token: otp, type: "recovery" })
}
