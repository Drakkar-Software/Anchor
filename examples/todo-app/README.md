# Todo App Example

A complete example demonstrating all @drakkar.software/anchor features.

## Files

| File | What it demonstrates |
|------|---------------------|
| `src/database.types.ts` | Supabase generated types (normally via `supabase gen types`) |
| `src/stores.ts` | Store setup: createSupabaseStores, createTableStore with extensions, auth gate, app lifecycle, sync metrics, cache strategy, conflict resolution |
| `src/App.tsx` | React app: useQuery (with staleTime), useInfiniteQuery, useLinkedQuery, useMutation, useAuth, useRealtime, useSyncStatus, useQueueStatus, useSuspenseQuery, fluent query builder, clearAndFetch |
| `src/rpc-storage-example.ts` | Standalone features: RPC with retry, Edge Functions, Storage, incremental & selective sync, cache TTL, circuit breaker, rate limiter, aggregation, encryption, schema versioning, sync metrics |
| `src/server-example.tsx` | React Server Components: server-side prefetch + client hydration |

## Setup

1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Create the `todos` and `profiles` tables
3. Generate types: `npx supabase gen types typescript > src/database.types.ts`
4. Set environment variables:
   ```
   VITE_SUPABASE_URL=your-project-url
   VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   ```
5. Install dependencies and run

## Features Demonstrated

- **Optimistic mutations** — UI updates instantly, rolls back on failure
- **Offline support** — Mutations queue when offline, auto-flush on reconnect
- **Realtime** — Live updates from other users with conflict resolution
- **Auth** — Sign in/out with session management and auth-gated stores
- **Validation** — Title required validation before insert
- **Cross-tab sync** — Changes sync across browser tabs
- **Cache strategy** — Merge mode accumulates records; clearAndFetch to invalidate
- **Infinite scroll** — Cursor-based load-more with useInfiniteQuery
- **Linked queries** — Custom queries that auto-refetch on store mutations
- **Sync monitoring** — useSyncStatus and useQueueStatus for sync state UI
- **App lifecycle** — Auto-flush queue, refresh auth, revalidate on foreground
- **React Suspense** — Suspense-compatible data fetching
- **Fluent queries** — `query<Todo>().where('completed').eq(false).build()`
- **Retry & resilience** — withRetry, CircuitBreaker, RateLimiter
- **Aggregation** — Client-side sum/avg/min/max/count on store data
- **Encryption** — Transparent encryption for persisted data
- **Schema versioning** — Auto-clear stale cache on schema changes
- **Sync metrics** — Track fetch latency, error rates, conflict counts
- **RPC / Edge Functions / Storage** — Full Supabase feature coverage
- **Server Components** — Server-side prefetch
