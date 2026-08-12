# Changelog

## [2.1.0] - 2026-08-12

### Behaviour change

**`useQuery` now returns its own query's rows.** It used to project the entire store through `order` and hand back everything the table held, whatever filters it was given. Two components reading one table with different filters collided four ways, all of them from the store keeping a single global answer: the second component's fetch was suppressed by the first's `lastFetchedAt`, the single in-flight promise handed it the first's rows without issuing its own request, a shared generation counter let one query's response discard another's, and `isLoading`/`error` were the table's rather than the query's.

Each store now keeps a `queries` registry keyed by `queryKey(options)` — filters, sort, select, limit and offset, key-order insensitive and value-based. `count`, `cacheStrategy` and `queryFn` are deliberately not part of the key. The in-flight map and the generation counter are keyed the same way, and `refetch()` replays every live query rather than whichever options were written last.

Three consequences to expect when upgrading:

- A component that relied on `useQuery(store, {filters})` returning more than its filters asked for gets less back. That was the bug, but it is a visible change.
- Request volume rises. A new filter combination always fetches, even when the store already holds rows that would satisfy it, because freshness is now per query rather than per table.
- `useQuery` gained `count`, and its effect now re-runs when `limit`, `offset` or `select` change. Those three previously changed nothing.

The registry holds **metadata only** — a count, two flags and a timestamp, no row ids. Rows come from `order` filtered by a new client-side `matchRow` and ordered by the query's own `sort`, which is what makes an optimistic insert, a realtime event and a store rehydrated from disk all appear in the right query, in the right order, without any of the store's other writers knowing that queries exist. One limitation follows and is documented rather than half-solved: `limit`/`offset` are not applied locally, so a limited query renders whatever an unlimited sibling has loaded into the same store. `cacheStrategy: "replace"` likewise keeps single-query semantics, so a store serving two live queries should use `"merge"`.

`TableStoreState` gains `queries`. `TableStoreActions` gains three methods:

- `resolveFetchOptions()` — the options `fetch` would actually use. Public because a caller has to key on the same effective options `fetch` files an entry under, and the store's `defaultFilters`/`defaultSort`/`defaultSelect` are closure variables it cannot see.
- `retainQuery()` / `releaseQuery()` — refcounted, called by `useQuery` on mount and unmount. Only retained queries are replayed by `refetch()` and only unretained ones can be evicted from the registry, so a foreground refresh reaches the screens on display rather than every filter combination the store has ever been handed.

Also exported: `queryKey`, `isKeyable`, `matchRow`, `selectAllRows`, `selectQueryRows`, `sortRows` and the `QueryEntry` type.

**A fetched row with no primary key now fails the fetch.** `records` is a Map keyed on the primary key, so a row arriving with that column `null` or absent used to collapse onto whatever else keyed to the same value: three rows in, one record kept, `order` holding three copies of `undefined`, and every projection rendering the last row three times. Nothing about the result read as broken. The fetch and hydrate paths now throw an `AnchorError` naming the relation and the column, which lands in `state.error` and in the query's own entry like any other failed fetch.

On a table this is reachable only through a `defaultSelect` that omits the key column. On a view it is ordinary — a generated `Database` marks every view column nullable, and a LEFT JOIN really can produce a null id — which is why it ships with the views work below. `mergeRecords()` is deliberately not covered: it is a synchronous store setter fed by caller-supplied rows, and throwing out of a zustand `set` is worse than what it would fix.

### Bug fixes

- **`cacheStrategy: "merge"` silently dropped rows.** The commit rebuilt `order` from the latest response plus pending rows only, so every non-pending row from an earlier fetch stayed in `records` and disappeared from `order` — in memory, and invisible to every projection, since `order` is the only route in. A narrower second fetch therefore emptied the first query's screen while `records.size` still counted its rows. `order` now leads with the latest query and keeps the rest.
- **`useSuspenseQuery` cached its promise per store, not per query**, so two suspense boundaries on one table with different filters shared one promise: the second waited on the first's fetch and rendered its rows. It also gated on the table's `lastFetchedAt` and threw the table's error.
- **`clearAll()` and `clearAndFetch()` left query state behind**, and a response still in flight across a sign-out could repopulate the store that had just been emptied for a different account. The stale-response guard now counts from a monotonic per-store number that no clear path resets, and an abandoned in-flight promise can no longer evict its own replacement when it finally settles.
- **`useSuspenseQuery` could never surface an error.** Its `throw` sat after the suspend branch, and a failed fetch does not stamp `lastFetchedAt` (deliberately — a refusal is not fresh data), so a query the server refused suspended, refetched, threw a fresh promise and repeated, while the error boundary never saw anything. A query using `queryFn` had the same shape for a different reason: it registers no entry at all, so it now reads the table's own state, as every query did before this release.
- **`isLoading` was judged on the table's row count**, so a brand-new query on a store that already held someone else's rows reported "not loading" with nothing of its own to show — the screen rendered its empty state and then popped to content.

### Features

- **Views can be wired through `createSupabaseStores`**: new `views:` and `viewOptions:` options, plus `ViewNames` / `ViewRow` type extractors. A generated Supabase `Database` keeps views in their own `Views` block, and nothing in the package read it — `TableNames` extracts from `Tables` only — so a view could only be a hand-built `createViewStore`, outside the shared persistence, auth gate and cleanup that the factory sets up. A view store now gets all of that, minus the two things that cannot apply to it: no offline-queue *executor*, since it is not writable, and **no realtime subscription**, since Postgres publishes changes under the underlying *table's* name and a channel on a view's name would register and never fire. A view whose freshness matters needs a refetch trigger of its own. It does hold the shared queue, so `getQueueSize()` reports a real 0 rather than a hardcoded one and `flushQueue()` flushes; nothing can enqueue for it, because all four mutators throw.

  `viewOptions` accepts the five keys that mean something for a read-only store. Its `primaryKey` is a single column, unlike `tableOptions`', and setting it is worth doing on almost every view: a generated `Database` marks every view column nullable (Postgres infers no NOT NULL through one), so the default `"id"` is not safe to lean on, and a row that reaches the store without it now fails the fetch rather than collapsing onto another row's key. Naming the same relation in both `tables` and `views` is refused outright — the two loops share one store map, so the view store would have replaced the writable one while realtime and the queue stayed wired to the orphan.

  This matters more than a convenience: a view is how a join reaches a store at all. `records` is keyed on a primary key and realtime writes the flat `postgres_changes` payload into it, so an embedded child collection is dropped by the first event after a fetch. A view is flat, so it survives.

  `createViewStore()` is **deprecated** in favour of `views:`. A store built standalone cannot reach the factory's shared persistence, auth gate, queue or cleanup, and its `ViewStore<Row>` type hides `resolveFetchOptions`/`retainQuery`/`releaseQuery` — all three of which `useQuery` calls — so it cannot be read with the hook the rest of the library is built around. Factory view stores are typed `TableStore<Row, never, never>` instead: read-only through the `never` argument, whole through everything else.
- **Structured errors**: new `AnchorError extends Error` carrying `code`, `details`, `hint` and `status`, plus `fromSupabaseError()` to build one from whatever a supabase-js call returned in `error`. Exported alongside the four constants worth branching on: `PG_INSUFFICIENT_PRIVILEGE` (`42501`), `PG_UNIQUE_VIOLATION` (`23505`), `PG_FOREIGN_KEY_VIOLATION` (`23503`), `PGRST_NO_ROWS` (`PGRST116`). Every boundary on the store read/write path now returns or throws one: both `executeQuery` paths and `executeQueryOne`, all six store mutations (`insert`, `insertMany`, `update`, `upsert`, `remove`, `removeWhere`), the offline queue's replay pipeline, `callRpc`, and the auth store. Previously all of them did `new Error(error.message)`, so a write refused by an RLS policy and a write refused by a unique constraint were indistinguishable without reading English prose written for a log file. `AnchorError` is an `Error` and `TableStoreState.error` keeps its `Error | null` type, so this is additive: no consumer catch, `instanceof` check or `.message` read changes.
- **`isRlsError` reads the code**: it had no access to one, and instead substring-matched the literal text `"42501"` inside the message. It now reads the structured code first and keeps the message arms as a fallback, for errors a consumer caught straight from supabase-js without passing through this package.

`docs/supabase-api-coverage.md` lists which boundaries were routed and which still return a bare `Error` — Storage, Edge Functions, batch operations, incremental sync and the auth *callback* helpers are not on the store path and are the next slice.

## [2.0.0] - 2026-08-11

Bumps `@supabase/supabase-js` 2.108.2 → 2.112.3 across `core` and `adapter-react-native`. Verified via a direct source diff of all six lockstep packages (`supabase-js`, `auth-js`, `postgrest-js`, `realtime-js`, `storage-js`, `functions-js`) — see `docs/supabase-api-coverage.md` for the full investigation and gap inventory.

### Breaking changes

- **Peer dependency floor raised**: `@supabase/supabase-js` peer range `>=2.0.0` → `>=2.111.0` in `core` and `adapter-react-native` (the true feature minimum: `postgres_changes` filter builder + `select` are 2.109.0, PKCE `flowId` is 2.111.0). The old `>=2.0.0` was already inaccurate — `fromTable()`'s `.schema()` call needs `>=2.39`.
- **`engines.node` raised to `>=22`** on `core`, `adapter-web`, and `adapter-react-native` (previously `>=18` on the workspace root only), matching supabase-js 2.112's own floor. supabase-js prints a runtime deprecation warning on Node ≤20.
- **`@drakkar.software/anchor-adapter-web`/`-react-native` peer on `@drakkar.software/anchor`**: `>=1.0.0` → `>=2.0.0`.

None of the above require code changes in consumers — only environment/lockfile updates.

### Features

- **Realtime column projection**: `select?: string[]` on `RealtimeManager.subscribe()`, `bindRealtimeToStore()`, and the `realtime` option in both `CreateTableStoreOptions` and `CreateSupabaseStoresOptions.tableOptions` (realtime-js 2.109.0's server-side column projection). Throws if `select` omits the table's primary key — `records`/`order` are keyed on it, and `onInsert`/`onUpdate` had no guard against a missing key.
- **Typed realtime filters**: `realtime.filter` now also accepts a `FilterDescriptor[]` (Anchor's own filter DSL), converted internally to a `RealtimePostgresFilterBuilder` via realtime-js 2.109.0's `postgresChangesFilter()`. Previously `filter` was a raw PostgREST string with no path in from `FilterDescriptor` at all. Supports `eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`like`/`ilike`/`is`/`in`; other operators (including `match`, which means something different in PostgREST vs. Realtime) are rejected rather than silently dropped or misinterpreted.
- **Multi-flow PKCE**: `createSessionFromUrl` and `adapter-react-native`'s `createExpoOAuthHandler` now forward `sb_flow_id` (parsed from the callback URL/deep link) to `exchangeCodeForSession(code, { flowId })`, so two concurrent PKCE flows (e.g. two OAuth providers started in different tabs) no longer clobber each other's verifier (auth-js 2.111.0). Requires the client that started the flow to set `appendPkceFlowIdToRedirects: true`.
- **`authGate`'s `TOKEN_REFRESHED` handler now re-authenticates realtime**: previously a no-op; private/RLS-checked realtime channels now get `supabase.realtime.setAuth()` on token refresh instead of running under a stale token until reconnect.

### Documentation

- `docs/supabase-api-coverage.md` — new: a coverage matrix of the full supabase-js surface vs. what Anchor wires, for scoping future work.
- All `createClient` snippets (root, `core`, `adapter-web`, `adapter-react-native` READMEs and `examples/todo-app`) updated for Supabase's new `sb_publishable_`/`sb_secret_` API key format, with a note that Edge Functions no longer accept a new-format key as `Authorization: Bearer` (must read `apikey`, or the call must carry a real user JWT).
- `adapter-react-native` README: added the canonical Supabase-RN `createClient` auth block (`storage: AsyncStorage, autoRefreshToken, persistSession, detectSessionInUrl: false`) — previously undocumented and easy to miss, since Anchor's `AsyncStorageAdapter` covers table persistence only, not auth session storage.

## [1.5.0] - 2026-06-22

### Features

- **Declarative redirects for `useAuthCallback`**: new optional `routes` and `redirect` options on `UseAuthCallbackOptions`. Set `routes: { recovery: '/settings/security', default: '/home' }` and the hook automatically navigates after the session is established — no hand-written `onSuccess` type-switch needed. `redirect` defaults to `window.location.replace` on web; pass your router's `replace`/`push` on native. Navigation fires after `onSuccess` (if provided) so analytics/state updates run first.
- **`resolveAuthRedirect(type, routes)`** — new exported pure helper that resolves a destination path from an `AuthCallbackRoutes` map. Returns the type-specific route, then `routes.default`, then `null`. Reusable with `verifyRecoveryOTP` or any custom auth flow.
- **`AuthCallbackRoutes`** — new exported type for the route map (`recovery`, `signup`, `magiclink`, `email`, `email_change`, `invite`, `default`, plus index signature for custom types).

Fully backward-compatible: omitting both new options reproduces the existing `onSuccess`-only behavior.

## [1.4.1] / [1.2.1] / [1.3.1] - 2026-06-22

### Maintenance

- Bump devDependencies across all packages: `zustand` → 5.0.14, `@supabase/supabase-js` → 2.108.2, `typescript` → 6.0.3, `vitest` → 4.1.9, `react` + `@types/react` → 19.2.x, `@types/node` → 26.0.0
- Add `vitest` as a devDependency of `adapter-react-native` and fix `expoOAuth.test.ts` to match the current `createExpoOAuthHandler(supabase, Linking, options?)` API (Linking was made an explicit parameter in v1.3.0)
- Exclude test files from `adapter-react-native` tsconfig (consistent with `core`)

## [1.4.0] - 2026-06-22

### Features

- **Auth callback utilities** (`@drakkar.software/anchor/auth/callbacks` or main entry):
  - `parseAuthCallbackUrl(url)` — pure URL parser; extracts `accessToken`, `refreshToken`, `code`, `type`, `error`, `errorDescription` from both implicit-flow hash fragments and PKCE query params
  - `hasAuthCallbackParams(url)` — quick check whether a URL contains Supabase auth params (useful to detect root-URL legacy redirects)
  - `createSessionFromUrl(supabase, url)` — establishes a session from a callback URL; handles implicit flow (`setSession`) and PKCE flow (`exchangeCodeForSession`); returns `{ session, type }` or `null` if no auth params are present; throws on errors
  - `getWebAuthRedirectTo(path?)` — builds the auth redirect URL from `window.location.origin` (web-only); defaults to `origin/auth-callback`
  - `sendPasswordRecovery(supabase, email, options?)` — thin wrapper around `resetPasswordForEmail` with typed return (`{ error }`)
  - `verifyRecoveryOTP(supabase, email, otp)` — verifies a 6-digit OTP code from a recovery email (`verifyOtp({ type: 'recovery' })`); returns `{ session, error }`
  - New types: `AuthCallbackType`, `ParsedAuthCallback`, `AuthCallbackResult`

- **`useAuthCallback(supabase, authStore, options)` hook** (main entry + `@drakkar.software/anchor/hooks`):
  - One-shot React hook that processes a Supabase auth callback URL and establishes a session
  - Platform-agnostic: caller provides `getUrl` (e.g. `() => window.location.href` on web; `() => url` from `expo-linking`'s `useURL()` on native)
  - Updates anchor auth store via `setState`; fires `onSuccess(result)` or `onError(error)` once
  - Returns `{ isProcessing, error }`
  - New types: `UseAuthCallbackOptions`, `UseAuthCallbackResult`

## [1.3.4] - 2026-04-13

### Bug Fixes

- **Fix `staleTime` not working across page navigation**: `useLinkedQuery` stored `lastFetchedAt` in a React ref (resets on unmount) and `data` in `useState` (also resets). Back-navigation always triggered a refetch even when data was fresh. Fixed by adding a module-level `queryCache` Map and a new `queryKey` option — when provided, timestamp and data survive unmount so the staleTime guard works correctly across remounts.

## [1.3.3] - 2026-04-13

### Features

- **`staleTime` option for `useLinkedQuery()`**: Skip mount/dep-change refetches when data is fresh (fetched within `staleTime` ms). `isLoading` stays `false` while existing data is served — stale-while-revalidate without a skeleton flash. Defaults to `0` (always refetch, existing behavior). Refetches driven by a linked store mutation always bypass this guard to keep optimistic updates reactive.

## [1.3.2] - 2026-04-13

### Bug Fixes

- **Fix all stores refetching on sign-in**: `createSupabaseStores` now accepts an `authGate` option (`clearOnSignOut`, `refetchOnSignIn`) forwarded to the internal auth gate — previously both defaulted to `true` with no way to override, causing all table stores to fetch on session restore

## [1.3.1] - 2026-04-09

### Bug Fixes

- **Fix `mergeToStore` infinite refetch loop**: `useLinkedQuery` now suppresses its own store subscription during `mergeToStore` writes — prevents the hook from detecting its own write as an external mutation and re-fetching in an infinite loop

## [1.3.0] - 2026-04-09

### Linked Query Enhancements

- **`initialData` option for `useLinkedQuery()`**: Seed query data from a store lookup or static value — avoids loading flash when navigating from list to detail views. Accepts a value or `() => T | undefined` getter, resolved once on mount. The network fetch still fires in the background (stale-while-revalidate).
- **`mergeToStore` option for `useLinkedQuery()`**: Write query results back into a table store via `mergeRecords()` — enables list queries to populate the store so detail queries can use `initialData` from it. Only merges when the result is an array. Respects pending mutation protection.

## [1.2.0] - 2026-04-08

### Query Cache Strategy

- **Configurable `cacheStrategy` option**: Controls how `fetch()` handles existing records — `"replace"` (default, existing behavior) replaces all records on each fetch; `"merge"` accumulates records across fetches while `order` reflects only the latest query results
- **Store-level and per-fetch configuration**: Set `cacheStrategy` on `CreateTableStoreOptions` for a store-wide default, or override per call via `FetchOptions.cacheStrategy`
- **`clearAndFetch()` action**: Atomically clears accumulated cache and re-fetches with forced replace strategy — the "invalidate" escape hatch for merge-mode stores
- **`CacheStrategy` type export**: Available from the main package entry point
- **`ViewStore` support**: `clearAndFetch` and `cacheStrategy` available on view stores

### CI & Build Fixes

- **Fix adapter-react-native DTS build**: Add `@types/node` dev dependency and `"types": ["node"]` to tsconfig for DTS generation
- **Fix CI pnpm version conflict**: Remove explicit `version: 10` from `pnpm/action-setup` in workflow — reads from `packageManager` field in `package.json` instead

## [1.1.3] - 2026-04-08

### Security

- **Auth gate cleanup on sign-out**: Auth gate now clears realtime channels and offline queue when user signs out, preventing cross-user data leaks
- **User-attributed offline queue**: Offline queue supports `userId` attribution to prevent cross-user mutation leaks after sign-out/sign-in

### Features

- **`withRetry()` utility**: Exponential backoff with jitter for RPC, Edge Functions, and Storage operations
- **JWT custom claims**: Auth store exposes `getClaim()` helper for parsing custom JWT claims
- **RPC result caching**: TTL-based cache with in-flight request deduplication for RPC calls
- **`useInfiniteQuery()` hook**: Cursor-based infinite scroll with load-more support
- **Conflict audit `userId`**: Conflict audit log supports user attribution and filtering

### Utilities

- **`CircuitBreaker`**: Closed/open/half-open state machine for failing endpoints
- **`RateLimiter`**: Token bucket algorithm for request throttling
- **`RealtimeManager.pause()`**: Manual subscription pausing
- **`aggregateLocal()`**: Client-side sum/avg/min/max/count on store data
- **`aggregateRpc()`**: Server-side aggregation via Postgres functions

## [1.1.2] - 2026-04-07

### Linked Queries

- **`useLinkedQuery()` hook**: Custom async query that auto-refetches when linked store(s) mutate — bridges custom Supabase queries (joins, complex selects) with optimistic store updates

## [1.1.1] - 2026-04-07

### Performance

- **Stale-while-revalidate fetch**: `fetch()` no longer sets `isLoading: true` when the store already has cached data — hydrated/persisted records display instantly while a background refresh happens
- **In-flight fetch deduplication**: When multiple components call `fetch()` on the same store simultaneously, only one network request fires — subsequent calls return the same in-flight promise
- **Configurable staleTime**: `useQuery` accepts `staleTime` option (default 5s) — skips fetching if the store was fetched within this window, preventing redundant requests across page navigations

## [1.1.0] - 2026-04-07

### App Lifecycle Management

- **`AppLifecycleAdapter` interface**: Platform-agnostic foreground/background detection
- **`setupAppLifecycle()`**: Wires lifecycle events to store operations — auto-flushes offline queue, refreshes auth session, revalidates stale data on foreground; pauses/resumes realtime subscriptions on background
- **`useAppLifecycle()` hook**: React hook wrapping `setupAppLifecycle` with cleanup
- **`WebAppLifecycle`**: Web adapter using Page Visibility API (`document.visibilitychange`)
- **`RNAppLifecycle`**: React Native adapter using `AppState` API

### Background Sync

- **`BackgroundTaskAdapter` interface**: Platform-agnostic background task registration
- **`setupBackgroundSync()`**: Registers a background task to flush the offline mutation queue when the app is backgrounded
- **`RNBackgroundSync`**: React Native adapter using `expo-task-manager` and `expo-background-fetch`

### OAuth / Deep Link Helpers

- **`createExpoOAuthHandler()`**: Expo/React Native OAuth handler with deep link URL construction, PKCE code exchange, and implicit flow support via `expo-linking`

### Data Encryption at Rest

- **`EncryptedAdapter`**: Transparent encryption wrapper for any `PersistenceAdapter` — encrypts values on write, decrypts on read
- **`createWebCryptoEncryption()`**: AES-GCM encryption using Web Crypto API

### Storage Quota Management

- **`StorageQuotaManager`**: Monitor storage usage (`getUsage`), set per-table record limits (`setTableLimit` / `enforceLimit`), evict oldest entries (`evictByCount`)
- **`useStorageQuota()` hook**: Reactive storage usage monitoring with auto-refresh

### Selective / Partial Sync

- **`selectiveSync()`**: Incremental sync with user-defined filter criteria
- **`syncAllByPriority()`**: Fetch multiple stores in priority order (lower number = higher priority)
- **`fetchPage()`**: Convenience wrapper for cursor-based pagination
- **`incrementalSync` filters**: Added optional `filters` parameter to `IncrementalSyncOptions`

### Multi-Device Sync

- **`setupMultiDeviceSync()`**: Sync store state across devices via Supabase Realtime broadcast channel with delta-only broadcasts, per-table debouncing, conflict resolution, and pending mutation protection

### Sync Health Monitoring

- **`SyncMetrics`**: `SyncLogger` implementation that tracks fetch/mutation counts, latencies (p50/p95/p99), error rates, queue flush counts, conflict counts, and realtime event counts with cached percentile computation
- **`useSyncMetrics()` hook**: Reactive metrics snapshot via subscription

### Conflict Audit Trail

- **`ConflictAuditLog`**: Records conflict resolution events with table, row ID, strategy, local/remote/resolved values; filterable by table and timestamp
- **`useConflictNotifications()` hook**: Reactive conflict notification list with dismiss/clear
- **`resolveConflict()` audit integration**: Optional `auditLog` parameter logs all conflict resolutions

### Schema Version + Cache Invalidation

- **`checkSchemaVersion()`**: Detects schema version mismatch and clears stale cached data, letting `fetch()` repopulate from Supabase
- **`getSchemaVersion()` / `setSchemaVersion()`**: Read/write the stored schema version

### Optimistic UI Helpers

- **`useSyncStatus()` hook**: Aggregates sync status across multiple stores — returns `pendingCount`, `isSyncing`, `lastSyncedAt`, `failedCount`, and `status` (`synced` | `syncing` | `offline` | `error`)
- **`computeSyncStatus()`**: Pure function version for non-React usage
- **`useQueueStatus()` hook**: Per-store pending count and queue size
- **`usePendingChanges()` hook**: Array of pending rows with mutation type (`insert` | `update` | `delete`)

### Build & Packaging

- **CJS + ESM dual format**: All 3 packages now output both CommonJS and ESM bundles
- **9 new entry points**: `./lifecycle`, `./sync/background`, `./sync/selective`, `./sync/multiDevice`, `./sync/metrics`, `./persistence/encrypted`, `./persistence/quota`, `./persistence/schemaVersion`, `./mutation/audit`

### Testing

- 340 tests across 39 test files (up from 198 tests in 26 files)

## [1.0.0] - 2026-04-07

### Core

- **Store-per-table architecture**: Auto-generate typed Zustand stores from Supabase Database schema via `createTableStore()` and `createSupabaseStores()`
- **Normalized state**: Records stored as `Map<PK, TrackedRow>` with separate `order` array preserving query ordering
- **Full TypeScript support**: End-to-end type safety from Database schema to store actions — `TableRow`, `TableInsert`, `TableUpdate` extracted automatically
- **Middleware composition**: `immer` -> `devtools` -> `subscribeWithSelector` middleware chain with opt-in per feature
- **Store extensions**: `extend()` callback for adding computed values and custom actions to any store
- **View mode**: `isView: true` disables all mutations, ideal for read-only dashboards

### Offline-First

- **Persistent offline queue**: FIFO mutation queue with automatic persistence, coalescing (INSERT+UPDATE -> INSERT, INSERT+DELETE -> remove both), and `dependsOn` dependency enforcement
- **Exponential backoff with jitter**: Failed mutations retry with configurable backoff (`retryBaseDelay`, `maxRetries`)
- **Optimistic mutations**: All mutations (insert, insertMany, update, upsert, remove) apply optimistically with snapshot-based rollback
- **Compare-and-swap rollback**: `_anchor_mutationId` on optimistic rows ensures rollback only reverts the originating mutation, not concurrent writes
- **Fetch generation counter**: Stale fetch responses are automatically discarded when a newer fetch is in progress
- **Pending mutation protection**: External data merges (realtime, cross-tab, fetch, incremental sync) never overwrite rows with `_anchor_pending` metadata
- **Temp ID resolution**: Temporary client-generated IDs are resolved to server IDs after INSERT, with mappings persisted across flushes for dependent mutations
- **Network-aware auto-flush**: Queue automatically flushes when network comes online via `NetworkStatusAdapter`

### Realtime

- **Realtime subscriptions**: `RealtimeManager` manages Supabase `postgres_changes` channel lifecycle with status tracking
- **Store bindings**: `bindRealtimeToStore()` wires INSERT/UPDATE/DELETE events to store state with pending mutation protection
- **Conflict resolution**: Configurable strategies — `server-wins`, `client-wins`, `last-write-wins`, `field-merge`, `custom`
- **ConflictContext**: Custom resolvers receive table, primary key, and actual pending mutations from the offline queue

### Persistence

- **Platform-agnostic adapters**: `PersistenceAdapter` interface with `MemoryAdapter` (core), `LocalStorageAdapter` (web), `IndexedDBAdapter` (web), and React Native adapters
- **Debounced writes**: Persistence writes are debounced (100ms) to avoid excessive serialization during rapid mutations
- **Auto-hydration**: Stores automatically hydrate from persistence on creation with `isHydrated` / `isRestoring` status tracking
- **Error surfacing**: Persistence failures are surfaced to the store's `error` state

### Sync

- **Cross-tab synchronization**: `BroadcastChannel` with `localStorage` fallback for multi-tab state sync
- **Auth session isolation**: Cross-tab sync supports `sessionId` to prevent data leaking between tabs with different users
- **Hydration guard**: Cross-tab messages are ignored while a store is hydrating from persistence
- **Incremental sync**: Delta sync via `updated_at > lastSyncAt` with NULL timestamp handling and conflict resolution support
- **Stale-while-revalidate**: `fetchWithSwr()` returns cached data immediately while fetching fresh data in background
- **Auto-revalidation**: `setupAutoRevalidation()` with configurable TTL intervals

### Query

- **Filter DSL**: Type-safe `eq()`, `neq()`, `gt()`, `gte()`, `lt()`, `lte()`, `like()`, `ilike()`, `is()`, `in()`, `contains()`, `overlaps()`, `textSearch()`, `match()`, `not()`, `or()`, `filter()`
- **Fluent query builder**: `query<T>().where('col').eq(val).orderBy('col').limit(n).build()`
- **Cursor-based pagination**: `buildCursorQuery()` + `processCursorResults()` for keyset pagination
- **Schema support**: `fromTable()` helper enables non-public schema queries
- **Fetch truncation warning**: Logs warning when Supabase's default row limit truncates results

### Mutations

- **Batch operations**: `updateMany()` and `removeMany()` with optimistic apply and CAS rollback
- **Validation**: `validate.insert` / `validate.update` callbacks with `zodValidator()` helper for schema validation
- **Composite key utilities**: `encodeKey()` / `buildPkFilter()` / `applyPkFilters()` for multi-column primary keys

### Auth

- **Auth store**: `createAuthStore()` with `signIn`, `signUp`, `signOut`, `signInWithOAuth`, `refreshSession`
- **Auth gate**: `setupAuthGate()` clears stores on sign-out, refetches on sign-in, with `isRlsError()` detection

### React Hooks

- **`useQuery`**: Declarative data fetching with auto-refetch on filter/sort/deps changes and configurable polling
- **`useSuspenseQuery`**: React Suspense-compatible hook with 30s cache timeout safety
- **`useRealtime`**: Manages subscription lifecycle with proper filter change resubscription
- **`useAuth`**: Auth state and actions with stable memoized references
- **`useOptimistic`**: Selector for pending/optimistic records
- **`useStorage`**: Supabase Storage operations (upload, download, list, remove)
- **`useRpc`**: Postgres RPC calls with loading/error state

### Server

- **RSC prefetch**: `prefetchTable()` for server-side data loading with `serializePrefetchResult()` / `deserializePrefetchResult()`

### Supabase Features

- **Storage**: `createStorageActions()` for upload, download, getPublicUrl, createSignedUrl, list, remove
- **Edge Functions**: `invokeEdgeFunction()` and `createEdgeFunctionAction()`
- **RPC**: `callRpc()` and `createRpcAction()`

### Platform Adapters

- **`@drakkar.software/anchor-adapter-web`**: `LocalStorageAdapter`, `IndexedDBAdapter`, `WebNetworkStatus`
- **`@drakkar.software/anchor-adapter-react-native`**: `AsyncStorageAdapter`, `ExpoSQLiteAdapter`, `RNNetworkStatus`

### Developer Experience

- **Redux DevTools**: Opt-in DevTools integration via `devtools` option
- **SyncLogger**: Pluggable logging interface with `consoleLogger` and `noopLogger` presets
- **Tree-shakeable**: 16 entry points with conditional exports for minimal bundle size

### Testing

- 198 tests across 26 test files
- Mock Supabase client for unit testing
- `MemoryAdapter` for persistence testing
- Tests for cross-tab sync (hydration guard, auth isolation, pending row preservation)
- Tests for fetch exception recovery and persistence debouncing
