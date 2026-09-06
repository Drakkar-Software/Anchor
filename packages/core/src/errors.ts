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
  if (error instanceof AnchorError) {return error}

  if (typeof error === "object" && error !== null) {
    const e = error as {
      code?: unknown
      details?: unknown
      hint?: unknown
      message?: unknown
      status?: unknown
    }

    return new AnchorError(typeof e.message === "string" ? e.message : fallbackMessage, {
      // An empty `code` is *absent*, not a code. postgrest-js writes `code: ""`
      // on every failure Postgres never saw — see `isTransportError` — and a
      // consumer branching on `err.code` wants those to read as "no code" the
      // same way a thrown `TypeError` does.
      code: typeof e.code === "string" && e.code !== "" ? e.code : undefined,
      details: typeof e.details === "string" ? e.details : undefined,
      hint: typeof e.hint === "string" ? e.hint : undefined,
      status: typeof e.status === "number" ? e.status : undefined,
    })
  }

  return new AnchorError(typeof error === "string" ? error : fallbackMessage)
}

/**
 * True when the request never reached Postgres — no network, DNS failure, the
 * server unreachable, or the fetch aborted.
 *
 * **postgrest-js does not throw these**, which is the whole reason this
 * function has to exist. `PostgrestBuilder.then` installs a `res.catch(...)`
 * that turns a rejected fetch into the ordinary `{ data: null, error }` pair
 * (`dist/index.cjs:328` on 2.108.2, `:394` on 2.112.3), so a dead network and a
 * policy refusal arrive through exactly the same slot and are indistinguishable
 * by shape. What separates them is what the server contributed: a refusal
 * carries Postgres' own `code` and a real HTTP status, and a request that never
 * completed carries `status: 0` with `code: ""`.
 *
 * The `status` is on the **response**, not on the error object, so callers pass
 * both. Requiring `status === 0` rather than merely inferring from a missing
 * code is deliberate and conservative: a 5xx with an unparseable body also
 * arrives without a code, and that request *did* reach a server. Queuing it
 * would retry a real rejection, and this decision is what stands between a
 * queued write and telling someone their data was sent.
 *
 * Written against the two fields rather than the message text, which is
 * `${name}: ${message}` from whatever `fetch` threw and differs per platform
 * ("Failed to fetch" on web, "Network request failed" on React Native).
 */
export function isTransportError(error: unknown, status: number | undefined): boolean {
  if (error == null || status !== 0) {return false}

  const {code} = (error as { code?: unknown })

  return typeof code !== "string" || code === ""
}

/** Postgres `insufficient_privilege` — what RLS returns when a policy refuses. */
export const PG_INSUFFICIENT_PRIVILEGE = "42501"

/** Postgres `unique_violation`. */
export const PG_UNIQUE_VIOLATION = "23505"

/** Postgres `foreign_key_violation`. */
export const PG_FOREIGN_KEY_VIOLATION = "23503"

/** PostgREST: `.single()` matched no row. */
export const PGRST_NO_ROWS = "PGRST116"
