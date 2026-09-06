/**
 * Compile-time assertions for the `Database`-extraction types.
 *
 * Nothing here runs. `packages/core/tsconfig.json` excludes
 * `src/**\/*.test.ts`, and vitest is configured without a `typecheck` block, so
 * a type assertion written in a `.test.ts` file is read by neither. `tsc
 * --noEmit` does read this file, which is the only way an edit to
 * `ExtractSchema` that quietly turns `ViewNames` into `string` — or `ViewRow`
 * into `never` — fails a build instead of shipping.
 *
 * `Expect<Eq<A, B>>` is load-bearing on both halves: `Eq` is the mutual-extends
 * pair that distinguishes `never` and `any` from a real type, and `Expect`
 * constrains it to `true` so a failed comparison is an error rather than an
 * unused alias.
 *
 * `_schemaRpcProbe` at the bottom is the same idea for a function rather than a
 * type: it is exported, never called, and its `@ts-expect-error` lines fail the
 * build if what they mark stops being an error.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { StoreApi } from "zustand"

import type { VerifyOtpParams as AnchorVerifyOtpParams } from "./auth/authCallbacks.js"
import { createSchemaRpc, type RpcResult } from "./rpc/rpcAction.js"
import type {
  ExtractSchema,
  FunctionNames,
  RpcArgs,
  RpcReturns,
  SupabaseStores,
  TableNames,
  TableRow,
  TableStore,
  ViewNames,
  ViewRow,
} from "./types.js"

export type _EmptyViewsMapped = Expect<Eq<ViewNames<EmptyViewsMapped>, never>>
export type _EmptyViewsObject = Expect<Eq<ViewNames<EmptyViewsObject>, never>>

// ── A schema shaped like a real generated file ────────────────────────

export type _Functions = Expect<
  Eq<FunctionNames<WithViews>, "record_consent" | "is_admin" | "search_notes">
>

export type _NoFunctions = Expect<Eq<FunctionNames<NoFunctions>, never>>
export type _NoFunctionsKey = Expect<Eq<FunctionNames<NoFunctionsKey>, never>>
export type _NotASchema = Expect<Eq<ExtractSchema<NotASchema>, never>>
export type _NotASchemaViews = Expect<Eq<ViewNames<NotASchema>, never>>

export type _NoViewsKey = Expect<Eq<ViewNames<NoViewsKey>, never>>

// ── Postgres functions ────────────────────────────────────────────────

export type _RpcArgs = Expect<
  Eq<RpcArgs<WithViews, "record_consent">, { p_granted: boolean; p_kind: string; }>
>
export type _RpcArgsNone = Expect<Eq<RpcArgs<WithViews, "is_admin">, never>>
export type _RpcReturns = Expect<Eq<RpcReturns<WithViews, "record_consent">, string>>
export type _RpcReturnsScalar = Expect<Eq<RpcReturns<WithViews, "is_admin">, boolean>>

// The factory's return type carries both.
export type _StoresHaveBoth = Expect<
  Eq<keyof SupabaseStores<WithViews>,
    "patients" | "journey_overview" | "visible_profiles" | "auth" | "_supabase" | "_destroy">
>

// A view name is not a table name and vice versa — the two blocks stay apart.
export type _TableRowUnaffected = Expect<
  Eq<TableRow<WithViews, "patients">, { id: string; short_name: string }>
>
export type _Tables = Expect<Eq<TableNames<WithViews>, "patients">>

/**
 * The three identifier shapes are genuinely distinct, so each has to be
 * assignable on its own — a union that satisfied the check above only through
 * one wide member would still be wrong for the other two.
 */
export type _VerifyOtpEmailMember = Expect<
  Extract<AnchorVerifyOtpParams, { email: string }> extends SdkVerifyOtpParams ? true : false
>
export type _VerifyOtpParamsMatchesSdk = Expect<
  AnchorVerifyOtpParams extends SdkVerifyOtpParams ? true : false
>

export type _VerifyOtpPhoneMember = Expect<
  Extract<AnchorVerifyOtpParams, { phone: string }> extends SdkVerifyOtpParams ? true : false
>

export type _VerifyOtpTokenHashMember = Expect<
  Extract<AnchorVerifyOtpParams, { token_hash: string }> extends SdkVerifyOtpParams ? true : false
>

// ── The empty shapes the generator actually emits ─────────────────────

export type _ViewRow = Expect<
  Eq<
    ViewRow<WithViews, "journey_overview">,
    { current_day: number | null; id: string | null; patient_id: string | null; }
  >
>
export type _Views = Expect<Eq<ViewNames<WithViews>, "journey_overview" | "visible_profiles">>

/** And `Views: { [_ in never]: never }` in some versions. */
type EmptyViewsMapped = {
  public: {
    Tables: { patients: { Insert: { id?: string }; Row: { id: string }; Update: { id?: string } } }
    Views: { [_ in never]: never }
  }
}


/** Supabase writes a bare `Views: {}` for a schema with no views. */
type EmptyViewsObject = {
  public: {
    Tables: { patients: { Insert: { id?: string }; Row: { id: string }; Update: { id?: string } } }

    // Generator emits a bare `{}` — model that, not `Record<string, never>`.
    Views: {}
  }
}

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false

type Expect<T extends true> = T

/** A schema with no functions: the generator writes `Functions: {}`. */
type NoFunctions = {
  public: {
    // Generator emits a bare `{}` — model that, not `Record<string, never>`.
    Functions: {}
    Tables: { patients: { Insert: { id?: string }; Row: { id: string }; Update: { id?: string } } }
  }
}


/** …and a hand-written one with no `Functions` key at all. */
type NoFunctionsKey = {
  public: {
    Tables: { patients: { Insert: { id?: string }; Row: { id: string }; Update: { id?: string } } }
  }
}


/** A `DB` that is not a schema at all: `ExtractSchema` gives `never`. */
type NotASchema = { public: { Something: unknown } }

// ── upsert's conflict target ──────────────────────────────────────────

/**
 * A hand-written `Database` with no `Views` key at all. `views:` must reject
 * every string here rather than accepting any — the failure mode is silent,
 * because `views: ["typo"]` would then build a store that fetches a relation
 * Postgres does not have.
 */
type NoViewsKey = {
  public: {
    Tables: { patients: { Insert: { id?: string }; Row: { id: string }; Update: { id?: string } } }
  }
}

// ── composite primary keys ────────────────────────────────────────────

type ScopedSchema = {
  app: {
    Functions: { current_day: { Args: never; Returns: number } }
    Tables: { notes: { Insert: { id?: string }; Row: { id: string }; Update: { id?: string } } }
  }
}

// ─── verifyOtp ───────────────────────────────────────────────────────
//
// `verifyOtp` passes its params to `supabase.auth.verifyOtp(params as never)`.
// The cast is there because Anchor's `VerifyOtpParams` is hand-written rather
// than re-exported — and a cast means nothing checks the hand-written union
// against the real one. If a member were wrong (a `type` value auth-js does not
// accept, an `options` key it does not have) no test would say so, because the
// tests assert against a `vi.fn()`.
//
// This is the check the cast removed: every member of Anchor's union must be
// assignable to auth-js's. Renaming `token` to `code`, dropping a required
// field, or adding an `options` key the SDK does not have all go red here.
//
// **What it deliberately cannot catch: a wrong `type` value.** auth-js declares
// `EmailOtpType` and `MobileOtpType` as `'signup' | ... | (string & {})`, and
// that trailing member makes every string assignable — the escape hatch exists
// so a new server-side OTP type does not require an SDK release. So
// `type: "maglink"` type-checks here and fails at runtime, and no assignability
// assertion can change that. Verified by trying it: the typo compiles clean,
// the shape break fails two of the four lines below. Written down because an
// `Expect<>` that cannot fail for the reason you assume is the exact trap this
// file exists to avoid.

type SdkVerifyOtpParams = Parameters<SupabaseClient["auth"]["verifyOtp"]>[0]

type WithViews = {
  public: {
    Enums: Record<string, never>
    Functions: {
      // What `supabase gen types` actually writes for a zero-argument function:
      // `never`, not `Record<string, never>`. metcare's generated schema has six
      // of them (`is_admin`, `jwt_role`, `accessible_patients`, …), so a fixture
      // using the tidier shape would assert something no real Database produces.
      is_admin: { Args: never; Returns: boolean }
      record_consent: {
        Args: { p_granted: boolean; p_kind: string; }
        Returns: string
      }
      search_notes: { Args: { p_term?: string }; Returns: string[] }
    }
    Tables: {
      patients: {
        Insert: { id?: string; short_name: string }
        Row: { id: string; short_name: string }
        Update: { id?: string; short_name?: string }
      }
    }
    Views: {
      journey_overview: {
        Row: { current_day: number | null; id: string | null; patient_id: string | null; }
      }
      visible_profiles: {
        Row: { display_name: string | null; id: string | null; }
      }
    }
  }
}

/**
 * `PrimaryKeyValue` on a composite-key table's mutators, exercised where the
 * compiler can see it.
 *
 * `update`/`remove`/`fetchOne`/`setRecord`/`removeRecord` widened from
 * `string | number` to accept a plain `{ column: value }` object too — a
 * widening that is easy to lose silently back to `any` at a refactor, which
 * would stop catching the one real typo this shape has (a misnamed column
 * key). Never called. Exported so `noUnusedLocals` keeps it.
 */
export async function _primaryKeyValueProbe(
  store: StoreApi<
    TableStore<
      { note?: string; service_id: string; stay_id: string; },
      { note?: string; service_id: string; stay_id: string; },
      { note?: string }
    >
  >,
) {
  const actions = store.getState()

  // The pre-encoded key a single-column table has always used still works.
  await actions.update("stay1::svc1", { note: "n" })

  // The plain-object shape composite keys exist for.
  await actions.update({ service_id: "svc1", stay_id: "s1" }, { note: "n" })
  await actions.remove({ service_id: "svc1", stay_id: "s1" })
  await actions.fetchOne({ service_id: "svc1", stay_id: "s1" })
  actions.setRecord({ service_id: "svc1", stay_id: "s1" }, {
    service_id: "svc1",
    stay_id: "s1",
  })
  actions.removeRecord({ service_id: "svc1", stay_id: "s1" })

  // A misspelt column must not be swallowed — the object is a bare
  // `Record<string, unknown>` at the type level, so this specifically checks
  // that a NUMBER or other non-object/non-string/non-number value is still
  // rejected, not that every key name is validated (it cannot be, without a
  // generic over the table's own column names).
  // @ts-expect-error - a boolean is not a PrimaryKeyValue
  await actions.update(true, { note: "n" })
}

/**
 * `createSchemaRpc` itself, exercised where the compiler can see it. Its calls
 * in `rpc/rpcAction.test.ts` are invisible to `tsc` (tsconfig excludes
 * `*.test.ts`) and vitest does not typecheck, so without this the whole value of
 * the export — rejecting an unknown name, rejecting or requiring arguments,
 * inferring the return — could be widened to `any` with every build still green.
 *
 * Never called. Exported so `noUnusedLocals` does not strip the reason it exists.
 */
export async function _schemaRpcProbe(
  supabase: SupabaseClient<WithViews>,
  scoped: SupabaseClient<ScopedSchema>,
): Promise<void> {
  const rpc = createSchemaRpc<WithViews>(supabase)

  // The return type comes from the schema, not from a type argument.
  // Compile-time probe only — never executed at runtime.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const consent: RpcResult<string> = await rpc("record_consent", {
    p_granted: true,
    p_kind: "care",
  })
  const admin: RpcResult<boolean> = await rpc("is_admin")

  void consent
  void admin

  // @ts-expect-error not a function in this schema
  await rpc("no_such_function")

  // @ts-expect-error record_consent's arguments are required
  await rpc("record_consent")

  // @ts-expect-error p_kind is a string
  await rpc("record_consent", { p_granted: true, p_kind: 1 })

  // @ts-expect-error is_admin takes none
  await rpc("is_admin", { p_kind: "care" })

  // Every property optional, so the object itself may be left out.
  await rpc("search_notes")

  // A Database with no `public` key needs its schema named, or every function
  // resolves to `never`.
  const scopedRpc = createSchemaRpc<ScopedSchema, "app">(scoped)
  const day: RpcResult<number> = await scopedRpc("current_day")

  void day
}

/**
 * `upsert`'s second parameter, exercised where the compiler can see it.
 *
 * The check-in write depends on `onConflict` reaching PostgREST, and a
 * signature that widened to `(row, options?: any)` — or dropped the parameter
 * back to one — would leave every runtime test in
 * `mutation/upsertConflict.test.ts` passing while the call site stopped being
 * checked. The `@ts-expect-error` lines are the load-bearing half: they fail
 * the build if what they mark stops being an error.
 *
 * Never called. Exported so `noUnusedLocals` keeps it.
 */
export async function _upsertOptionsProbe(
  store: StoreApi<
    TableStore<{ id: string; pain: number }, { pain: number }, { pain?: number }>
  >,
) {
  const actions = store.getState()

  // The whole point: a conflict target that is not the primary key.
  await actions.upsert({ pain: 3 }, { onConflict: "journey_id,date" })

  // A no-`update`-grant join table's whole reason to exist: DO NOTHING
  // alongside a real conflict target, not a bare boolean on its own.
  await actions.upsert({ pain: 3 }, { ignoreDuplicates: true, onConflict: "journey_id,date" })

  // Optional, because every existing call site passes one argument.
  await actions.upsert({ pain: 3 })

  // A misspelt key must not be swallowed by an index signature or by `any`.
  // @ts-expect-error - `onConflicts` is not an UpsertOptions key
  await actions.upsert({ pain: 3 }, { onConflicts: "journey_id,date" })

  // `onConflict` names its columns as one comma-separated string, the way
  // supabase-js takes it — an array is the shape people reach for first.
  // @ts-expect-error - onConflict is a string, not string[]
  await actions.upsert({ pain: 3 }, { onConflict: ["journey_id", "date"] })
}
