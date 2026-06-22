import type { SupabaseClient, Session } from "@supabase/supabase-js"

// ─── Types ────────────────────────────────────────────────────────────────────

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
  /** refresh_token from the hash fragment (implicit flow) */
  refreshToken: string | null
  /** authorization code from query params (PKCE flow) */
  code: string | null
  /** auth flow type (recovery, signup, magiclink, email, email_change, invite) */
  type: AuthCallbackType | null
  /** OAuth/Supabase error code */
  error: string | null
  /** Human-readable error description */
  errorDescription: string | null
}

/** Result of a successful auth callback */
export type AuthCallbackResult = {
  session: Session
  /** auth flow type from the callback URL */
  type: AuthCallbackType
}

// ─── URL Parsing ──────────────────────────────────────────────────────────────

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
  const hashString = hashIndex >= 0 ? url.slice(hashIndex + 1) : ""
  const hashParams = new URLSearchParams(hashString)

  const queryString = url.split("?")[1]?.split("#")[0] ?? ""
  const queryParams = new URLSearchParams(queryString)

  return {
    accessToken: hashParams.get("access_token"),
    refreshToken: hashParams.get("refresh_token"),
    code: queryParams.get("code"),
    type: hashParams.get("type") ?? queryParams.get("type"),
    error: hashParams.get("error") ?? queryParams.get("error"),
    errorDescription:
      hashParams.get("error_description") ??
      queryParams.get("error_description"),
  }
}

/**
 * Detect whether a URL contains Supabase auth callback parameters
 * (access_token, code, or error) that require processing.
 */
export function hasAuthCallbackParams(url: string): boolean {
  const parsed = parseAuthCallbackUrl(url)
  return !!(parsed.accessToken ?? parsed.code ?? parsed.error)
}

// ─── Session from URL ─────────────────────────────────────────────────────────

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
    if (error) throw new Error(error.message)
    if (!data.session) throw new Error("Session could not be established")
    return { session: data.session, type }
  }

  // PKCE flow: exchange authorization code for session
  if (parsed.code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(
      parsed.code,
    )
    if (error) throw new Error(error.message)
    if (!data.session) throw new Error("Session could not be established")
    return { session: data.session, type }
  }

  return null
}

// ─── Redirect URL Helpers ─────────────────────────────────────────────────────

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
  if (typeof window === "undefined") {
    throw new Error(
      "getWebAuthRedirectTo() is only available in browser environments. " +
        "For native (React Native / Expo), use your app scheme: " +
        '`Linking.createURL("auth-callback")` from expo-linking.',
    )
  }
  const cleanPath = path.replace(/^\//, "")
  return `${window.location.origin}/${cleanPath}`
}

// ─── Auth Flow Helpers ────────────────────────────────────────────────────────

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
  return { error: error ? new Error(error.message) : null }
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
): Promise<{ session: Session | null; error: Error | null }> {
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: otp,
    type: "recovery",
  })
  return {
    session: data?.session ?? null,
    error: error ? new Error(error.message) : null,
  }
}
