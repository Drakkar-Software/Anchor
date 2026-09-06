import { postgresChangesFilter,type RealtimePostgresFilterBuilder  } from "@supabase/supabase-js"

import type { FilterDescriptor } from "../types.js"

/**
 * Converts an Anchor `FilterDescriptor[]` into a `RealtimePostgresFilterBuilder`
 * for a `postgres_changes` subscription.
 *
 * Only operators the Supabase Realtime server evaluates are supported —
 * `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`. Anchor's
 * `contains`, `containedBy`, `overlaps`, `textSearch`, `not`, `or`, and
 * `filter` have no Realtime equivalent and are rejected.
 *
 * `match` is deliberately excluded rather than mapped: Anchor's `match` means
 * PostgREST multi-column equality (see `query/filters.ts`), but Realtime's
 * `match` / `imatch` operators are POSIX regex (`~` / `~*`). Mapping by name
 * would silently turn an equality filter into a regex filter.
 *
 * Throws if any descriptor uses an unsupported operator, rather than
 * silently dropping it — a dropped filter would widen the subscription to
 * rows the caller did not ask for.
 */
export function toRealtimeFilter(
  filters: FilterDescriptor[],
): RealtimePostgresFilterBuilder {
  const builder = postgresChangesFilter()

  for (const f of filters) {
    switch (f.op) {
      case "eq": {
        builder.eq(f.column, f.value as never)

        break
      }
      case "gt": {
        builder.gt(f.column, f.value as never)

        break
      }
      case "gte": {
        builder.gte(f.column, f.value as never)

        break
      }
      case "ilike": {
        builder.ilike(f.column, f.value as string)

        break
      }
      case "in": {
        builder.in(f.column, f.value as never)

        break
      }
      case "is": {
        builder.is(f.column, f.value as never)

        break
      }
      case "like": {
        builder.like(f.column, f.value as string)

        break
      }
      case "lt": {
        builder.lt(f.column, f.value as never)

        break
      }
      case "lte": {
        builder.lte(f.column, f.value as never)

        break
      }
      case "neq": {
        builder.neq(f.column, f.value as never)

        break
      }

      default: {
        throw new Error(
          `[anchor] realtime filter: operator "${f.op}" is not supported by Supabase Realtime postgres_changes filters (column "${f.column}"). ` +
            "Supported: eq, neq, gt, gte, lt, lte, like, ilike, is, in.",
        )
      }
    }
  }

  return builder
}
