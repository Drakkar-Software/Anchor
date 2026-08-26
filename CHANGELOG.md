# Changelog

## [Unreleased]

### Added

- **`docs/llms.md`**: a full API reference written for an LLM generating Anchor code
  rather than a human reading prose, covering every export, subpath entry point, option
  shape, and behavioral invariant, sourced directly from `packages/*/src` rather than
  from the README. Docs-only; no library code changes.

## [3.3.0] - 2026-08-26

### Added

- **Composite primary key support**: `createTableStore`'s `primaryKey: string
  | string[]` no longer throws on an array — it now genuinely wires through
  the `encodeKey`/`buildPkFilter`/`applyPkFilters` utilities the error
  message itself pointed at, which existed, were exported, and were never
  called from anywhere in the store. A composite key is stored as a single
  JSON-encoded string (`encodeKey`'s own scheme), so `records`/`order` keep
  keying on one `string | number` exactly as a single-column table always
  has — nothing about the Map, persistence, or the query/select layer
  changes, and every single-column-PK call takes the same scalar branch as
  before (byte-identical behavior, not just API-compatible).

  `update`/`remove`/`fetchOne`/`setRecord`/`removeRecord` widen from
  `id: string | number` to a new exported `PrimaryKeyValue = string | number
  | Record<string, unknown>` — a composite-key table's caller can pass
  either the pre-encoded key or the plain `{ column: value, ... }` object it
  likely already has (the row itself, or its primary-key columns), rather
  than importing `encodeKey` at every call site.

  `insert`/`insertMany`/`upsert` require every PK column present in the
  payload for a composite-key table, with no optimistic temp-id minting —
  every composite-PK table in practice is a join table whose columns are
  all client-supplied foreign keys, so there is no server-generated id to
  stand in for. `subscribe()` and `createSupabaseStores`'s
  `tableOptions[x].realtime` both now throw for a composite-key table:
  `bindRealtimeToStore`/`RealtimeManager` are single-column only, and
  failing loudly beats silently binding the wrong (first) column.

### Fixed

- **`setupMultiDeviceSync`'s `ConflictContext.primaryKey` was hardcoded to
  `{ id }`, regardless of a table's actual configured primary key.** Any
  table's store built with a non-`id` `primaryKey` got a wrong conflict
  context from multi-device sync, silently — found while auditing every
  `primaryKey`-shaped call site for the composite-key work above, unrelated
  to composite keys itself (the bug already existed for any single non-`id`
  column). Fixed by a new `MultiDeviceSyncOptions.primaryKeys?:
  Record<string, string | string[]>`, defaulting a table not listed to
  `"id"` — this function's only behavior before the option existed, so
  nothing changes for a caller that doesn't set it.

## [3.2.1] - 2026-08-26

### Changed

- **Bumped `@supabase/supabase-js` to `^2.112.4`** (core's dependency, and the
  react-native adapter's dev dependency used for its test suite) to pick up
  upstream fixes. No API changes on Anchor's side.

## [3.2.0] - 2026-08-26

Three gaps found while migrating a real clinical app onto Anchor's store/queue
layer — a persistence-namespacing option the bulk factory never exposed, an
upsert option a no-`update`-grant join table cannot be wired without, and a
default that would have silently deleted unsynced data. Additive; nothing
existing changes behaviour.

### Added

- **`createSupabaseStores`'s `persistence.keyPrefix`**, prepended to every
  table/view's own default key (`anchor:${schema}:${table}`, computed by
  `createTableStore`). The bulk factory only ever forwarded `.adapter`, with
  no way to namespace a shared adapter at all — a caller wanting one
  (multi-tenant namespacing, key rotation) had to reach below
  `createSupabaseStores` and hand-wrap the adapter itself.

- **`UpsertOptions.ignoreDuplicates`**, wired both live (`store.upsert()`) and
  on the queued replay (`executeRemoteMutation`). This is the one option a
  join table granted only `select, insert, delete` — no `update` — needs to
  be upserted through a store at all: without it, `ON CONFLICT DO UPDATE`
  is refused `42501` even on a conflict that would not actually change
  anything, because Postgres checks UPDATE privilege for that clause
  whether or not one occurs. Because `DO NOTHING` returns no row on a real
  conflict, `upsert` reads back with `.maybeSingle()` rather than
  `.single()` when this is set, and resolves a `null`/no-error response to
  the store's own already-merged optimistic row (cleared of its pending
  flag) instead of throwing `PGRST116` and rolling back — or, on the
  replay, stalling the queue at its first failure for a write the server
  had already confirmed.

### Changed

- **Documented, not defaulted: `offlineQueue.maxRetries` is 3, and past it a
  mutation is `rolled_back` — deleted from local state, not merely
  abandoned.** That default is reasonable for a todo app and was silently
  the wrong one for a consumer syncing data that must never quietly
  disappear across a multi-hour or multi-day offline stretch. Nothing in
  the library changes here — this is a docblock addition
  (`CreateSupabaseStoresOptions.offlineQueue`, and the README's
  Offline-First section) so the next consumer with that requirement sets it
  explicitly rather than discovering the default by losing data.

### Fixed

- **`docs/supabase-api-coverage.md` and the React Native adapter README had
  drifted from source.** `RealtimeManager.resume()` and `TableStore.
  subscribe()`/`.unsubscribe()` were both documented as unfixed gaps that
  had, in fact, already been fixed; the auth-methods count and "missing"
  list predated the 3.1.0 free functions (`getUser`, `updateUser`,
  `resendOtp`) and `verifyOtp`'s generalisation off the hardcoded
  `type: "recovery"`; `getVerifiedClaims()` was documented as calling
  `getClaims()` in one place and as never called in another. Separately,
  `ExpoSqliteAdapter`, `AsyncStorageAdapter`, `RNNetworkStatus` and
  `createExpoOAuthHandler` were all documented with a no-argument
  constructor call when every one of them takes its underlying platform
  module as an argument, and `useInfiniteQuery`'s own README example called
  it as `useInfiniteQuery(store, options)` returning `hasNextPage`/
  `fetchNextPage`, when the real signature takes the Supabase client
  directly (bypassing the store entirely) and returns `hasMore`/`loadMore`.

## [3.1.0] - 2026-08-16

Anchor can now create the client, and covers the auth calls that live outside
the session. Both exist for the same reason: a consumer could depend on Anchor
for its entire data layer and still had to name `@supabase/supabase-js` in its
own `package.json` — for the `createClient` call, for the `SupabaseClient` type
it then passed back in, and for the six `supabase.auth.*` methods the auth store
does not wrap. So "nothing outside the data layer talks to supabase-js directly"
was a rule no project could actually keep.

Additive. Nothing existing changes behaviour, and the one packaging change is
the point of the release.

### Added

- **`createAnchorClient(url, key, options?)`** and the **`AnchorClient<DB>`**
  type, from the root or `@drakkar.software/anchor/client`. The options object
  is supabase-js's own, forwarded untouched — a platform `auth.storage`,
  `detectSessionInUrl` for an app handling its own callback, `autoRefreshToken`
  are settings supabase-js defines, and anything reshaped here would be a second
  place to keep them right.

  `AnchorClient<DB>` is a plain alias of `SupabaseClient<DB>`, deliberately not
  a wrapper: `.from()`, `.auth`, `.rpc()` and `.storage` keep supabase-js's own
  generics, so a `Database` type still reaches per-table row inference. A facade
  would mean restating postgrest-js's builder generics — four of them as of
  2.112 (`PostgrestQueryBuilder<ClientOptions, Schema, Table, TableName>`), an
  arity that has changed between minor versions.

- **The supabase-js types a consumer would otherwise import for itself**, re-exported
  as types: `SupabaseClient`, `SupabaseClientOptions`, `Session`, `User`,
  `AuthChangeEvent`, `AuthError`, `PostgrestError`. Types only, matching how
  `errors.ts` already duck-types rather than reaching for `instanceof
  PostgrestError` — nothing here is meant to be constructed or
  `instanceof`-checked, and `AnchorError.code` remains the way to branch.

- **Six headless auth functions** in `auth/authActions.ts`, from the root or
  `@drakkar.software/anchor/auth/actions`: `getSession`, `getUser`,
  `signUpWithPassword`, `signInWithPassword`, `updateUser` and `resendOtp`.
  Free functions taking the client first, like `callRpc` and `verifyOtp`, none
  throwing, each wrapping its failure with `fromSupabaseError` so a caller can
  branch on `.code`.

  Each returns `AnchorError | null` rather than `Error | null`, so `code` is on
  the declared type and not only on the runtime value — a caller branching on
  `invalid_credentials` or `weak_password` gets there without a cast, which is
  the whole point of having wrapped the error at all.

  `createAuthStore` owns the session and the five actions that change who is
  signed in. These are the flows *around* it: confirming a sign-up, resending a
  code, changing a password, or reading the current user from a function with no
  React in sight. Two overlap the store on purpose — `signInWithPassword` is the
  re-authentication step in front of a destructive account change, where the
  point is to verify the current password without disturbing store state, and
  `getUser`/`getSession` are for code with no store to read.

  `signUpWithPassword` reads `error` before `data`, because supabase-js
  populates `data` with a null pair on failure and a confirmation-pending
  sign-up is *also* a null session — reading `data` first makes a refusal
  indistinguishable from the one success case a caller is meant to treat as
  success.

### Changed

- **`@supabase/supabase-js` moved from `peerDependencies` to `dependencies`**
  (`^2.112.3`). A peer would still have to be installed by the consumer, which
  is precisely the coupling the additions above exist to remove. `zustand` stays
  a peer; `react` and `immer` stay optional. Installs that already had
  supabase-js are unaffected — the version range it was pinned at is the range
  it is pinned at now.

## [3.0.0] - 2026-08-13

First slice of the work towards full parity with the pinned
`@supabase/supabase-js` (2.112.3). This release is not the parity work itself —
it is the test infrastructure that makes the parity work falsifiable, plus
twelve defects in features that already shipped. The parity surface (PostgREST
operators, auth, storage, realtime, the unified cache) lands in later versions.

**Why a major.** Two changes below alter behaviour that existing code depends
on, and neither errors when it changes: `nullsFirst` stops being forced to
`false`, so DESC ordering over a nullable column follows PostgREST's own NULLS
FIRST default and silently reorders rows; and `store.subscribe()` stops being a
no-op, so code that called it now opens realtime channels. Both are detailed
under **Changed — breaking**.

The **Testing** section changes no library behaviour: it is the infrastructure
the rest of the work lands against, and it went first because the infrastructure
that existed could not fail. The **Fixed** section is defects in features that
already shipped — none is a missing feature; each is a path that did the wrong
thing.

### Added

- **`verifyOtp(supabase, params)`** verifies any OTP flow, not only a password
  recovery one. `verifyRecoveryOTP` hardcodes `type: "recovery"` — correctly, it
  is named for it — and was the only path in, so email confirmation after
  `signup`, an `invite`, a `magiclink`, an `email_change`, an SMS `sms` or
  `phone_change` code, and the `token_hash` form a callback link carries were all
  unreachable. `verifyRecoveryOTP` keeps its signature and now delegates to it.

- **`authStore.getVerifiedClaims()`**, which verifies against the project's JWKS
  via `supabase.auth.getClaims()` — a method that has shipped in the pinned SDK
  all along and was never called. `getClaim` reads an unverified local base64
  decode of the access token, and its docstring claimed "no crypto verification
  — Supabase handles that", which is true of the token's use on the server and
  irrelevant to a client parsing a string it already holds. `getClaim` is
  unchanged and still right for deciding what to render; the docstring now says
  what it does.

- **`RealtimeManager.resume()`**, which `pause()`'s docstring has promised since
  it was written and which did not exist. `pauseRealtimeOnBackground` was
  therefore a one-way door: an app that backgrounded once stayed disconnected
  until relaunch.

- **`SyncLogger.realtimeError?(table, status, error?)`** (optional, so existing
  loggers keep compiling), carrying the `err` argument `subscribe()` passes and
  Anchor dropped.

### Changed — breaking

- **`nullsFirst` is no longer forced to `false`.** `applySort` passed
  `nullsFirst: s.nullsFirst ?? false` unconditionally. That is neither
  PostgREST's default nor Postgres': `NULLS LAST` is the default for ASC, but
  **`NULLS FIRST` is the default for DESC**. So every descending sort over a
  nullable column put nulls at the bottom — silently different from the same
  query run against the database, and enough to change which rows a `limit`
  keeps. It is now passed through only when you name it, and postgrest-js omits
  the token entirely when it is `undefined`. **If you relied on the old
  behaviour, pass `nullsFirst: false` explicitly.**

- **`store.subscribe()` and `store.unsubscribe()` do something.** They were
  permanent no-op stubs returning `() => {}`, which silently made
  `hooks/useRealtime.ts`'s subscribe path and `appLifecycle`'s
  `pauseRealtimeOnBackground` do nothing while reporting success — realtime only
  ever worked declaratively, through
  `createSupabaseStores({realtime: {enabled: true}})`. `subscribe()` now binds
  the store to the shared `RealtimeManager` and returns a real cleanup; calling
  it twice replaces the first subscription rather than orphaning a channel.
  **Code that called `subscribe()` "harmlessly" now opens a channel.** On a
  standalone `createTableStore` — which has no shared manager — it throws with
  the reason rather than returning a no-op, and it refuses on a view, because
  Postgres publishes changes under the underlying table's name and a channel on
  a view never fires.

### Fixed

- **Eight build entries had no `exports` subpath and were unreachable.**
  `exports` is an allowlist, so `import { prefetch } from
  '@drakkar.software/anchor/server'` threw `ERR_PACKAGE_PATH_NOT_EXPORTED`
  however complete `dist/` was. Four of the eight were documented — three in
  README's "Tree-Shakeable Imports" section and one in `prefetch.ts`'s own
  docstring. Now exported: `query/queryBuilder`, `query/pagination`, `auth/gate`,
  `functions`, `storage` (+ `storage/storageActions`), `server`
  (+ `server/prefetch`), `cache`, `sync/incremental`.

- **`TIMED_OUT` no longer reports as `"connecting"`.** It fell into the default
  arm of the status map, and since no further status follows a timeout, a
  channel that had given up looked like one still handshaking — permanently.

- **`pause()` no longer leaves a channel to be removed twice.** It removed the
  channel and left the entry in `subscriptions`, so a later `destroy()` — which
  the auth gate fires on `SIGNED_OUT` — called `removeChannel` on a channel that
  was already gone. `pause()` also now tells the store it disconnected instead
  of changing its own field and notifying nobody.

- **`getPublicUrl` no longer throws.** storage-js builds the URL from the project
  URL, bucket and path — it makes no request and has no error channel — so the
  `if (!data.publicUrl) throw` guarded a state nothing can produce. It was a real
  hazard regardless: `hooks/useStorage.ts`'s `getUrl` does not catch, so the
  throw escaped into render. The signature is unchanged.

- **Edge Function errors keep their class and their response.**
  `new Error(error.message)` collapsed `FunctionsHttpError`,
  `FunctionsRelayError` and `FunctionsFetchError` into one — the distinction
  between a function that ran and returned non-2xx, a relay that could not route
  to it, and one never reached at all, which is what decides whether retrying is
  sensible. It also discarded `FunctionsHttpError.context`, the `Response`
  carrying the real HTTP status and the body the function wrote; `error.message`
  on an HTTP error is only ever the generic "Edge Function returned a non-2xx
  status code", so the diagnosis lived entirely in what was thrown away. The
  body is read through `clone()`, so a caller reaching for the raw response
  still finds it unread.

- **`AnchorError` now reaches the last modules still raising bare `Error`s:**
  `storage/storageActions`, `functions/edgeFunctions`, `mutation/batchOperations`,
  `sync/incrementalSync`, `server/prefetch`, `query/aggregation` and
  `auth/authCallbacks`. A caller can branch on `23505`, `23503`, `42501` or
  `PGRST116` from a batch update, a prefetch or an aggregate, not only from a
  single-row store write.

- **`useAuth` no longer reads the session twice and races itself.** It called
  `initialize()` — a `getSession()` round-trip — and registered a listener that
  supabase-js answers with `INITIAL_SESSION` carrying the same session. Both
  wrote `isLoading: false`, so whichever settled last won, and the later one
  could be the staler: a `SIGNED_OUT` arriving mid-flight (the ordinary end of a
  long offline session, once a refresh token fails to renew) was overwritten by
  the session the in-flight `getSession()` had already resolved with. The hook
  now subscribes before it reads, and `initialize()` defers to a listener that
  has already spoken instead of overwriting it.

- **A hand-built `{op: "match"}` filter is evaluated locally.** It fell through
  `matchRow`'s default arm and included every row, so a local read showed rows
  the server would not have returned. The `match()` helper deliberately still
  expands to N `eq` descriptors — PostgREST's own `.match()` is the same sugar,
  and `eq` is what `matchRow` can judge against a row it already holds.

### Testing

- **The mock stopped agreeing with a store that ignores the filter.**
  `src/__tests__/mockSupabase.ts` accepted `contains`, `containedBy`, `overlaps`
  and `textSearch` into its filter list and had no case for any of them, so its
  `default: return true` matched every row; `not()`, `or()` and `filter()`
  recorded nothing at all. `update` and `delete` honoured only `eq` and treated
  every other filter as a match, so a delete carrying a `gt` emptied the table.
  All are implemented, one predicate now serves reads and writes alike, and the
  `default` arm throws rather than passing an operator it does not know.

  Implementing them broke no existing test, which is the more uncomfortable half
  of the finding: in 657 tests, none had ever driven one of these operators
  through the mock.

- **The mock gained what the next releases need to be testable at all:**
  `.schema(name)` (every schema-scoped store previously threw `TypeError`),
  `_setError(table, op, error, {status, once})` for failure paths — with an
  explicit `status`, because `isTransportError` only classifies a failure as
  never-having-reached-Postgres at `status: 0` — `status`/`statusText` on every
  response, `PGRST116` on a write whose `.single()` got nothing back, and a
  `channel()` that records bindings and can be driven with
  `_fireEvent`/`_fireStatus`/`send`/`track`/`presenceState`.

- **`like`/`ilike` are anchored in the mock**, as SQL `LIKE` is. The previous
  translation produced an unanchored regex, so `like('abc')` matched `xabcx`.

- **React hooks can be tested.** All 18 files in `src/hooks/` had no tests
  because the runner is `environment: "node"` with no DOM and no `react-dom` —
  a hook could not be mounted. jsdom, `react-dom` and `@testing-library/react`
  are now dev dependencies, and hook tests opt into jsdom per file rather than
  changing the default for the other 56 files. `useQuery` has 8 tests.

- **The adapter packages run their tests.** Neither defined a `test` script, so
  `packages/adapter-react-native/src/expoOAuth.test.ts` had never executed, in
  CI or locally — it passes. `packages/adapter-web` had no tests at all and now
  covers `LocalStorageAdapter`, including that `clear()` removes only
  `anchor:`-prefixed keys and leaves a session token alone.

## [2.2.3] - 2026-08-13

Two more on the queue path, found by reading 2.2.1 and 2.2.2 back. The first is
the same shape as the bug 2.2.2 fixed: work that is queued, retained, and then
never started, because the trigger that would have started it was dropped.

### Fixed

- **A write enqueued during a flush is no longer stranded.** `flush()` declines
  when one is already running, and the request was discarded rather than
  remembered. The running flush cannot do that work: it filters `pending` before
  its first `await`, so a mutation enqueued mid-flight is in neither batch. Since
  2.2.1 only two other things start a drain — a connectivity transition and an
  auth event — and a signed-in device sitting on wifi produces neither, so the
  write waited for a relaunch. A declined flush is now re-armed when the running
  one finishes, and only if the queue is still dirty and no retry timer is
  already pending, so an exponential backoff is not replaced by the debounce.

- **Coalescing no longer merges two users' writes to the same row.** `compact()`
  keyed on `table` and primary key alone, while `flush()` filters on `userId` —
  so the isolation the filter provides was defeated one line earlier.
  `UPDATE + UPDATE` merges the newer payload into the *older* mutation, which
  keeps the older mutation's `userId`: user B's edit went out under user A's
  session, or waited indefinitely for an A who never signed back in on that
  device. `INSERT + DELETE` dropped both. The key now carries the user, and an
  untagged mutation keys separately from a tagged one because nothing says they
  are the same person.

## [2.2.2] - 2026-08-13

### Fixed

- **A queue hydrated at boot is drained without waiting for a network
  transition.** 2.2.1 made a tagged mutation wait for its own user and released
  it on `SIGNED_IN`/`INITIAL_SESSION` — but reading the queue off disk and
  supabase-js recovering a stored session are both in flight from the factory,
  and either can finish second. When the auth event won that race the queue was
  still empty, the release checked `isDirty` against nothing, and the mutations
  landed a moment later with no remaining trigger: `startAutoFlush` only
  *subscribes* to connectivity, so a device that never leaves wifi has no
  transition to ride. `hydrate()` now schedules a flush of its own when it
  finds work, so whichever of the two finishes second starts the drain. It was
  reachable only in 2.2.1, where the permissive filter that used to drain the
  queue under no user at all had just been removed.

## [2.2.1] - 2026-08-13

Three fixes on the write path 2.2.0 opened, found by reading that release
against its first real consumer. Each is on a path that had no test.

### Fixed

- **A signed-out queue no longer replays its writes as `anon`.** `flush()`
  skipped a mutation belonging to a *different* user and ran every mutation when
  there was no current user at all: the filter's middle arm was
  `!this.currentUserId`. That is the state the auth gate creates on
  `SIGNED_OUT` — which supabase-js emits by itself once a refresh token fails to
  renew, the ordinary way a long offline session ends. The queued writes went
  out with no JWT, RLS refused them `42501`, and a refusal is correctly not
  retried as transport, so each was rolled back and discarded. 2.2.0's headline
  behaviour change, not clearing the queue on sign-out, only holds with this:
  the writes it stopped deleting were being destroyed one HTTP round trip later.
  A tagged mutation now waits for its own user; untagged ones still flush for
  anyone, which is what an `auth: false` deployment needs.

  Because waiting needs an end, `setupAuthGate` schedules a flush on `SIGNED_IN`
  and `INITIAL_SESSION` when the queue is dirty. `startAutoFlush` only reacts to
  a connectivity *transition*, so a queue that hydrated at boot, or that was held
  while signed out, would otherwise sit untouched until the network happened to
  change state.

- **An abandoned write no longer resurrects a row the store has let go.**
  `onRollback` restored `rollbackSnapshot` whenever the record was absent.
  Absent means two different things: for a `DELETE` it is the optimistic state
  and restoring is exactly the undo, but for an `INSERT`, `UPSERT` or `UPDATE` it
  means the optimistic row is already gone — cleared at sign-out, dropped by a
  `replace` refetch — and there is nothing left to undo. `setRecord` re-adds the
  id to `records` *and* `order` and persists it, so a previous user's row came
  back to the screen and to disk minutes after `clearAll()` removed it, and a
  `merge` cache then kept it through the next user's fetch. The guard reads the
  operation now.

- **`crypto.randomUUID()` is guarded everywhere it is called.** Four sites called
  it bare — the mutation ids in `update` and `upsert`, a queued mutation's id,
  and `batchOperations` — while `createTempId` had guarded it since it was
  written. Hermes ships no WebCrypto, and `crypto.randomUUID` is equally absent
  from plain HTTP in a browser, so on a device without a polyfill the whole write
  path threw `crypto.randomUUID is not a function` before any of the offline
  machinery could run. All of them go through one `randomId()` now, with the
  fallback `createTempId` already had.

## [2.2.0] - 2026-08-12

### Features

- **`upsert` can name its conflict target**: `upsert(row, { onConflict })`, reachable through `useMutation` too. Without it PostgREST conflicts on the primary key, so a table whose "one of these per day" rule lives in a different unique constraint could not be upserted through a store at all: the statement inserted a duplicate and Postgres raised `23505`, which reads as a duplicate-key bug in the caller rather than as a missing option. `onConflict` takes the constraint's columns as one comma-separated string, the way supabase-js does.

  `QueuedMutation` carries an optional `upsertOptions` and `executeRemoteMutation` applies it, so the replay path writes the row the live call would have rather than falling back to the primary-key default — a divergence that would show up **only after a reconnect**. The field is optional, so a queue persisted by 2.1.0 rehydrates unchanged.

  **`ignoreDuplicates` is deliberately not supported.** Every store mutation ends its chain in `.single()`, and a `DO NOTHING` that ignored a conflict returns no representation — so the store would report a write the server performed exactly as asked as a `PGRST116` failure and roll the optimistic row off the screen, and on the replay path `executeRemoteMutation` would throw and stall every pending mutation behind it. It needs `.maybeSingle()` and a "server accepted, wrote nothing" resolution path, which is a feature rather than a keyword.

- **A write that cannot reach the server can now be queued instead of lost**: `createSupabaseStores({ offlineQueue: { queueWrites: true } })`. This is what finally feeds the mutation queue. Until now `OfflineQueue.enqueue()` had no caller anywhere in the package: the queue hydrated, auto-flushed, persisted across launches and held an executor per table, while every mutator went straight to Supabase and threw when it could not be reached. The queue was reachable, configured and empty by construction.

  With it on, `insert`, `update`, `upsert` and `remove` enqueue in two cases — the `NetworkStatusAdapter` reports offline before the call, or the call fails in transit — and resolve with the optimistic row rather than throwing. Each queued mutation carries a `dependsOn` pointing at the last one still queued for the same row, so a drain replays two writes to one record in the order they were made, and a `rollbackSnapshot`, so an abandoned write can be undone.

  **It is opt-in and stays opt-in, because it changes what a failed write means.** Off, a write that cannot reach the server rejects: the caller's `catch` fires and the optimistic row disappears. On, that same write resolves, and a consumer that treats a resolved promise as "the server has it" will now say so for a write that has only been queued. The distinction moved onto the row: `_anchor_pending` is set on what the mutator returns, and it is the only thing that tells the two apart.

  Two mutators deliberately do not queue, and keep rolling back and throwing. `insertMany` is one statement the server accepts or rejects whole, and `QueuedMutation` addresses a single row, so queuing it would mean N independent inserts and a drain that can half-succeed. `removeWhere` matches rows locally with a matcher that assumes a match for every operator beyond `eq`/`neq` — conservative enough for an optimistic hide the server corrects a moment later, and not a safe basis for a replay that would delete rows the server's own filter would have spared.

  A row that already has a write queued keeps queuing **even while online**, because the queue flushes on a debounce: a direct write would reach Postgres first and then be overwritten seconds later by the older payload the drain replays, leaving the server holding the edit the user had already replaced. `dependsOn` orders two queued writes; this is what stops a write escaping the ordering altogether.

  Two limitations are documented rather than papered over. **Delivery is at-least-once**: a request whose response was lost looks exactly like one that never arrived (`status: 0` in both cases), so a committed write can be replayed — make queued writes idempotent, which for this library means an `upsert` naming a real unique constraint rather than a bare `insert`. An aborted request, including a caller's own `AbortSignal`, lands in the same bucket. And **`remove` has no queued/sent signal**, since it resolves to `void` and the row is already gone; `getQueueSize()` and `usePendingChanges()` are what a caller reads instead.

  New: `isTransportError(error, status)` is exported, `SyncLogger` gains an optional `mutationQueued`, and `maxRetries`/`flushDebounceMs` reach the shared queue from the factory's `offlineQueue` option — there was previously nothing in it to configure.

### Behaviour change

**Signing out no longer discards the offline queue.** `setupAuthGate` called `offlineQueue.clearQueue()` on `SIGNED_OUT`, to prevent "orphaned mutations executing under the wrong user" — which is already prevented by `enqueue` tagging each mutation with `userId` and `flush` filtering on the current one, without throwing anything away. Harmless while nothing could enqueue; destructive the moment `queueWrites` existed, because supabase-js emits `SIGNED_OUT` by itself when a refresh token finally fails to renew, which is precisely how a long offline session ends. Every unsent write would be dropped from memory and from disk without running, with no error, no `onRollback` and no trace — and the pre-edit server state waiting at the next sign-in. The stores are still cleared; `clearQueue()` remains public for a caller who does want it.

### Bug fixes

- **`upsert` skipped its optimistic apply whenever the payload carried no primary key.** The id was read off the row and everything downstream sat behind `if (optimisticId)`, so an upsert identified by a *constraint* rather than by a key the caller holds — which is exactly what `onConflict` is reached for — put nothing on screen until the server answered.

  The store now resolves the row three ways, in order: the primary key on the payload; failing that, the record already held whose `onConflict` columns all match, which is the row the server is about to overwrite; failing that, a temp id, as `insert` already mints, swapped for the server's own on confirmation. The middle step is what keeps a list showing one entry: attaching the write to a new temp row instead would render today's record twice, with two different values, for the whole round trip — and on failure the rollback would remove the new one and leave the stale one, reading as a silent revert. Local matching follows `ON CONFLICT`'s own rules, so a null in a conflict column matches nothing (Postgres defaults to NULLS DISTINCT). No temp id is ever sent, on either the live or the replay path.
- **`dependsOn` could strand a mutation in the queue permanently**, in two ways, neither reachable before `queueWrites` gave the field its first producer. A dependency that *succeeded* was pruned at the end of its flush while `succeededIds` — the only record that it had — went out of scope with it, so a dependent that did not run in the same pass (its turn came after another mutation failed and broke the loop, or it failed once and was retried) was skipped on every flush thereafter. And `compact()`'s `UPDATE + DELETE` rule replaces the update with the delete while keeping the delete's id, so the delete was left depending on the mutation it had just replaced. Both present as `pendingCount` never reaching zero, with no error and no rollback. Success now releases its dependents, and coalescing repoints `dependsOn` at whatever absorbed the removed mutation.
- **`OfflineQueue`'s `onRollback` was never wired by `createSupabaseStores`.** A mutation that exhausts `maxRetries` is marked `rolled_back` and pruned, and that callback is the only remaining chance to undo what the optimistic apply did — so a write the server had refused for good stayed on screen, still flagged pending, with nothing left in the queue to explain it. Harmless while nothing could enqueue; the first thing `queueWrites` would have broken. The factory now restores `rollbackSnapshot`, or removes the row when there was none to restore, and logs the abandonment through `mutationError` — nothing else reported it, and a deleted row reappearing in a list minutes later should not be the first anyone hears of it.

  It undoes **only a row that is still optimistic**, which is this path's equivalent of the compare-and-swap every rollback inside `createTableStore` already performs. Minutes can pass before the queue gives up, and a realtime event, a refetch or a cross-tab merge can leave a confirmed server row at that id; restoring over it would replace a value the server holds with an older one, and the removal branch would delete a row the mutation never created.
- **A queued `UPSERT`'s temp id was never resolved.** An upsert identified by `onConflict` carries no primary key, so the store mints a `_temp:` id for it exactly as `insert` does — but the queue registered temp-id resolutions for `INSERT` only. Any later queued write to that row therefore replayed `.eq(id, '_temp:…')` against a uuid column, failing on every flush and never draining.
- **A replayed `UPDATE` could leave its row in `records` but not in `order`.** The confirm path only touched `order` when the id changed, and every projection walks `order` — so the row was held and unreachable until a full fetch rebuilt it. Newly reachable now that a queued write can outlive a `clearAll()`. The same missing push is fixed in the live `update` path, where an update to a row the store had not fetched produced it.
- **`code: ""` now reads as no code.** postgrest-js writes an empty string on every failure Postgres never saw, and `fromSupabaseError` copied it through, so `err.code` was a falsy-but-present string that no `if (err.code)` and no `switch` handled the way a missing code is handled. It maps to `undefined`.
- **Confirming an upsert could leave the same id twice in `order`.** When the server's id was already present — the store held the row but could not match it locally, because the conflict columns are outside `defaultSelect` — the temp slot was overwritten with that id rather than removed, so `order` carried it twice against one `records` entry. Every projection reads `order`, so the row rendered twice with duplicate React keys, the duplicate was persisted to disk, and it healed only on the next full fetch of that table.

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
- **`queryFn` was handed a builder with nothing but `select` applied.** `executeQuery` returned from that branch before the filters and pagination block, while `fetch` went on computing all of it, merging the store's `defaultFilters` in, and keying the query on it. So a fetch carrying both a `queryFn` and filters ran unfiltered, and a store scoped to one user's rows was scoped only for the fetches that did not use the escape hatch. Filters, `select`, `limit` and `offset` now all reach the builder before the callback sees it.

  **`sort` deliberately does not.** `order` is the one PostgREST parameter that accumulates rather than overwrites — `limit`/`range` overwrite, and filters compose as AND — so pre-applying the store's sort would silently demote a `queryFn`'s own `.order()` from being the query's ordering to a tiebreaker behind `defaultSort`, and ordering through a referenced table is one of the gaps the escape hatch exists for. Ordering is the callback's, in that branch only.

### Features

- **Views can be wired through `createSupabaseStores`**: new `views:` and `viewOptions:` options, plus `ViewNames` / `ViewRow` type extractors. A generated Supabase `Database` keeps views in their own `Views` block, and nothing in the package read it — `TableNames` extracts from `Tables` only — so a view could only be a hand-built `createViewStore`, outside the shared persistence, auth gate and cleanup that the factory sets up. A view store now gets all of that, minus the two things that cannot apply to it: no offline-queue *executor*, since it is not writable, and **no realtime subscription**, since Postgres publishes changes under the underlying *table's* name and a channel on a view's name would register and never fire. A view whose freshness matters needs a refetch trigger of its own. It does hold the shared queue, so `getQueueSize()` reports a real 0 rather than a hardcoded one and `flushQueue()` flushes; nothing can enqueue for it, because all four mutators throw.

  `viewOptions` accepts the five keys that mean something for a read-only store. Its `primaryKey` is a single column, unlike `tableOptions`', and setting it is worth doing on almost every view: a generated `Database` marks every view column nullable (Postgres infers no NOT NULL through one), so the default `"id"` is not safe to lean on, and a row that reaches the store without it now fails the fetch rather than collapsing onto another row's key. Naming the same relation in both `tables` and `views` is refused outright — the two loops share one store map, so the view store would have replaced the writable one while realtime and the queue stayed wired to the orphan.

  This matters more than a convenience: a view is how a join reaches a store at all. `records` is keyed on a primary key and realtime writes the flat `postgres_changes` payload into it, so an embedded child collection is dropped by the first event after a fetch. A view is flat, so it survives.

  `createViewStore()` is **deprecated** in favour of `views:`. A store built standalone cannot reach the factory's shared persistence, auth gate, queue or cleanup, and its `ViewStore<Row>` type hides `resolveFetchOptions`/`retainQuery`/`releaseQuery` — all three of which `useQuery` calls — so it cannot be read with the hook the rest of the library is built around. Factory view stores are typed `TableStore<Row, never, never>` instead: read-only through the `never` argument, whole through everything else.
- **Structured errors**: new `AnchorError extends Error` carrying `code`, `details`, `hint` and `status`, plus `fromSupabaseError()` to build one from whatever a supabase-js call returned in `error`. Exported alongside the four constants worth branching on: `PG_INSUFFICIENT_PRIVILEGE` (`42501`), `PG_UNIQUE_VIOLATION` (`23505`), `PG_FOREIGN_KEY_VIOLATION` (`23503`), `PGRST_NO_ROWS` (`PGRST116`). Every boundary on the store read/write path now returns or throws one: both `executeQuery` paths and `executeQueryOne`, all six store mutations (`insert`, `insertMany`, `update`, `upsert`, `remove`, `removeWhere`), the offline queue's replay pipeline, `callRpc`, and the auth store. Previously all of them did `new Error(error.message)`, so a write refused by an RLS policy and a write refused by a unique constraint were indistinguishable without reading English prose written for a log file. `AnchorError` is an `Error` and `TableStoreState.error` keeps its `Error | null` type, so this is additive: no consumer catch, `instanceof` check or `.message` read changes.
- **`isRlsError` reads the code**: it had no access to one, and instead substring-matched the literal text `"42501"` inside the message. It now reads the structured code first and keeps the message arms as a fallback, for errors a consumer caught straight from supabase-js without passing through this package.
- **`defaultQueryFn` on a store**, in `CreateTableStoreOptions` and in both `tableOptions` and `viewOptions`, for a source that always needs the escape hatch: a PostgREST modifier the filter DSL has no word for. It is applied to every fetch that does not pass its own `queryFn`, and unlike a per-call one it does not cost the store its per-query scoping — the function is the same for every query, so `filters`/`sort`/`select`/`limit`/`offset` still tell them apart and each keeps its own loading state, error and count. Filled in after the key is computed, for exactly that reason.

  It must not change the shape of a row, and the doc comment says so: only `fetch` goes through it, while `fetchOne` reads by primary key through its own builder and each of the six mutations reads its row back with `defaultSelect` — and all of them write into the same `records` map every query then projects. A function that widens the row would leave two shapes in one store, with the narrow one being whatever the user just created or opened by id. Row shape belongs to `defaultSelect`, which every one of those paths honours.
- **Typed RPC**: `FunctionNames`, `RpcArgs` and `RpcReturns` extractors — a generated `Database` types every function with an `Args` and a `Returns` block and none of it was read — plus `createSchemaRpc<DB>(supabase)`, which takes the function name from the schema and infers both sides:

  ```typescript
  const rpc = createSchemaRpc<Database>(supabase)
  const { data } = await rpc("record_consent", { p_kind: "care", p_granted: true })
  ```

  The argument object is **required** unless the schema says it can be left out — a function with required arguments called with none used to compile and then fail at runtime with `PGRST202`, which reads like a missing grant. Two shapes count as "can be left out": `Args: never`, which is what the generator emits for a zero-argument function, and an object all of whose properties are optional. Pass the schema as a second type argument for a `Database` with no `public` key: `createSchemaRpc<Database, "app">(supabase)`.

  `callRpc` and `useRpc` keep their signatures. Both take the return type as their first type argument, so making them generic over `DB` would bind `Database` where every existing `callRpc<Stats>(...)` means `Stats`.

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
