# Supabase JS API coverage

What of `@supabase/supabase-js` (pinned at 2.112.3, see `packages/core/package.json`) Anchor actually wires, and what it doesn't. Written during the 2.108.2 → 2.112.3 bump (see `CHANGELOG.md`) from a direct source diff of all six lockstep packages (`supabase-js`, `auth-js`, `postgrest-js`, `realtime-js`, `storage-js`, `functions-js`), not from the docs site — the docs sidebar omits several methods that exist in source (noted below).

This is a map for scoping future work, not a todo list. Most gaps are reasonable for a store-per-table library to not need; a few are flagged as genuinely worth closing.

## Database (postgrest-js)

### Filters

13 of Anchor's `FilterOperator` are fully wired end to end (helper in `query/filters.ts` → `ColumnFilter` in `queryBuilder.ts` → `applyFilters` in `queryExecutor.ts`): `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`, `contains`, `containedBy`, `overlaps`.

- `textSearch` is helper-only — no `ColumnFilter` builder method.
- **`match()` is a trap.** `query/filters.ts:127-138` returns an array of `op: "eq"` descriptors and never `op: "match"`, so the `case "match"` branch at `queryExecutor.ts:80` is unreachable via the public helper — it only fires on a hand-built descriptor.
- `not`, `or`, `filter` need hand-built descriptors with no exported helper. `or` ignores `column` entirely and takes a raw PostgREST string as `value`.

**Missing:** `rangeGt`, `rangeGte`, `rangeLt`, `rangeLte`, `rangeAdjacent`, `likeAllOf`, `likeAnyOf`, `ilikeAllOf`, `ilikeAnyOf`. Also four operators present in postgrest-js source but absent from the docs sidebar — easy to miss if you only check docs: **`regexMatch`, `regexIMatch`, `isDistinct`, `notIn`**.

### Modifiers

Wired: `select`, `select` with `{count}`, `order` (without `referencedTable`), `limit`, `range`.

**Missing:** `order`/`limit` with `referencedTable`, `csv`, `geojson`, `explain`, `rollback`, `returns`/`overrideTypes`, `abortSignal` (zero `AbortController` anywhere in the codebase), `setHeader`, `maxAffected`, `stripNulls`, `throwOnError`, `head`.

**`nullsFirst` divergence:** `queryExecutor.ts:110-113` forces `nullsFirst: s.nullsFirst ?? false` unconditionally. Raw PostgREST leaves it unset, which defaults to NULLS LAST for ASC but **NULLS FIRST for DESC** — so Anchor's DESC ordering differs from PostgREST's own default.

**The `queryFn` escape hatch is narrower than it looks.** `types.ts:131` / `queryExecutor.ts:128-145`: the callback receives a builder with `.select()` already applied, and the result is coerced to `{data: Row[], count, error}` via `r.data ?? []`. So `.single()`, `.maybeSingle()`, `.csv()`, `.geojson()` are callable through it but return shapes the store path cannot consume.

### Mutations

**No options object is passed at any mutation call site** — verified across `createTableStore.ts`, `mutationPipeline.ts`, `batchOperations.ts`. `onConflict`, `ignoreDuplicates`, `defaultToNull`, `count`, `returning: 'minimal'` are all unreachable. Upsert can only conflict-target the table's inferred PK/unique constraint.

## Storage (storage-js)

6 of ~25 methods wrapped in `storage/storageActions.ts`: `upload`, `download`, `list`, `remove`, `createSignedUrl`, `getPublicUrl`.

**Missing methods:** `move`, `copy`, `createSignedUrls` (plural), `createSignedUploadUrl`, `uploadToSignedUrl`, `update`, `info`, `exists`, `listV2` (cursor-based, returns `{hasNext, folders, objects, nextCursor}`), `toBase64`, and the entire **bucket-admin API** (`createBucket`, `getBucket`, `listBuckets` + its `ListBucketOptions` pagination, `updateBucket`, `deleteBucket`, `emptyBucket`, `BucketType`).

**Missing options on wrapped methods:** all `transform`/resize options (`width`, `height`, `resize`, `quality`, `format`) — `getPublicUrl` at `storageActions.ts:86` passes no options object at all, so even its own `download` flag is unreachable; the `duplex`/`metadata`/`headers` `FileOptions`; `download({cacheNonce})`; `destinationBucket` on `move`/`copy`; storage-level `setHeader`; the new `purgeCache`/`purgeBucketCache` (2.109.0, CDN purge).

**Entirely absent product surfaces:** Analytics (Iceberg) buckets (`StorageAnalyticsClient`) and Vector buckets (`StorageVectorsClient` — indexes, `putVectors`/`queryVectors`). Resumable/TUS uploads aren't in storage-js at all — that's `tus-js-client`/Uppy territory (6 MB chunks).

**Contract break:** `storageActions.ts:81-91` `getPublicUrl` **throws** where every sibling method returns `{data, error}`, and `hooks/useStorage.ts:76-79` doesn't catch it — the throw escapes into render/event code.

Deprecated `FileObject` fields worth not wiring: `last_accessed_at`, `bucket_id`, `owner`, `buckets`.

## Edge Functions (functions-js)

Wired in `functions/edgeFunctions.ts:26-30`: `body`, `headers`, `method` (`GET`/`POST`/`PUT`/`PATCH`/`DELETE` — omits `OPTIONS`).

**Missing:** `region` (the whole `FunctionRegion` enum), `signal`, the new `timeout` option, `functions.setAuth(token)`. `body` is narrowed to `Record<string, unknown>` so `File`/`Blob`/`ArrayBuffer`/`FormData`/`ReadableStream`/`string` bodies are lost. No streaming support — `FunctionsResponse`'s raw `response?: Response` is never read.

`edgeFunctions.ts:32-35` discards **`FunctionsHttpError.context`** — the `Response` carrying the function's real HTTP status and body — and collapses `FunctionsHttpError`/`FunctionsRelayError`/`FunctionsFetchError` into one bare `Error`.

Not a client gap, but worth documenting for anyone writing the function side: supabase-js ships a canonical CORS header export at `@supabase/supabase-js/cors`, updated in 2.112.3 to include the trace-context headers.

## RPC

No third options argument is ever passed to `.rpc()` (`rpc/rpcAction.ts:84`, `query/aggregation.ts:35`) → `head`, `get`, `count` are all unreachable. `.rpc()` is only ever called on the root client — **RPCs in non-public schemas are unreachable even from a schema-scoped store**. `types.ts` has no `Functions` extractor (only `Tables`/`Views`/`Enums`), so RPC args and returns are `as any` / `data as T`.

`aggregation.ts:27-38` builds RPC names by the convention `zs_{fn}_{table}_{column}`, requiring user-authored SQL functions, rather than using PostgREST's native aggregate select syntax (`count()`, `sum()`, `avg()` inline in `.select()`).

## Auth (auth-js)

### Methods — 12 of ~50 wired

Wired: `getSession`, `signInWithPassword`, `signUp`, `signOut`, `signInWithOAuth` (two implementations — `auth/authStore.ts` and `adapter-react-native/src/expoOAuth.ts`), `refreshSession`, `onAuthStateChange`, `setSession`, `exchangeCodeForSession` (now with `flowId`, see CHANGELOG), `resetPasswordForEmail`, `verifyOtp`.

**Missing:** `signInWithOtp` (so **magic-link sending is impossible** through Anchor — only password *recovery* email is wired), `signInWithIdToken` (native Google/Apple — a real gap for the RN adapter), `signInWithSSO`, `signInAnonymously`, `signInWithWeb3`, `getUser`, `getClaims`, `updateUser`, `reauthenticate`, `resend`, `getUserIdentities`/`linkIdentity`/`unlinkIdentity`, `startAutoRefresh`/`stopAutoRefresh` (so the canonical RN `AppState` pattern is absent — `lifecycle/appLifecycle.ts:71` calls `refreshSession()` manually on foreground instead), `signOut({scope})`.

`verifyOtp` hardcodes `type: "recovery"` (`auth/authCallbacks.ts:253`), so `signup`/`magiclink`/`email_change`/`invite`/`sms`/`phone_change`/`token_hash` OTP verification is unreachable.

Whole namespaces unwired: **`mfa.*`** (`enroll` for TOTP *and* phone *and* WebAuthn, `challenge`, `verify`, `challengeAndVerify`, `unenroll`, `listFactors`, `getAuthenticatorAssuranceLevel`, plus the experimental `mfa.webauthn`), **`auth.passkey.*`** and the `signInWithPasskey`/`registerPasskey` shortcuts, **`auth.oauth.*`** (OAuth 2.1 consent-page API), **`auth.admin.*`** (including the newer `admin.oauth`/`admin.passkey`).

Also unwired: **`dispose()`** (2.107.0) — tears down auto-refresh interval, `visibilitychange` listener, `BroadcastChannel`, and `onAuthStateChange` subscribers; built for React Strict Mode / HMR, directly relevant to a React library.

### Options dropped on methods Anchor does call

Just as significant as the missing methods, and cheaper to close:

- `signUp` is called with **no options object at all** (`auth/authStore.ts:89`) → no `emailRedirectTo`, `data` (user metadata), `captchaToken`, `channel`, no phone signup.
- `signInWithPassword` is email+password only → no phone, no `captchaToken`.
- `signInWithOAuth` forwards only `redirectTo` and **discards `data.url`** (`auth/authStore.ts:132`) → `skipBrowserRedirect`, `scopes`, `queryParams` unreachable; only `expoOAuth.ts:47` returns the URL.
- `resetPasswordForEmail` → no `captchaToken`.
- `refreshSession` → no explicit `{refresh_token}` argument.
- `updateUser`'s `currentPassword` (re-auth on password change) and the `custom:`-prefixed `Provider` form have no path in at all — `updateUser` isn't called.

### Events

Two independent `onAuthStateChange` subscriptions: `auth/authStore.ts:167` ignores the event name entirely (every event collapses to the same state write); `auth/authGate.ts` branches on `SIGNED_IN`, `SIGNED_OUT`, and (as of this bump) `TOKEN_REFRESHED`.

Never branched anywhere: `INITIAL_SESSION`, `USER_UPDATED`, `PASSWORD_RECOVERY` (recovery is instead routed off the URL `type` param), `MFA_CHALLENGE_VERIFIED`.

Redundancy at `hooks/useAuth.ts:34-35`: `initialize()` does a `getSession()` round-trip *and* registers a listener that immediately fires `INITIAL_SESSION` — a duplicate read plus two racing `isLoading: false` writes.

### `getClaim` vs `getClaims`

`AuthStore.getClaim` (`auth/authStore.ts:14-26`) is a **hand-rolled, unverified** local JWT decode — `atob` + `JSON.parse` on the payload segment, no signature check, `atob` assumed global — while `getClaims()`, which verifies via JWKS, exists in the pinned SDK and is never used. The docstring ("Supabase handles that") is misleading about what "handles" means here.

## Client options — none reachable

Anchor never calls `createClient`; the client is always injected. So **nothing** in `SupabaseClientOptions` is configurable through Anchor:

- `db.*`: `timeout`, `urlLengthLimit`, `retry` (`schema` is reachable indirectly via Anchor's own `schema` option → `.schema()`)
- `auth.*`: `flowType`, `storage`, `userStorage` (experimental — cookie-size relief), `autoRefreshToken`, `persistSession`, `detectSessionInUrl` (now also accepts a predicate function), `debug`, `storageKey`, `throwOnError`, `skipAutoInitialize` (SSR race control — relevant to `server/prefetch.ts`), `experimental.passkey`, and the deprecated `lock`/`lockAcquireTimeout`
- `realtime.*` (`RealtimeClientOptions`): `transport`, `timeout`, `heartbeatIntervalMs`, `heartbeatCallback`, `vsn`, `logger`, `logLevel`, `encode`/`decode`, `reconnectAfterMs`, `params` (incl. `eventsPerSecond`), `fetch`, `worker`/`workerUrl`, `accessToken`, `sessionStorage`, `disconnectOnEmptyChannelsAfterMs` (deferred disconnect, 2.105.0), and the deprecated `headers`
- `storage.useNewHostname`; `global.fetch`/`global.headers`; top-level `accessToken` (third-party auth — disables the `auth` namespace); `tracePropagation`

**Real footgun:** Anchor ships `AsyncStorageAdapter` for *table* persistence on React Native but never documented wiring `auth.storage` separately — the standard Supabase-RN `createClient` setup. Closed in this bump's README update (`packages/adapter-react-native/README.md`).

**Unused root exports.** Anchor imports only 4 types from `@supabase/supabase-js` (`SupabaseClient`, `Session`, `User`, `RealtimeChannel`) and zero values. Never used: the error classes (`PostgrestError`, `StorageApiError`, `FunctionsHttpError`/`FetchError`/`RelayError`/`FunctionsError`), `FunctionRegion`, and — most relevant for a typed library — the **`QueryData`/`QueryResult`/`QueryError`** type helpers that infer a query's result type from the builder. Anchor derives row types from its own `TableRow`/`TableInsert`/`TableUpdate` extractors instead, which is why `.select('a, b(c)')` embeds get no type inference.

## Realtime

As of this bump, `select` and `FilterDescriptor`-based filters are wired (see CHANGELOG) — presence and broadcast are not.

**Presence entirely unwired:** no `track`/`untrack`/`presenceState`/`.on('presence', sync|join|leave)`, no `presence.enabled`.

**Broadcast** exists only in `sync/multiDeviceSync.ts`, fire-and-forget with the `RealtimeChannelSendResponse` discarded and `subscribe()` called with no status callback, so failures are silent.

**Broadcast-from-database is entirely absent.** `RealtimeBroadcastPayload<T>` (`{id, schema, table, operation, record, old_record}`) is a distinct, unused payload shape from `RealtimePostgresChangesPayload<T>` — and it's the scaling path once `postgres_changes` hits its per-connection limits. This is the most likely *next* realtime feature worth wiring.

`supabase.channel()` is never passed an options argument, so `private: true` (RLS-checked channels), `broadcast.{self,ack,replay,replication_ready}`, and `presence.key` are all unreachable.

Also untouched: `httpSend()` (needs Realtime server ≥ v2.97.0), `.on('system')` + `RealtimeSystemPayload`, `copyBindings`, `updateJoinPayload`, `teardown`, `subscribe(cb, timeout)`/`unsubscribe(timeout)`, `getChannels()`, `removeAllChannels()`, and most of `supabase.realtime` itself (`connect`, `disconnect`, `sendHeartbeat`, `onHeartbeat`, `connectionState`, `isConnected` — only `setAuth()` is now called, on `TOKEN_REFRESHED`).

`realtime/realtimeManager.ts` maps unknown channel statuses to `"connecting"`, so `TIMED_OUT` reports as connecting forever; `subscribe()`'s second `err` callback argument is dropped.

## Error handling — the highest-leverage future refactor

Every boundary does `new Error(error.message)`, discarding `code`/`details`/`hint`/`status`: `query/queryExecutor.ts` (×3), `rpc/rpcAction.ts`, `functions/edgeFunctions.ts`, `storage/storageActions.ts` (×6), `mutation/mutationPipeline.ts` (×4), `mutation/batchOperations.ts` (×2), `sync/incrementalSync.ts`, `createTableStore.ts` (×9), all of `auth/authStore.ts`/`auth/authCallbacks.ts`.

Consequence: no consumer can branch on `23505` (unique violation), `23503` (FK violation), `PGRST116` (no rows), or `42501` (insufficient privilege) — and `auth/authGate.ts`'s `isRlsError` is forced to **substring-match the literal string `"42501"` inside the message text**, rather than reading a structured `code`.

Worth noting the upstream side of this refactor is now better supported than when Anchor's pattern was written: 2.112.0 added `code` to `StorageApiError`, and recent versions added `toJSON` to `FunctionsError`/`WebAuthnError`.

## Two pre-existing bugs (found, not fixed here)

- `realtime/realtimeManager.ts`'s `pause()` docstring promises a `resume()` method that does not exist anywhere in the codebase. `pause()` also leaves entries in `this.subscriptions` after removing their channels, so a later `destroy()` calls `removeChannel` on already-removed channels.
- `TableStore.subscribe()`/`.unsubscribe()` (`createTableStore.ts:844-848`) are permanent no-op stubs. This silently makes `hooks/useRealtime.ts`'s subscribe path and `lifecycle/appLifecycle.ts`'s `pauseRealtimeOnBackground` no-ops — real realtime wiring only happens via `createSupabaseStores()` → `bindRealtimeToStore()`.

## supabase-js v3 — forward-looking note only

`next` is `3.0.0-next.29`, published 2026-05-11, with **no prerelease in the three months since** while `latest` advanced to 2.112.3. The `v3` branch's `CHANGELOG.md` is behind `master`, and its `docs/MIGRATION.md` has no v3 section. Read as paused with no announced timeline — not something to plan around yet.

The large "⚠️ Breaking Changes" list attached to the `v3.0.0-next.0` release body is a **regenerated full-repo-history changelog**: every entry in it dates to 2020–2022 and belongs to the v1→v2 migration, not v3. Several third-party posts misreport these as v3 changes — worth knowing if this comes up in an issue or PR discussion.

The only three confirmed v3 changes: storage `exists()` no longer throws when a file is missing (returns falsy instead); postgrest errors become real `PostgrestError` **instances** rather than plain objects; `auth.lock`/`auth.lockAcquireTimeout` are removed. **None affects Anchor** — `exists()` isn't wired, error objects are discarded before any `instanceof` check, and Anchor never calls `createClient`.

Also worth knowing: a TypeScript 5.0+ floor lands in a minor release after 2027-01-31 (Anchor is on TS 6.0.3 — unaffected), and a new sibling package `@supabase/server` (public beta) targets Edge Functions/Workers.
