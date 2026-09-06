/**
 * The client, created by Anchor rather than by the consumer.
 *
 * Everything else in this package takes a `SupabaseClient` as its first
 * argument and has no opinion about where it came from — which left every
 * consumer importing `@supabase/supabase-js` for exactly two things: the
 * `createClient` call itself, and the `SupabaseClient` type to annotate what it
 * then passes back in. So an app could depend on Anchor for its whole data
 * layer and still had to name supabase-js in its own `package.json`, and any
 * rule of the shape "nothing outside the data layer talks to supabase-js
 * directly" was unenforceable at the one place it mattered most.
 *
 * This module closes that. It is a thin pass-through on purpose: the options
 * object is supabase-js's own, forwarded untouched, because the settings that
 * matter to a real app — a platform `auth.storage`, `detectSessionInUrl` for an
 * app that handles its own callback, `autoRefreshToken` — are supabase-js's to
 * define and would rot the moment Anchor tried to re-describe them.
 */

import {
  createClient,
  type SupabaseClient,
  type SupabaseClientOptions,
} from "@supabase/supabase-js"

/**
 * The Supabase client under a name Anchor owns.
 *
 * A plain alias, and deliberately not a wrapper: `.from()`, `.auth`, `.rpc()`
 * and `.storage` keep supabase-js's own generics, so a `Database` type flows
 * through to per-table row inference exactly as it always did. Wrapping would
 * mean restating postgrest-js's builder generics here — four of them as of
 * 2.112 (`PostgrestQueryBuilder<ClientOptions, Schema, Table, TableName>`), and
 * they have changed arity between minor versions.
 */
export type AnchorClient<DB = any> = SupabaseClient<DB>

/**
 * Create a Supabase client.
 *
 * @example
 * const client = createAnchorClient<Database>(URL, ANON_KEY, {
 *   auth: {
 *     storage: Platform.OS === 'web' ? undefined : SecureStoreAdapter,
 *     autoRefreshToken: true,
 *     persistSession: true,
 *     detectSessionInUrl: false,
 *   },
 * })
 */
export function createAnchorClient<DB = any, SchemaName extends string = "public">(
  supabaseUrl: string,
  supabaseKey: string,
  options?: SupabaseClientOptions<SchemaName>,
): AnchorClient<DB> {
  // `createClient`'s own schema generic is constrained to `keyof Database`, so
  // it cannot be satisfied from a `DB` this function has not resolved yet —
  // the constraint is checked against the type parameter, not against the
  // argument the caller eventually passes. Erasing it here and asserting the
  // return is what keeps the *caller's* signature honest: `AnchorClient<DB>`
  // is what supabase-js itself would have produced for the same arguments.
  return createClient<any, string>(supabaseUrl, supabaseKey, options) as AnchorClient<DB>
}

/**
 * The supabase-js types a consumer would otherwise import for itself.
 *
 * Re-exported as types only, matching how this package already treats Supabase
 * errors: `errors.ts` duck-types rather than reaching for `instanceof
 * PostgrestError`, because the same shape arrives from postgrest-js,
 * storage-js, functions-js and auth-js and none of them share a base class.
 * Nothing here is meant to be constructed or `instanceof`-checked — use
 * `AnchorError` and its `code` for that.
 */
export type {
  AuthChangeEvent,
  AuthError,
  PostgrestError,
  Session,
  SupabaseClient,
  SupabaseClientOptions,
  User,
} from "@supabase/supabase-js"
