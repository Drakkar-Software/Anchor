# CLAUDE.md — Anchor

## Project Overview

TypeScript library that binds Zustand state management to Supabase. Auto-generates stores from schema with offline-first, realtime, and optimistic updates.

**Monorepo structure:**
- `packages/core` — main library (`@drakkar.software/anchor`)
- `packages/adapter-web` — web adapters (`@drakkar.software/anchor-adapter-web`)
- `packages/adapter-react-native` — RN adapters (`@drakkar.software/anchor-adapter-react-native`)
- `examples/todo-app` — complete example app

## Build & Test Commands

```bash
# Type-check every package (excludes test files via tsconfig).
# CI does NOT run this — the publish workflow runs build + test only.
pnpm -r typecheck

# Lint every package (eslint-config-hardcore; ESLint 8 eslintrc).
pnpm lint

# React Doctor (all rules enabled via doctor.config.json).
pnpm lint:doctor

# Run tests. The binaries live under the PACKAGE's node_modules under pnpm;
# ../../node_modules/.bin does not exist.
cd packages/core && ./node_modules/.bin/vitest run

# Build (26 entry points, ESM + DTS)
cd packages/core && ./node_modules/.bin/tsup

# Install deps (pnpm, per `packageManager` in the root package.json)
pnpm install
```

`pnpm test` at the root is `pnpm -r test`, and only `core` defines a `test`
script — so `packages/adapter-react-native/src/expoOAuth.test.ts` exists and has
never run, in CI or locally. Do not read a green root run as covering it.

## Architecture

### Store-per-table pattern
Each Supabase table gets its own Zustand store. `createTableStore()` for single stores, `createSupabaseStores()` for bulk creation from Database type.

### Key data structures
- `records: Map<string | number, TrackedRow<Row>>` — normalized record storage
- `order: (string | number)[]` — preserves query ordering
- These MUST stay in sync — every path that modifies records must also update order

### Middleware chain
`immer → devtools → subscribeWithSelector → storeCreator` (outermost wraps first)

### Mutation pipeline
`assertNotView → runValidation → optimistic apply (with _anchor_mutationId) → remote execute → confirm/rollback`

### Concurrency patterns
- **Fetch generation counter**: `fetchGeneration` increments per fetch(), stale responses discarded
- **CAS rollback**: `_anchor_mutationId` on optimistic rows — rollback only if this mutation's write is still current
- **Pending protection**: `_anchor_pending` rows are never overwritten by realtime, cross-tab, or fetch
- **OfflineQueue**: `flushing` boolean guard, in-place splice pruning, `dependsOn` enforcement

## Critical Invariants

1. **records/order sync**: Every `records.set(id)` must have corresponding `order.push(id)` if new. Every `records.delete(id)` must filter from order.
2. **Pending protection**: Any code merging external data (realtime, cross-tab, fetch, incrementalSync) MUST check `existing?._anchor_pending` before overwriting.
3. **CAS rollback**: update/upsert/updateMany rollback MUST check `current?._anchor_mutationId === mutationId` before restoring snapshot.
4. **Set vs includes**: Use `Set` for O(1) lookup in loops (insertMany, removeMany, incrementalSync). Single-row `order.includes()` is acceptable.
5. **Persistence key**: Always use `persistenceKey` (derived from `persistence.key ?? 'anchor:${schema}:${table}'`) — never hardcode the key string.
6. **Error-check-first in auth**: Always check `error` before accessing `data.session`/`data.user` in auth methods.
7. **No silent catches**: Every `.catch()` must either log via SyncLogger or surface error to store state. No `.catch(() => {})` without justification.
8. **try/finally for flags**: The `flushing` flag in OfflineQueue and `receiving` flag in crossTabSync MUST use try/finally.

## Options that require createSupabaseStores()

These options in `CreateTableStoreOptions` only work via `createSupabaseStores()`:
- `realtime` — needs shared RealtimeManager + bindRealtimeToStore
- `conflict` — needs realtime bindings for conflict resolution
- `network` — needs shared NetworkStatusAdapter for auto-flush
- `offlineQueue` — needs shared OfflineQueue instance

When passed to standalone `createTableStore()`, these trigger a `console.warn`. The `_queue` internal option is how `createSupabaseStores` injects the shared queue.

## File Organization

| Directory | Purpose |
|-----------|---------|
| `src/query/` | Filter DSL, query executor, fluent builder, pagination |
| `src/mutation/` | Offline queue, mutation pipeline, conflict resolution, validation, batch ops |
| `src/realtime/` | RealtimeManager, store bindings |
| `src/auth/` | Auth store, auth gate (session-gated stores) |
| `src/persistence/` | PersistenceAdapter interface, MemoryAdapter |
| `src/network/` | NetworkStatusAdapter, ManualNetworkStatus |
| `src/hooks/` | React hooks (all have `"use client"` directive) |
| `src/sync/` | Cross-tab sync, incremental sync |
| `src/cache/` | Cache TTL, stale-while-revalidate |
| `src/storage/` | Supabase Storage operations |
| `src/functions/` | Edge Functions |
| `src/rpc/` | Postgres RPC |
| `src/server/` | RSC prefetch |
| `src/utils/` | Composite key encoding |

## Testing Conventions

- Tests live next to source: `foo.ts` → `foo.test.ts`
- Mock Supabase client in `src/__tests__/mockSupabase.ts`
- Use `MemoryAdapter` for persistence tests
- Test files excluded from tsconfig (avoids noUnusedLocals on test imports)
- **A type assertion in a `.test.ts` file is checked by nothing.** tsconfig
  excludes them and `vitest.config.ts` sets no `typecheck` block, so
  `expectTypeOf` there — or a `createFoo<DB>()` call whose only purpose is to
  prove an inference — passes whatever the types happen to do. Put them in
  `src/types.check.ts`, which `tsc --noEmit` does read: `Expect<Eq<A, B>>` for
  types, and an exported, never-called probe function carrying
  `@ts-expect-error` lines for a generic function's call-site behaviour. Verify a
  new assertion by breaking what it guards and watching `tsc` go red — an `Eq<>`
  alias that nothing constrains to `true` compiles either way.
- **`.test.tsx` is the exception: those files ARE typechecked.** The `exclude`
  list is `src/**/*.test.ts` and `src/__tests__`, and neither pattern matches
  `.tsx` — so hook tests get real type coverage that the 56 `.test.ts` files do
  not. Two consequences. A type assertion written in a `.test.tsx` does hold.
  And `exclude` does not apply to a file reached by an import, so each new
  `.test.tsx` pulls whatever it imports — `__tests__/mockSupabase.ts` in
  particular — into `tsc` for the first time. Latent inference errors surfacing
  there are pre-existing, not regressions.
- **A negative assertion needs its positive counterpart in the same test.** "No
  realtime channel names the view" and "the queue holds nothing for the view" are
  both true of a library that has stopped subscribing and stopped queueing
  altogether, so on their own they report a total regression as a passing
  exclusion. Three tests shipped that way in the views work and none could fail.
- **Model the generator's real output, not the tidier equivalent.** `supabase gen
  types` writes `Args: never` for a zero-argument function (not
  `Record<string, never>`) and a bare `Views: {}` for a schema with no views. A
  fixture using the neater shape asserts something no consuming app produces.

## Change Process

- **CHANGELOG.md must be updated** with every user-facing change (features, fixes, breaking changes, build/packaging). Add entries under the appropriate version heading before committing.
- Update `examples/todo-app` when adding new features or APIs to keep examples current.
- **`docs/llms.md` must be updated with every change to the public API surface** (new exports, new options, signature or behavior changes, new subpath entry points). It is a from-source reference for LLMs generating Anchor code, not a copy of the README, so update it in the same change that adds or alters the feature, not as a follow-up.

## Common Pitfalls

- **Don't set `error: null` in confirmation `set()` calls** — it masks concurrent errors. Only clear error in the optimistic-apply step.
- **Don't restore full `order` array on rollback** — it destroys concurrent mutations. Re-insert specific rows instead.
- **Don't use `order.includes()` in loops** — use Set. Single-call is OK.
- **Don't use reference equality for echo prevention** — use boolean flags (`receiving`).
- **Composite PKs**: supported since the composite-primary-key work — `createTableStore` no longer throws for an array `primaryKey`. A composite key is stored as one JSON-encoded string via `encodeKey`, so `records`/`order` still key on a single `string | number` and every single-column-PK path is unchanged. `update`/`remove`/`fetchOne`/`setRecord`/`removeRecord` accept either the encoded key or a plain `{ column: value }` object (`PrimaryKeyValue`). `insert`/`upsert` require every PK column present in the payload for a composite table — no temp-id minting, since every real composite-PK table is a join table with client-supplied FKs. `subscribe()` and `tableOptions[x].realtime` both throw for a composite-key table: realtime binding stays single-column only.
- **`fromTable()` helper**: Always use for Supabase queries to support non-public schemas.
- **`order` is the one PostgREST parameter that accumulates.** `.order()` appends
  to whatever is already in the query string; `.limit()`/`.range()` overwrite, and
  filters compose as AND. So anything pre-applied to a builder before handing it
  to caller code can be narrowed or replaced by that caller — except the sort,
  which the caller can then only add a tiebreaker to. That is why `executeQuery`
  applies filters, `select` and pagination to a `queryFn`'s builder and leaves the
  ordering alone.
- **A row keyed on a nullish primary key collapses onto another row.** `records`
  is a Map, so `rowsToMap`/the merge branch throw rather than silently keeping one
  of N rows and filling `order` with copies of `undefined`. Views are where this
  is reachable normally: view columns carry no NOT NULL inference.
