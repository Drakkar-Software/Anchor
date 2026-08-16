/**
 * The auth calls that are not the auth *store*.
 *
 * `createAuthStore` owns the session: it subscribes, it holds `session`/`user`
 * in state, and it exposes the five actions that change who is signed in
 * (`signIn`, `signUp`, `signOut`, `signInWithOAuth`, `refreshSession`). That
 * covers a signed-in app and nothing else, so every flow *around* the session
 * — confirming a sign-up, resending a code, changing a password, or simply
 * reading the current user from a headless function with no React in sight —
 * had no Anchor path and went to `supabase.auth.*` directly.
 *
 * These are free functions taking the client first, like `callRpc`,
 * `invokeEdgeFunction` and `uploadFile`, and like `sendPasswordRecovery` and
 * `verifyOtp` next door in `authCallbacks.ts`. None of them throws: each
 * returns its result beside an `error`, wrapped by `fromSupabaseError` so a
 * caller can branch on `.code` rather than on message prose.
 *
 * Two of these overlap the store on purpose. `signInWithPassword` is the
 * re-authentication step before a destructive account change, where the point
 * is to verify the current password *without* disturbing the store's state;
 * `getUser`/`getSession` are for code that has no store to read.
 */

import type { Session, SupabaseClient, User } from "@supabase/supabase-js"
import { AnchorError, fromSupabaseError } from "../errors.js"

/**
 * The session as supabase-js currently holds it.
 *
 * Local and cheap — it reads the stored session and refreshes it only if it has
 * expired. Prefer the auth store in a React tree, where the session is already
 * in state and subscribed; this is for the headless callers.
 */
export async function getSession(
  supabase: SupabaseClient,
): Promise<{ session: Session | null; error: AnchorError | null }> {
  const { data, error } = await supabase.auth.getSession()
  if (error) return { session: null, error: fromSupabaseError(error) }
  return { session: data?.session ?? null, error: null }
}

/**
 * The signed-in user, re-read from the auth server.
 *
 * Unlike `getSession` this makes a request, which is what makes it the right
 * call before anything consequential: a session can be locally present and
 * already revoked server-side.
 */
export async function getUser(
  supabase: SupabaseClient,
): Promise<{ user: User | null; error: AnchorError | null }> {
  const { data, error } = await supabase.auth.getUser()
  if (error) return { user: null, error: fromSupabaseError(error) }
  return { user: data?.user ?? null, error: null }
}

/** Options a sign-up can carry — all optional, all supabase-js's own. */
export interface SignUpOptions {
  /** Where the confirmation link should land. Must be allow-listed in the project. */
  emailRedirectTo?: string
  /** Written to `auth.users.raw_user_meta_data`, and readable from the JWT. */
  data?: Record<string, unknown>
  captchaToken?: string
}

/**
 * Create an account with an email and a password.
 *
 * `session` is null when the project requires email confirmation — which is not
 * an error, and is the case worth branching on: the account exists and the code
 * is in the inbox. Verify it with `verifyOtp`.
 */
export async function signUpWithPassword(
  supabase: SupabaseClient,
  credentials: { email: string; password: string; options?: SignUpOptions },
): Promise<{ session: Session | null; user: User | null; error: AnchorError | null }> {
  const { data, error } = await supabase.auth.signUp({
    email: credentials.email,
    password: credentials.password,
    options: credentials.options,
  })
  // Error first: on failure `data` still carries a `{session: null, user: null}`
  // pair, and reading it first reports a refusal as a confirmation-pending
  // sign-up — the one state that legitimately has no session.
  if (error) return { session: null, user: null, error: fromSupabaseError(error) }
  return { session: data?.session ?? null, user: data?.user ?? null, error: null }
}

/**
 * Sign in with an email and a password, without touching the auth store.
 *
 * This is the re-authentication step in front of a destructive account change
 * ("confirm your current password"), which is why it exists beside the store's
 * own `signIn` rather than inside it. supabase-js still writes the returned
 * session to its storage, so the caller is confirming the password of the user
 * who is already signed in, not switching accounts.
 */
export async function signInWithPassword(
  supabase: SupabaseClient,
  credentials: { email: string; password: string },
): Promise<{ session: Session | null; user: User | null; error: AnchorError | null }> {
  const { data, error } = await supabase.auth.signInWithPassword(credentials)
  if (error) return { session: null, user: null, error: fromSupabaseError(error) }
  return { session: data?.session ?? null, user: data?.user ?? null, error: null }
}

/** What `updateUser` may change. Every field is optional and independent. */
export interface UpdateUserAttributes {
  email?: string
  password?: string
  phone?: string
  /** Merged into `raw_user_meta_data`; keys absent here are left alone. */
  data?: Record<string, unknown>
  nonce?: string
}

/**
 * Change the signed-in user's password, email, phone or metadata.
 *
 * The password path is the one with a trap: it requires a live session, so it
 * works both after an ordinary sign-in and after a recovery OTP has been
 * verified — those are the same state as far as this call is concerned, which
 * is exactly why a recovery flow ends here rather than at a special endpoint.
 */
export async function updateUser(
  supabase: SupabaseClient,
  attributes: UpdateUserAttributes,
): Promise<{ user: User | null; error: AnchorError | null }> {
  const { data, error } = await supabase.auth.updateUser(attributes)
  if (error) return { user: null, error: fromSupabaseError(error) }
  return { user: data?.user ?? null, error: null }
}

/** Which unconfirmed flow to send again, by the identifier it arrives on. */
export type ResendOtpParams =
  | {
      type: "signup" | "email_change"
      email: string
      options?: { emailRedirectTo?: string; captchaToken?: string }
    }
  | {
      type: "sms" | "phone_change"
      phone: string
      options?: { captchaToken?: string }
    }

/**
 * Send an unconfirmed sign-up or change-of-address code again.
 *
 * Distinct from `sendPasswordRecovery`, which starts a *recovery* for an
 * account that is already confirmed. This one re-sends a confirmation the user
 * never completed — the "I didn't get the code" button on a verification
 * screen. The project's rate limit applies, and its refusal arrives as an
 * ordinary error with a code.
 */
export async function resendOtp(
  supabase: SupabaseClient,
  params: ResendOtpParams,
): Promise<{ error: AnchorError | null }> {
  const { error } = await supabase.auth.resend(params as never)
  return { error: error ? fromSupabaseError(error) : null }
}
