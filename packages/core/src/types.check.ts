/**
 * Compile-time assertions for the `Database`-extraction types.
 *
 * These have no runtime and no test: `packages/core/tsconfig.json` excludes
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
 */

import type {
  ExtractSchema,
  TableNames,
  TableRow,
  ViewNames,
  ViewRow,
  SupabaseStores,
} from "./types.js"

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false
type Expect<T extends true> = T

// ── A schema shaped like a real generated file ────────────────────────

type WithViews = {
  public: {
    Tables: {
      patients: {
        Row: { id: string; short_name: string }
        Insert: { id?: string; short_name: string }
        Update: { id?: string; short_name?: string }
      }
    }
    Views: {
      journey_overview: {
        Row: { id: string | null; patient_id: string | null; current_day: number | null }
      }
      visible_profiles: {
        Row: { id: string | null; display_name: string | null }
      }
    }
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}

export type _Views = Expect<Eq<ViewNames<WithViews>, "journey_overview" | "visible_profiles">>
export type _Tables = Expect<Eq<TableNames<WithViews>, "patients">>
export type _ViewRow = Expect<
  Eq<
    ViewRow<WithViews, "journey_overview">,
    { id: string | null; patient_id: string | null; current_day: number | null }
  >
>
// A view name is not a table name and vice versa — the two blocks stay apart.
export type _TableRowUnaffected = Expect<
  Eq<TableRow<WithViews, "patients">, { id: string; short_name: string }>
>

// The factory's return type carries both.
export type _StoresHaveBoth = Expect<
  Eq<keyof SupabaseStores<WithViews>,
    "patients" | "journey_overview" | "visible_profiles" | "auth" | "_supabase" | "_destroy">
>

// ── The empty shapes the generator actually emits ─────────────────────

/** Supabase writes a bare `Views: {}` for a schema with no views. */
type EmptyViewsObject = {
  public: {
    Tables: { patients: { Row: { id: string }; Insert: { id?: string }; Update: { id?: string } } }
    // eslint-disable-next-line @typescript-eslint/ban-types
    Views: {}
  }
}
export type _EmptyViewsObject = Expect<Eq<ViewNames<EmptyViewsObject>, never>>

/** And `Views: { [_ in never]: never }` in some versions. */
type EmptyViewsMapped = {
  public: {
    Tables: { patients: { Row: { id: string }; Insert: { id?: string }; Update: { id?: string } } }
    Views: { [_ in never]: never }
  }
}
export type _EmptyViewsMapped = Expect<Eq<ViewNames<EmptyViewsMapped>, never>>

/**
 * A hand-written `Database` with no `Views` key at all. `views:` must reject
 * every string here rather than accepting any — the failure mode is silent,
 * because `views: ["typo"]` would then build a store that fetches a relation
 * Postgres does not have.
 */
type NoViewsKey = {
  public: {
    Tables: { patients: { Row: { id: string }; Insert: { id?: string }; Update: { id?: string } } }
  }
}
export type _NoViewsKey = Expect<Eq<ViewNames<NoViewsKey>, never>>

/** A `DB` that is not a schema at all: `ExtractSchema` gives `never`. */
type NotASchema = { public: { Something: unknown } }
export type _NotASchema = Expect<Eq<ExtractSchema<NotASchema>, never>>
export type _NotASchemaViews = Expect<Eq<ViewNames<NotASchema>, never>>
