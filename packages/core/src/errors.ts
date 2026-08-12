/**
 * A Supabase error that kept its structured fields.
 *
 * Every boundary in this package used to do `new Error(error.message)`, which
 * throws away `code`, `details` and `hint` — the only parts a consumer can
 * branch on. Without them there is no way to tell `23505` (unique violation,
 * usually "you already have one of these") from `42501` (insufficient
 * privilege, "the policy said no") from `PGRST116` (no rows), because all three
 * arrive as prose written for a log file.
 *
 * The cost was visible inside this package too: `isRlsError` had to
 * substring-match the literal text `"42501"` in the message, and the reference
 * consumer pattern-matches English message text to classify sign-in failures.
 *
 * `AnchorError extends Error`, so `TableStoreState.error` stays `Error | null`
 * and every existing `instanceof Error`, `.message` read and `catch` keeps
 * working. The fields are additive.
 */
export class AnchorError extends Error {
  /** PostgREST/Postgres error code — `23505`, `42501`, `PGRST116`, … */
  readonly code?: string
  /** Postgres' longer explanation, when the API sends one. */
  readonly details?: string
  /** Postgres' suggested fix, when the API sends one. */
  readonly hint?: string
  /** HTTP status, for the boundaries that expose one (storage, functions). */
  readonly status?: number

  constructor(
    message: string,
    fields?: { code?: string; details?: string; hint?: string; status?: number },
  ) {
    super(message)
    this.name = "AnchorError"
    this.code = fields?.code
    this.details = fields?.details
    this.hint = fields?.hint
    this.status = fields?.status
  }
}

/**
 * Wraps whatever a supabase-js call put in `error` into an `AnchorError`.
 *
 * Deliberately duck-typed rather than `instanceof PostgrestError`: the same
 * shape arrives from postgrest-js, storage-js, functions-js and auth-js, none
 * of which share a base class, and the test mock returns plain object literals.
 * An `AnchorError` passes through unchanged so a boundary can wrap twice
 * without nesting.
 */
export function fromSupabaseError(error: unknown, fallbackMessage = "Unknown error"): AnchorError {
  if (error instanceof AnchorError) return error

  if (typeof error === "object" && error !== null) {
    const e = error as {
      message?: unknown
      code?: unknown
      details?: unknown
      hint?: unknown
      status?: unknown
    }
    return new AnchorError(typeof e.message === "string" ? e.message : fallbackMessage, {
      code: typeof e.code === "string" ? e.code : undefined,
      details: typeof e.details === "string" ? e.details : undefined,
      hint: typeof e.hint === "string" ? e.hint : undefined,
      status: typeof e.status === "number" ? e.status : undefined,
    })
  }

  return new AnchorError(typeof error === "string" ? error : fallbackMessage)
}

/** Postgres `insufficient_privilege` — what RLS returns when a policy refuses. */
export const PG_INSUFFICIENT_PRIVILEGE = "42501"
/** Postgres `unique_violation`. */
export const PG_UNIQUE_VIOLATION = "23505"
/** Postgres `foreign_key_violation`. */
export const PG_FOREIGN_KEY_VIOLATION = "23503"
/** PostgREST: `.single()` matched no row. */
export const PGRST_NO_ROWS = "PGRST116"
