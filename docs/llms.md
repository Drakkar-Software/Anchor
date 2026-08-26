# Anchor, LLM reference

Machine-oriented reference for `@drakkar.software/anchor` (core, v3.3.0) and its two
adapter packages, `@drakkar.software/anchor-adapter-web` and
`@drakkar.software/anchor-adapter-react-native` (both v3.1.0). Written for a model
generating or reviewing Anchor code, not for a human onboarding: no narrative, no
marketing language, one fact per line, every claim sourced from `packages/*/src`.

Anchor binds Zustand vanilla stores to Supabase: one store per table, auto-typed from a
generated `Database` type, with optimistic mutations, an offline queue, realtime
subscriptions, and conflict resolution built in. It does not replace
`@supabase/supabase-js`; it wraps it. This document covers Anchor's own API surface only.

**Out of scope: Supabase itself.** For `@supabase/supabase-js` / PostgREST / GoTrue /
Realtime / Storage / Edge Functions semantics not reproduced here, use
<https://supabase.com/llms.txt>. `docs/supabase-api-coverage.md` in this repo maps what
Anchor wires versus what it doesn't, but is not repeated in this file.

Requirements: `zustand >= 4.5.0` (peer), `react >= 18` (optional peer, for hooks),
`immer` (optional peer, for draft-based mutations), Node >= 22, TypeScript >= 5
recommended. `@supabase/supabase-js` is a direct dependency of core since 3.1.0, it is
installed automatically and its types are re-exported from the root entry; a consumer
does not need to depend on it directly.

## Mental model

Five facts that determine whether generated code is correct:

1. **One Zustand *vanilla* `StoreApi` per table.** No Provider, no React context. Every
   hook's first argument is a store handle (`StoreApi<TableStore<Row, Insert, Update>>`)
   or, for a handful of hooks, a raw `SupabaseClient`. There is no `TableStoreApi` type;
   the handle is Zustand's own `StoreApi<...>`, imported from `zustand` if a type
   annotation is needed.

2. **`records: Map<string | number, TrackedRow<Row>>` and `order: (string | number)[]`
   must stay in sync.** `records` is normalized storage keyed by primary key; `order`
   preserves query ordering. Every internal write path updates both. A row is read by
   filtering `order` through `records`, not by iterating `records` directly (iteration
   order is insertion order, not query order).

3. **Optimistic tracking is three metadata fields on the row itself**:
   `_anchor_pending?: "insert" | "update" | "delete"`, `_anchor_optimistic?: boolean`,
   `_anchor_mutationId?: string`. Read them with `isPending(row)` and
   `getPendingStatus(row)`, not by checking the fields directly. A pending row is never
   overwritten by realtime, cross-tab sync, incremental sync, or a plain `fetch`.

4. **Per-query scoping.** `queries: Map<queryKey, QueryEntry>` on the store state holds
   `{ count, isLoading, error, lastFetchedAt }` per distinct combination of
   `filters`/`sort`/`select`/`limit`/`offset`. Two components reading the same table with
   different filters get independent loading/error/count. `useQuery` computes the key via
   `resolveFetchOptions` + `queryKey`; a fetch using a `queryFn` is unkeyable and falls
   back to the table-wide `isLoading`/`error`.

5. **`realtime`, `conflict`, `network`, and `offlineQueue` options only take effect via
   `createSupabaseStores()`.** Passed to standalone `createTableStore()`, each one
   triggers a `console.warn` and is otherwise ignored, no throw, so a misconfigured
   standalone store silently runs without the feature. Use `createSupabaseStores()`, or
   wire `RealtimeManager` + `bindRealtimeToStore` and `OfflineQueue` manually.

## Import map

`packages/core/package.json`'s `exports` field is an **allowlist**: importing a path not
listed throws `ERR_PACKAGE_PATH_NOT_EXPORTED` regardless of what `dist/` contains.

| Subpath | Primary exports |
|---|---|
| `@drakkar.software/anchor` (root) | Everything below, plus all hooks including `useInfiniteQuery` |
| `/hooks` | All hooks **except** `useInfiniteQuery` (root-only, see below) |
| `/client` | `createAnchorClient`, re-exported Supabase types |
| `/query` | Filter DSL (`eq`, `neq`, …), `executeQuery`, `queryKey`, `matchRow`, `selectRows`, `aggregateRpc`/`aggregateLocal` |
| `/query/queryBuilder` | `QueryBuilder`, `query()` |
| `/query/pagination` | `buildCursorQuery`, `processCursorResults`, `CursorPaginationOptions`, `PaginationState`, `CursorDirection` |
| `/auth` | `createAuthStore` |
| `/auth/callbacks` | `parseAuthCallbackUrl`, `createSessionFromUrl`, `verifyOtp`, `sendPasswordRecovery`, … |
| `/auth/gate` | `setupAuthGate`, `isRlsError`, `AuthGateOptions` |
| `/auth/actions` | `getSession`, `getUser`, `signUpWithPassword`, `signInWithPassword`, `updateUser`, `resendOtp` |
| `/functions` | `invokeEdgeFunction`, `createEdgeFunctionAction` |
| `/storage` (≡ `/storage/storageActions`) | `uploadFile`, `downloadFile`, `getPublicUrl`, `createSignedUrl`, `listFiles`, `removeFiles`, `createStorageActions` |
| `/server` (≡ `/server/prefetch`) | `prefetch`, `serializePrefetchResult`, `deserializePrefetchResult` |
| `/cache` | `isStale`, `isExpired`, `fetchWithSwr`, `setupAutoRevalidation` |
| `/realtime` | `RealtimeManager` |
| `/persistence` | `MemoryAdapter`, `PersistenceAdapter` type |
| `/persistence/encrypted` | `EncryptedAdapter`, `createWebCryptoEncryption` |
| `/persistence/quota` | `StorageQuotaManager` |
| `/persistence/schemaVersion` | `checkSchemaVersion`, `getSchemaVersion`, `setSchemaVersion` |
| `/rpc` | `callRpc`, `createRpcAction`, `createSchemaRpc`, `invalidateRpcCache` |
| `/sync` | `setupCrossTabSync`, `setupBroadcastSync`, `setupStorageFallback` |
| `/sync/incremental` | `incrementalSync`, `IncrementalSyncOptions` (subpath-only) |
| `/sync/selective` | `selectiveSync`, `syncAllByPriority`, `fetchPage` |
| `/sync/multiDevice` | `setupMultiDeviceSync` |
| `/sync/background` | `setupBackgroundSync`, `isBackgroundSyncRegistered` |
| `/sync/metrics` | `SyncMetrics` |
| `/lifecycle` | `setupAppLifecycle` |
| `/mutation/audit` | `ConflictAuditLog` |

Import from `@drakkar.software/anchor-adapter-web` and
`@drakkar.software/anchor-adapter-react-native` for platform adapters (no subpaths;
each package has a single flat entry point).

Facts a model gets wrong without being told explicitly:

- **`useInfiniteQuery` is exported only from the root** (`@drakkar.software/anchor`), not
  from `/hooks`. `packages/core/src/hooks/index.ts` does not re-export it.
- **Subpath-only types**, unreachable from the root: `AuthGateOptions` (`/auth/gate`),
  `IncrementalSyncOptions` (`/sync/incremental`), `CursorDirection` (`/query/pagination`).
- **Referenced in signatures but not exported anywhere**, write these inline rather than
  importing them: `UseQueryOptions`, `UseQueryResult`, `MutationResult`,
  `CreateAuthStoreOptions`, `OfflineQueueOptions`, `SubscribeOptions`,
  `BindRealtimeOptions`, `ColumnFilter`, `SyncableState`.
- There is **no `TableStoreApi`**. Use `import type { StoreApi } from "zustand"`.

## Setup

### Web

```typescript
import { createAnchorClient, createSupabaseStores } from '@drakkar.software/anchor'
import { LocalStorageAdapter, WebNetworkStatus, WebAppLifecycle } from '@drakkar.software/anchor-adapter-web'
import { setupAppLifecycle } from '@drakkar.software/anchor/lifecycle'
import type { Database } from './database.types'

const supabase = createAnchorClient<Database>(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_PUBLISHABLE_KEY!, // sb_publishable_... or legacy anon key
)

export const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos', 'profiles'],
  persistence: { adapter: new LocalStorageAdapter() },
  network: new WebNetworkStatus(),
  offlineQueue: { queueWrites: true },
  realtime: { enabled: true },
  devtools: process.env.NODE_ENV === 'development',
})

export const cleanupLifecycle = setupAppLifecycle({
  adapter: new WebAppLifecycle(),
  stores: [stores.todos, stores.profiles],
  authStore: stores.auth,
})
```

### React Native

Every RN adapter takes its native module as a constructor argument instead of importing
it internally, to avoid bundler resolution issues in pnpm virtual-store environments.

```typescript
import { createAnchorClient, createSupabaseStores } from '@drakkar.software/anchor'
import {
  ExpoSqliteAdapter, RNNetworkStatus, RNAppLifecycle, RNBackgroundSync,
  createExpoOAuthHandler,
} from '@drakkar.software/anchor-adapter-react-native'
import * as SQLite from 'expo-sqlite'
import NetInfo from '@react-native-community/netinfo'
import * as Linking from 'expo-linking'
import type { Database } from './database.types'

const supabase = createAnchorClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)

export const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos'],
  persistence: { adapter: new ExpoSqliteAdapter(SQLite) },
  network: new RNNetworkStatus(NetInfo),
  offlineQueue: { queueWrites: true },
  realtime: { enabled: true },
})

export const oauth = createExpoOAuthHandler(supabase, Linking)
```

## Store factories

### `createTableStore(options)`

```typescript
function createTableStore<DB, Row, InsertRow, UpdateRow, Extensions = Record<string, never>>(
  options: CreateTableStoreOptions<DB, Row, InsertRow, UpdateRow, Extensions>,
): StoreApi<TableStore<Row, InsertRow, UpdateRow> & Extensions>
```

`CreateTableStoreOptions` (verbatim shape, `packages/core/src/types.ts`):

```typescript
type CreateTableStoreOptions<DB, Row, InsertRow, UpdateRow, Extensions = Record<string, never>> = {
  supabase: SupabaseClient<DB>
  table: string
  schema?: string                              // default "public"
  primaryKey?: string | string[]               // default "id"; array form is a composite key, see Composite Primary Keys

  defaultFilters?: FilterDescriptor<Row>[]
  defaultSort?: SortDescriptor<Row>[]
  defaultSelect?: string
  /** Applied to every fetch without its own queryFn. Must not change row shape. */
  defaultQueryFn?: (builder: unknown) => unknown

  cacheStrategy?: CacheStrategy                // "replace" (default) | "merge"

  persistence?: { adapter: PersistenceAdapter; key?: string }  // key default: `anchor:${schema}:${table}`

  // Require createSupabaseStores(), console.warn and no-op otherwise:
  offlineQueue?: { enabled?: boolean; maxRetries?: number; flushDebounceMs?: number; queueWrites?: boolean }
  network?: NetworkStatusAdapter
  realtime?: {
    enabled?: boolean
    events?: RealtimeEvent[]                   // default ["*"]
    filter?: string | FilterDescriptor<Row>[]
    select?: string[]                          // server-side column projection; must include primaryKey
  }
  conflict?: ConflictConfig<Row>

  immer?: (config: any) => any                 // pass zustand/middleware/immer's `immer`
  devtools?: boolean | { name?: string }

  validate?: {
    insert?: (data: InsertRow) => true | string[]
    update?: (data: UpdateRow) => true | string[]
  }

  logger?: SyncLogger
  isView?: boolean                             // disables all mutators (they throw)
  crossTab?: { enabled?: boolean; name?: string; sessionId?: string }

  /** @internal set by createSupabaseStores */ _queue?: unknown
  /** @internal set by createSupabaseStores */ _realtimeManager?: unknown

  extend?: (
    set: StoreApi<TableStore<Row, InsertRow, UpdateRow>>["setState"],
    get: StoreApi<TableStore<Row, InsertRow, UpdateRow>>["getState"],
    store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
    supabase: SupabaseClient<DB>,
  ) => Extensions
}
```

Middleware order: `immer → devtools → subscribeWithSelector → storeCreator` (outermost
wraps first).

```typescript
const todosStore = createTableStore<Database, TodoRow, TodoInsert, TodoUpdate>({
  supabase,
  table: 'todos',
  defaultSort: [{ column: 'created_at', ascending: false }],
  persistence: { adapter: new LocalStorageAdapter() },
  devtools: true,
  crossTab: { enabled: true },
  validate: { insert: (data) => (data.title?.length > 0 ? true : ['Title required']) },
  extend: (set, get, store, supabase) => ({
    completedCount: () => [...get().records.values()].filter((t) => t.completed).length,
    toggleComplete: async (id: string) => {
      const current = get().records.get(id)
      if (current) await get().update(id, { completed: !current.completed })
    },
  }),
})
```

### `createSupabaseStores(options)`

```typescript
function createSupabaseStores<DB, SchemaName extends string & keyof DB = "public" & keyof DB>(
  options: CreateSupabaseStoresOptions<DB, SchemaName>,
): SupabaseStores<DB, SchemaName>
```

`CreateSupabaseStoresOptions`:

```typescript
type CreateSupabaseStoresOptions<DB, SchemaName = "public"> = {
  supabase: SupabaseClient<DB>
  schema?: SchemaName
  tables: TableNames<DB, SchemaName>[]
  views?: ViewNames<DB, SchemaName>[]          // read-only stores, see Views below

  persistence?: {
    adapter: PersistenceAdapter
    /** Prepended to every table/view's own `anchor:${schema}:${table}` key. */
    keyPrefix?: string
  }
  network?: NetworkStatusAdapter

  /**
   * Opt-in. Off: a write that cannot reach the server rolls back and rejects.
   * On: it resolves with the optimistic row and is retried later, check
   * `_anchor_pending` on the returned row, not promise resolution, to know
   * whether the server has it. Only insert/update/upsert/remove queue.
   */
  offlineQueue?: { queueWrites?: boolean; maxRetries?: number; flushDebounceMs?: number }  // maxRetries default 3

  realtime?: { enabled?: boolean }
  conflict?: ConflictConfig
  cacheStrategy?: CacheStrategy
  immer?: (config: any) => any
  devtools?: boolean
  logger?: SyncLogger

  tableOptions?: Partial<Record<TableNames<DB, SchemaName>, {
    primaryKey?: string | string[]
    defaultFilters?: FilterDescriptor[]
    defaultSort?: SortDescriptor[]
    defaultSelect?: string
    defaultQueryFn?: (builder: unknown) => unknown
    realtime?: { enabled?: boolean; events?: RealtimeEvent[]; filter?: string | FilterDescriptor[]; select?: string[] }
    conflict?: ConflictConfig
    cacheStrategy?: CacheStrategy
  }>>

  viewOptions?: Partial<Record<ViewNames<DB, SchemaName>, {
    primaryKey?: string                        // single column only, no composite for views
    defaultFilters?: FilterDescriptor[]
    defaultSort?: SortDescriptor[]
    defaultSelect?: string
    defaultQueryFn?: (builder: unknown) => unknown
    cacheStrategy?: CacheStrategy
  }>>

  tableOrder?: TableNames<DB, SchemaName>[]
  fetchRemoteOnBoot?: boolean

  auth?: boolean                               // default true
  authGate?: { clearOnSignOut?: boolean; refetchOnSignIn?: boolean }  // both default true
}
```

Return type `SupabaseStores<DB, SchemaName>`: one `StoreApi<TableStore<...>>` per table,
one `StoreApi<TableStore<ViewRow, never, never>>` per view, plus `auth`, `_supabase`, and
`_destroy(): void` (tears down all subscriptions).

```typescript
const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos', 'profiles', 'comments'],
  persistence: { adapter: new LocalStorageAdapter() },
  realtime: { enabled: true },
  tableOptions: {
    todos: { defaultSort: [{ column: 'created_at', ascending: false }] },
    profiles: { realtime: { enabled: false } },
  },
})

stores.todos.getState().insert({ title: 'Buy milk' })
stores._destroy()
```

Throws at setup time if a relation is named in both `tables` and `views`.

### Views

Name a view in `createSupabaseStores({ views: [...] })`, not with `createTableStore`
directly. A view store is a normal `TableStore` whose six mutators (`insert`,
`insertMany`, `update`, `upsert`, `remove`, `removeWhere`) throw, same persistence,
same auth gate, same per-query scoping, read with `useQuery` exactly like a table.

```typescript
const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos'],
  views: ['dashboard_stats'],
  viewOptions: {
    // Set primaryKey explicitly: a generated Database type marks every view
    // column nullable, so the default "id" is not safe to lean on, and a row
    // arriving without its key fails the fetch rather than collapsing onto
    // another row's record.
    dashboard_stats: { primaryKey: 'owner_id' },
  },
})
```

A view gets **no realtime subscription**: Postgres publishes `postgres_changes` under the
underlying table's name, never the view's, so a channel on the view's name registers and
never fires. `store.subscribe()` on a view throws. Refetch it manually (table events, app
foreground) when its freshness matters.

### `createViewStore(options)`, deprecated

Superseded by `views:` in `createSupabaseStores`. A standalone view store cannot reach a
shared persistence adapter, auth gate, offline queue, or cleanup, and its returned
`ViewStore<Row>` type hides `resolveFetchOptions`, `retainQuery`, and `releaseQuery`,
which `useQuery` calls internally, so a store built this way **cannot be read with
`useQuery`**.

## Store state and actions

```typescript
type TableStoreState<Row> = {
  records: Map<string | number, TrackedRow<Row>>
  order: (string | number)[]
  queries: Map<string, QueryEntry>            // keyed by queryKey(); see Query layer
  isLoading: boolean                          // table-wide: whichever query fetched last
  error: Error | null
  isHydrated: boolean
  isRestoring: boolean                        // true while restoring from persistence
  lastFetchedAt: number | null
  realtimeStatus: "disconnected" | "connecting" | "connected" | "error"
}

type QueryEntry = {
  count: number | null                        // set only when `count` was requested
  isLoading: boolean                          // this query, not the table
  error: Error | null
  lastFetchedAt: number | null                // what staleTime/isStale gate on, per query
}
```

`TableStoreActions<Row, InsertRow, UpdateRow>`, one line each:

| Action | Behavior |
|---|---|
| `fetch(options?)` | Fetches from Supabase; `TrackedRow<Row>[]`. Deduplicates concurrent identical-key fetches; stale responses from a superseded fetch are discarded via a generation counter. |
| `fetchOne(id)` | Fetch a single row by primary key; `null` if not found. |
| `refetch()` | Replays every **retained** live query (`useQuery` retains on mount), not just the last-fetched one. |
| `resolveFetchOptions(options?)` | Options `fetch` would actually use, with `defaultFilters`/`defaultSort`/`defaultSelect` merged in. Needed to compute the same `queryKey` a caller wants to read; `useQuery` uses it internally. |
| `retainQuery(options?)` / `releaseQuery(options?)` | Refcounted mount/unmount registration so `refetch()` knows which queries are on screen. React 18 double-invoked effects are harmless since it is refcounted. |
| `insert(row)` | Optimistic; returns the confirmed or (if queued) optimistic row. |
| `insertMany(rows)` | Single HTTP request; never queues offline. |
| `update(id, changes)` | Optimistic with CAS rollback via `_anchor_mutationId`. |
| `upsert(row, options?)` | `UpsertOptions: { onConflict?: string; ignoreDuplicates?: boolean }`. |
| `remove(id)` | Optimistic delete; resolves `void` (no row to carry `_anchor_pending`). |
| `removeWhere(filters)` | Server-side filtered delete; local match is a conservative superset; never queues offline. |
| `setRecord(id, row)` / `removeRecord(id)` | Local-only, no remote call. |
| `clearAll()` | Empties `records`/`order`. |
| `mergeRecords(rows)` | Merge remote rows into `records`/`order`, skipping any row with `_anchor_pending`. |
| `clearAndFetch(options?)` | Forces `cacheStrategy: "replace"` for this call; the documented way to invalidate an accumulated `"merge"` cache. |
| `subscribe(filter?)` | Throws without a shared `RealtimeManager` (i.e. outside `createSupabaseStores`), and throws on a view. |
| `unsubscribe()` | Tears down the realtime channel. |
| `hydrate()` | Load from persistence. |
| `persist()` | Write current state to persistence (debounced ~100 ms internally on every mutating write). |
| `flushQueue()` | Drain the offline queue for this table. |
| `getQueueSize()` | Pending mutation count for this table. |

## Query layer

### Filter DSL, `import { ... } from '@drakkar.software/anchor'` (or `/query`)

```typescript
eq<Row, K>(column: K, value: Row[K]): FilterDescriptor<Row>
neq / gt / gte / lt / lte  // same shape as eq
like<Row, K>(column: K, pattern: string): FilterDescriptor<Row>       // case-sensitive
ilike<Row, K>(column: K, pattern: string): FilterDescriptor<Row>      // case-insensitive
is<Row, K>(column: K, value: null | boolean): FilterDescriptor<Row>
inValues<Row, K>(column: K, values: Row[K][]): FilterDescriptor<Row>
contains / containedBy / overlaps<Row, K>(column: K, value: unknown): FilterDescriptor<Row>
textSearch<Row, K>(column: K, query: string, options?: { type?: "plain"|"phrase"|"websearch"; config?: string }): FilterDescriptor<Row>
match<Row>(query: Partial<Row>): FilterDescriptor<Row>[]              // expands to N `eq` descriptors
asc<Row, K>(column: K, options?: { nullsFirst?: boolean }): SortDescriptor<Row>
desc<Row, K>(column: K, options?: { nullsFirst?: boolean }): SortDescriptor<Row>
```

`FilterOperator` also includes `not | or | filter`, with **no helper function**, build
the descriptor by hand:

```typescript
{ column: 'status', op: 'not', value: { op: 'eq', value: 'archived' } }
{ column: 'priority', op: 'filter', value: { op: 'gt', value: 3 } }
{ column: '', op: 'or', value: 'status.eq.active,priority.gt.3' }  // raw PostgREST string; column is ignored
```

### Fluent builder, `import { query } from '@drakkar.software/anchor/query/queryBuilder'`

```typescript
class QueryBuilder<Row> {
  where<K extends keyof Row>(column: K): ColumnFilter<Row, K>   // not exported; see methods below
  filter(descriptor: FilterDescriptor<Row>): this               // escape hatch for not/or/filter/textSearch/match
  orderBy(column: keyof Row, direction: "asc" | "desc" = "asc"): this
  limit(n: number): this
  offset(n: number): this
  select(columns: string): this
  count(mode: "exact" | "planned" | "estimated" = "exact"): this
  build(): FetchOptions<Row>
}
function query<Row = Record<string, unknown>>(): QueryBuilder<Row>
```

`.where(col)` returns a chain with `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`,
`is`, `in`, `contains`, `containedBy`, `overlaps`, each returns the `QueryBuilder` for
further chaining. **No `.textSearch()`/`.match()`/`.not()`/`.or()` on the chain**, use
`.filter(descriptor)` for those.

```typescript
const result = await store.getState().fetch(
  query<Todo>().where('status').eq('active').where('priority').gte(3)
    .orderBy('created_at', 'desc').limit(20).build(),
)
```

### `FetchOptions<Row>`

```typescript
type FetchOptions<Row> = {
  filters?: FilterDescriptor<Row>[]
  sort?: SortDescriptor<Row>[]
  limit?: number
  offset?: number
  select?: string
  count?: "exact" | "planned" | "estimated"
  /**
   * Escape hatch onto the raw PostgREST builder. Arrives with select, filters
   * and pagination already applied, but NOT sort, order is the one PostgREST
   * parameter that accumulates rather than overwrites, so pre-applying it
   * would demote the callback's own `.order()` behind `defaultSort`. Makes
   * the fetch unkeyable (no per-query loading/error state); configure it as
   * `defaultQueryFn` instead when it belongs to the source, not the call.
   */
  queryFn?: (builder: unknown) => unknown
  cacheStrategy?: CacheStrategy               // per-call override of the store default
}
```

### Cursor pagination, `import { buildCursorQuery, processCursorResults } from '@drakkar.software/anchor/query/pagination'`

```typescript
type CursorPaginationOptions<Row> = {
  cursorColumn: keyof Row
  pageSize: number
  cursor?: unknown
  direction?: "forward" | "backward"          // default "forward"
}
type PaginationState = { cursor: unknown; hasNextPage: boolean; hasPreviousPage: boolean; pageSize: number }

function buildCursorQuery<Row>(options): { filters: FilterDescriptor<Row>[]; sort: SortDescriptor<Row>[]; limit: number }
function processCursorResults<Row>(rows: Row[], options): { data: Row[]; pagination: PaginationState }
```

`limit` is always `pageSize + 1` internally (the extra row detects a next page). Forward
uses `gt` + ascending; backward uses `lt` + descending and reverses results.

```typescript
const { filters, sort, limit } = buildCursorQuery<Todo>({ cursorColumn: 'created_at', pageSize: 20, cursor: lastItem?.created_at })
const rows = await store.getState().fetch({ filters, sort, limit })
const { data, pagination } = processCursorResults(rows, { cursorColumn: 'created_at', pageSize: 20 })
```

### Local read semantics

`queryKey(options)` keys on filters (order-insensitive, since they AND), sort
(positional), select, limit, and offset, **not** on `count` or `cacheStrategy`.
`isKeyable(options)` is `false` exactly when `options.queryFn` is set.

`matchRow(row, filters)` (what decides which rows a query "sees" locally) has two rules
that make a local read a superset of the server's answer, never a subset:

- An operator it cannot evaluate locally (`textSearch`, `not`, `or`, `filter`) **includes**
  the row rather than excluding it.
- A column **absent from the row** includes it (an optimistic insert lacks server
  defaults).

`selectQueryRows` does **not** apply `limit`/`offset` locally, a limited query renders
whatever an unlimited sibling query already loaded into the same store's `records`.

## Mutations

Six mutators on every store: `insert`, `insertMany`, `update`, `upsert`, `remove`,
`removeWhere`. `UpsertOptions`:

```typescript
type UpsertOptions = {
  onConflict?: string          // comma-separated columns of the unique constraint to conflict on
  ignoreDuplicates?: boolean   // ON CONFLICT DO NOTHING instead of DO UPDATE
}
```

Without `onConflict`, PostgREST conflicts on the primary key, a table whose uniqueness
rule lives in a different constraint cannot be upserted at all (raises `23505`).
`ignoreDuplicates` is required for a join table granted only `select, insert, delete` (no
`update`): a plain `ON CONFLICT DO UPDATE` is refused `42501` even on a no-op conflict,
because Postgres checks UPDATE privilege for that clause regardless of whether one
occurs. A `DO NOTHING` conflict returns no row, so `upsert` reads back with
`.maybeSingle()` instead of `.single()` when this is set, and a `null`/no-error response
resolves to the store's own already-merged optimistic row (cleared of its pending flag)
rather than throwing `PGRST116`.

```typescript
await stores.post_likes.getState().upsert(
  { post_id, profile_id },
  { onConflict: 'post_id,profile_id', ignoreDuplicates: true },
)
```

### Validation

```typescript
validate: {
  insert?: (data: InsertRow) => true | string[]
  update?: (data: UpdateRow) => true | string[]
}
```

Runs synchronously **before** the optimistic apply, throwing `ValidationError` (has
`.errors: string[]`) on failure. `zodValidator(schema)` adapts a Zod schema's
`safeParse` into this shape.

### Batch operations, `updateMany`, `removeMany` (root export only)

```typescript
async function updateMany<Row>(supabase, table, primaryKey, store, filters, changes: Partial<Row>, schema?): Promise<TrackedRow<Row>[]>
async function removeMany<Row>(supabase, table, primaryKey, store, filters, schema?): Promise<void>
```

Local optimistic matching only evaluates `eq`/`neq`; everything else defaults to
"include" (the server does real filtering). Never queued offline.

### Conflict resolution

```typescript
type ConflictStrategy = "server-wins" | "client-wins" | "last-write-wins" | "field-merge" | "custom"

function remoteWins<Row>(): ConflictResolver<Row>
function localWins<Row>(): ConflictResolver<Row>
function lastWriteWins<Row>(timestampColumn = "updated_at"): ConflictResolver<Row>
function fieldLevelMerge<Row>(options?: { timestampColumn?: string; serverOwnedFields?: string[]; clientOwnedFields?: string[] }): ConflictResolver<Row>

type ConflictConfig<Row> = {
  strategy?: ConflictStrategy
  resolver?: ConflictResolver<Row>            // always wins over `strategy` when set
  timestampColumn?: string
  serverOwnedFields?: string[]
  clientOwnedFields?: string[]
}
```

Default strategy is `"server-wins"`. `"custom"` with no `resolver` silently returns
`remote`. `lastWriteWins` on a tie, or with either timestamp missing, resolves to
`remote`. **`fieldLevelMerge` is shallow**, no deep merge of nested objects/arrays.
`localWins`/`lastWriteWins` strip the three `_anchor_*` metadata keys from their result.

```typescript
createTableStore({
  // ...
  conflict: { strategy: 'field-merge', serverOwnedFields: ['computed_score'], clientOwnedFields: ['draft_content'] },
})
```

### Conflict audit, `ConflictAuditLog` (`/mutation/audit`)

```typescript
class ConflictAuditLog {
  record(entry: Omit<ConflictAuditEntry, "timestamp">): void
  getLog(options?: { table?: string; since?: number; userId?: string }): ConflictAuditEntry[]
  clearLog(): void
  onConflict(cb: (entry: ConflictAuditEntry) => void): () => void
}
```

**Not wired into any store automatically.** `resolveConflict`'s `auditLog` parameter is
never passed by `realtimeBindings`, `incrementalSync`, or `multiDeviceSync`, it only
fills if a caller invokes `resolveConflict` directly with an audit log instance.

## Offline queue

Opt-in via `offlineQueue: { queueWrites: true }` (only meaningful under
`createSupabaseStores`, and only when a `network` adapter is also configured, without
both, `queueWrites` silently does nothing and a `console.warn` fires at setup).

Only `insert`, `update`, `upsert`, `remove` queue. **`insertMany` and `removeWhere` never
queue**, they still roll back and throw when the server is unreachable.

```typescript
const row = await stores.todos.getState().insert({ title: 'Offline todo' })
row._anchor_pending // 'insert' while queued, undefined once confirmed, check THIS, not promise resolution
stores.todos.getState().getQueueSize()
await stores.todos.getState().flushQueue()
```

`maxRetries` defaults to **3**; past it a mutation becomes `rolled_back` and is **removed
from local state**, not merely abandoned. Set it higher for data that must never quietly
disappear across a multi-hour or multi-day offline stretch, and drive "still hasn't sent"
messaging off `useSyncStatus().failedCount` (a read) rather than the retry count.

Rules:

- **Coalescing**: `INSERT+UPDATE → INSERT` (payloads merged), `INSERT+DELETE →` both
  removed, `UPDATE+UPDATE → UPDATE` (merged), `UPDATE+DELETE → DELETE` (inherits the
  update's rollback snapshot). Keyed per user+table+primary-key.
- **`dependsOn`**: a mutation names the prior queued mutation for the same row; a
  dependency that rolls back cascades the rollback to its dependents.
- **Backoff**: `retryBaseDelay * 2^attempt + jitter` (default base 1000 ms).
- **User isolation**: a mutation tagged with a `userId` only flushes for that user;
  untagged mutations (no `auth`) flush for anyone.
- **Delivery is at-least-once.** A response lost to the network is indistinguishable
  from a request that never arrived, make queued writes idempotent (an `upsert` with a
  real `onConflict` replays harmlessly; a bare `insert` duplicates the row).
- **`remove` has no queued/sent signal**, it resolves `void`. Use `getQueueSize()` or
  `usePendingChanges()` to tell "queued" from "confirmed gone".
- `update` **throws** if queuing and the store doesn't hold the row locally: fetch it
  first, or write while online.
- `mustQueue`: a row with a queued write keeps queuing even while back online, until that
  write drains, otherwise a direct write could be overwritten by the older replay.

`OfflineQueue` class (root export, for manual wiring outside `createSupabaseStores`):

```typescript
class OfflineQueue {
  constructor(options?: { adapter?: PersistenceAdapter; network?: NetworkStatusAdapter; maxRetries?: number; flushDebounceMs?: number; retryBaseDelay?: number; logger?: SyncLogger; onRollback?: (m) => void; onTempIdResolved?: (tempId, realId, table) => void })
  setUserId(userId: string | undefined): void
  registerExecutor(table: string, executor: MutationExecutor): void
  hydrate(): Promise<void>
  enqueue(mutation: QueuedMutation): Promise<void>
  compact(): void
  flush(): Promise<FlushResult>                 // { succeeded, failed, rolledBack, complete }
  scheduleFlush(retryAttempt?: number): void
  cancelFlush(): void
  startAutoFlush(): void                        // reacts to network transitions only
  stopAutoFlush(): void
  get pendingCount(): number
  get isDirty(): boolean
  get pendingMutations(): QueuedMutation[]
  clearQueue(): Promise<void>
  destroy(): void
}
```

## Realtime

```typescript
class RealtimeManager {
  constructor(options: { supabase: SupabaseClient; logger?: SyncLogger })
  subscribe<Row>(options: {
    table: string; schema?: string; primaryKey: string
    events?: RealtimeEvent[]                    // default ["*"]
    filter?: string | FilterDescriptor[]
    select?: string[]                           // must include primaryKey, throws synchronously otherwise
    onInsert: (row: Row) => void
    onUpdate: (row: Row) => void
    onDelete: (oldRow: Partial<Row>) => void
    onStatus: (status: "disconnected"|"connecting"|"connected"|"error") => void
  }): () => void
  unsubscribe(table: string): void
  pause(): void                                 // hands channels back to supabase-js, keeps entries
  resume(): void                                // re-subscribes everything paused
  destroy(): void
  getStatus(): Map<string, "disconnected"|"connecting"|"connected"|"error">
}
```

Channel name: `` `anchor:${schema}:${table}` ``, one per table (a second `subscribe` for
the same table replaces the first). `select` omitting the primary key throws at
subscribe time: payloads without it cannot be keyed into the store.

`realtime.filter` on a table/store option only understands `eq, neq, gt, gte, lt, lte,
like, ilike, is, in` when translated to a Postgres Realtime filter string, using
`contains`, `containedBy`, `overlaps`, `textSearch`, `not`, `or`, `filter`, or `match`
there throws at subscribe time rather than silently widening the subscription.

`bindRealtimeToStore(manager, store, options)` wires a `RealtimeManager` subscription
into a store: pending rows (`_anchor_pending` set) are never overwritten by an incoming
event; `onUpdate` runs `resolveConflict` when `conflict` is configured, deleting the
local row if the resolver returns `null`.

## Sync

| Function | Signature | Behavior |
|---|---|---|
| `setupCrossTabSync(store, name, sessionId?)` | `() => void` | BroadcastChannel, falling back to `localStorage` events. Pending rows always preserved; incoming updates ignored while `!isHydrated`. |
| `incrementalSync(supabase, table, primaryKey, store, options?)` | `Promise<{ fetchedCount, mergedCount }>` | Delta fetch since `state.lastFetchedAt` on `timestampColumn` (default `"updated_at"`); rows with a NULL timestamp are included on purpose; skips `_anchor_pending` rows. |
| `selectiveSync(supabase, table, primaryKey, store, options?)` | same as above | `IncrementalSyncOptions & { filters?, conflict? }`, sync a filtered subset. |
| `syncAllByPriority(stores: {store, priority}[])` | `Promise<void>` | Ascending priority (lower number first), sequential, swallows per-store errors. |
| `fetchPage(store, options: CursorPaginationOptions)` | `Promise<{data, pagination}>` | `buildCursorQuery` → `store.fetch()` → `processCursorResults`, composed. |
| `setupMultiDeviceSync(supabase, stores, options?)` | `() => void` | Supabase Realtime **broadcast** (not `postgres_changes`), event `"sync"`; own broadcasts ignored by `deviceId`; delta-only, debounced per table (default 1000 ms). |
| `setupBackgroundSync(queue, adapter, options?)` | `Promise<() => Promise<void>>` | Registers a `BackgroundTaskAdapter` task (default name `"anchor:background-sync"`) that calls `queue.flush()`. |
| `SyncMetrics` | `class implements SyncLogger` | `getMetrics()`, `resetMetrics()`, `onMetricsUpdate(cb)`; pass an instance as a store's `logger`. |

```typescript
setupMultiDeviceSync(supabase, { todos: stores.todos }, {
  conflict: { strategy: 'last-write-wins', timestampColumn: 'updated_at' },
  debounceMs: 1000,
})
```

## Persistence and cache

```typescript
interface PersistenceAdapter {
  getItem<T>(key: string): Promise<T | null>
  setItem<T>(key: string, value: T): Promise<void>
  removeItem(key: string): Promise<void>
  multiSet?(entries: [string, unknown][]): Promise<void>
  keys?(prefix?: string): Promise<string[]>
  clear?(): Promise<void>
}
```

`MemoryAdapter` implements all six (Map-backed; use for tests). `EncryptedAdapter` wraps
another adapter, encrypting values only (keys stay plaintext); `keys()`/`clear()` throw
if the inner adapter lacks them.

```typescript
const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
const adapter = new EncryptedAdapter(new LocalStorageAdapter(), createWebCryptoEncryption(key))
```

`StorageQuotaManager`: `getUsage(adapter, prefix?)`, `setTableLimit`/`getTableLimit`,
`enforceLimit(adapter, table, schema?)`, `evictByCount(adapter, options?)`. `getUsage`/
`evictByCount` throw without `adapter.keys()`.

`checkSchemaVersion(adapter, currentVersion)` returns `{ versionChanged, previousVersion
}`; on a mismatch it clears **every** `anchor:`-prefixed key except its own version key,
this also wipes the offline mutation queue and temp-id map, since they share the prefix.

Cache TTL: `isStale(store, staleTTL = 5min)`, `isExpired(store, cacheTTL = 30min)`,
`fetchWithSwr(store, config?)` (expired → awaited fetch, stale → background fetch, fresh
→ no-op), `setupAutoRevalidation(store, config?)` (default `checkInterval` 60s). All
three judge on the **table-level** `lastFetchedAt`, not a per-query one.

## Auth

```typescript
type AuthState = { session: Session | null; user: User | null; isLoading: boolean; error: Error | null; claims: Record<string, unknown> }
type AuthActions = {
  initialize: () => Promise<void>
  signIn: (credentials: { email: string; password: string }) => Promise<void>
  signUp: (credentials: { email: string; password: string }) => Promise<void>
  signOut: () => Promise<void>
  signInWithOAuth: (options: { provider: string; redirectTo?: string }) => Promise<void>
  refreshSession: () => Promise<void>
  onAuthStateChange: () => () => void
  getClaim: (key: string) => unknown                 // unverified, local base64 decode
  getVerifiedClaims: () => Promise<{ claims: Record<string, unknown> | null; error: Error | null }>  // JWKS-checked
}
type AuthStore = AuthState & AuthActions
```

`createAuthStore({ supabase, devtools? }): StoreApi<AuthStore>`. `signIn`/`signUp`/
`signOut`/`signInWithOAuth` throw `AnchorError`; `refreshSession` swallows and only sets
`error`. **No MFA support** exists anywhere in the package.

`setupAuthGate(supabase, authStore, tableStores, options?)`:

```typescript
type AuthGateOptions = {
  clearOnSignOut?: boolean       // default true
  refetchOnSignIn?: boolean      // default true
  onAuthChange?: (event: string, session: unknown) => void
  realtimeManager?: RealtimeManager
  offlineQueue?: OfflineQueue
}
```

On `SIGNED_OUT`: clears every store and destroys the `RealtimeManager`, but **does not
clear the offline queue**, deliberate, since a refresh-token expiry also emits
`SIGNED_OUT` and clearing would silently discard unsent writes (safety instead comes from
per-mutation `userId` tagging). On `SIGNED_IN`/`INITIAL_SESSION` with a session, schedules
a queue flush; `refetchOnSignIn` refetches every store. `TOKEN_REFRESHED` calls
`supabase.realtime.setAuth(...)`. `isRlsError(error)` checks `code === "42501"` first,
then falls back to substring matching the message.

Free auth actions (no store, importable from `/auth/actions`), none of which throw:
each returns `{ ..., error: AnchorError | null }`:

```typescript
getSession(supabase) / getUser(supabase)
signUpWithPassword(supabase, { email, password, options?: SignUpOptions })
signInWithPassword(supabase, { email, password })      // re-auth step before a destructive change; does not touch store state
updateUser(supabase, attributes: UpdateUserAttributes)  // password path terminates a recovery flow
resendOtp(supabase, params: ResendOtpParams)
```

Callback/OTP flows (`/auth/callbacks`): `parseAuthCallbackUrl(url)`,
`hasAuthCallbackParams(url)`, `createSessionFromUrl(supabase, url)` (handles both
implicit and PKCE flows; throws on a URL error or failed session establishment; `null`
if the URL carries no auth params), `getWebAuthRedirectTo(path?)`,
`sendPasswordRecovery`, `verifyRecoveryOTP`, `verifyOtp`.

## Hooks

All hooks carry `"use client"`. Store-bound hooks take a `StoreApi<TableStore<...>>` as
their first argument; a few take a `SupabaseClient` directly.

| Hook | Signature | Notes |
|---|---|---|
| `useQuery(store, options?)` | `options: FetchOptions<Row> & { deps?, enabled?, refetchInterval?, staleTime? (default 5000) }` → `{ data, isLoading, error, count, refetch, isHydrated }` | Keyed by `queryKey`; retains/releases the query for `refetch()`. |
| `useMutation(store)` | → `{ insert, insertMany, update, upsert, remove, removeWhere, isLoading, error }` | Thin wrapper over the store's own mutators plus loading/error tracking. |
| `createTableHook(store)` | → overloaded `useHook(): State` / `useHook(selector): Selected` | Selector-based, like a scoped `useStore`. |
| `useRecords(store)` | → `TrackedRow<Row>[]` | All rows in `order`. |
| `useRecord(store, id)` | → `TrackedRow<Row> \| undefined` | |
| `useSuspenseQuery(store, options?)` | → `TrackedRow<Row>[]` | Throws a promise while loading (30s safety timeout), throws the error on failure, wrap in `<Suspense>`. |
| `useLinkedQuery(queryFn, options?)` | `options: { stores?, deps?, enabled?, initialData?, mergeToStore?, staleTime?, queryKey? }` → `{ data, isLoading, error, refetch }` | For joins/complex selects `useQuery` can't express; refetches when any linked store's `records` reference changes. `mergeToStore` writes array results back for `initialData` lookups elsewhere. |
| `useInfiniteQuery(supabase, options)` | root export only; `options: { table, cursorColumn, pageSize?, filters?, sort?, select?, schema?, enabled? }` → `{ data, pages, isLoading, isLoadingMore, hasMore, error, loadMore, reset, pagination }` | **Takes the client, not a store**, bypasses optimistic rows, realtime, and persistence entirely. Use `useQuery` unless cursor pagination is a hard requirement. |
| `useRealtime(store, options?)` | `options: { filter?, enabled? }` → `{ status }` | Subscribes on mount, unsubscribes on unmount. |
| `useAuth(authStore)` | → `{ session, user, isLoading, error, signIn, signUp, signOut, signInWithOAuth, refreshSession }` | Does **not** surface `getClaim`/`getVerifiedClaims`, call `authStore.getState().getClaim(...)` directly for those. |
| `useAuthCallback(supabase, authStore, options)` | `options: { getUrl, onSuccess?, onError?, routes?, redirect? }` → `{ isProcessing, error }` | One-shot; writes the resolved session straight into the auth store, then navigates via `options.redirect` or `window.location.replace`. |
| `useRpc(supabase, functionName, args?, options?)` | `options: { enabled?, deps? }` → `{ data, error, isLoading, refetch }` | **`args` is held in a ref**, changing it alone does not refetch; pass `deps` to trigger one. |
| `useEdgeFunction(supabase, functionName)` | → `{ data, error, isLoading, invoke }` | |
| `useStorage(supabase, bucket)` | → `{ upload, download, getPublicUrl, createSignedUrl, list, remove, isLoading, error }` | |
| `useAppLifecycle(options: AppLifecycleOptions)` | `void` | Re-runs `setupAppLifecycle` only when `options.adapter` identity changes. |
| `useSyncMetrics(metrics: SyncMetrics)` | → `MetricsSnapshot` | |
| `useConflictNotifications(auditLog)` | → `{ conflicts, clearAll, dismiss }` | |
| `useSyncStatus(stores, options?)` / `computeSyncStatus(stores, network?)` | → `{ pendingCount, isSyncing, lastSyncedAt, failedCount, status }` | `status` precedence: `error > offline > syncing > synced`. `lastSyncedAt` is the **oldest** store's `lastFetchedAt`. |
| `useQueueStatus(store)` | → `{ pendingCount, queueSize }` | |
| `usePendingChanges(store)` | → `{ id, row, mutationType }[]` | |
| `useStorageQuota(adapter, options?)` | `options: { prefix? (default "anchor:"), refreshInterval? }` → `StorageUsage & { isLoading, refresh }` | |

## Storage, Edge Functions, RPC, RSC

### Storage

```typescript
function createStorageActions(supabase, bucket: string): {
  upload, download, getPublicUrl, createSignedUrl, list, remove
}
```

`getPublicUrl(supabase, bucket, path): string` is the **only** storage function that is
synchronous and returns a bare string rather than `{data, error}` like every sibling.

```typescript
const avatars = createStorageActions(supabase, 'avatars')
await avatars.upload('user-123.png', file, { upsert: true })
const url = avatars.getPublicUrl('user-123.png')
const { signedUrl } = await avatars.createSignedUrl('private/doc.pdf', { expiresIn: 3600 })
```

### Edge Functions

```typescript
createEdgeFunctionAction<T>(supabase, functionName): (options?: InvokeOptions) => Promise<EdgeFunctionResult<T>>
```

### RPC

```typescript
createSchemaRpc<DB, SchemaName = "public">(supabase: SupabaseClient<DB>):
  <F extends FunctionNames<DB, SchemaName>>(name: F, ...rest) => Promise<RpcResult<RpcReturns<DB, F, SchemaName>>>
```

Reads function name/args/return straight out of the generated `Database` type, nothing
is written twice. Arity is type-enforced: a function with `Args: never` (no arguments) or
an empty-object args shape may be called with zero arguments; anything else requires
`args`.

```typescript
const rpc = createSchemaRpc<Database>(supabase)
const { data, error } = await rpc('get_dashboard_stats', { user_id: '123' })
await rpc('current_user_is_admin')  // fine: generated as Args: never
```

`callRpc(supabase, functionName, args?, options?)` and `createRpcAction(supabase,
functionName, defaultOptions?)` take the name as a plain string for a function the
generated types don't cover; both support `options.cache: { ttlMs }` and
`options.retry: RetryOptions`.

### RSC prefetch

```typescript
async function prefetch<Row>(supabase, table, options?: FetchOptions<Row> & { schema? }): Promise<{ data: Row[]; error: Error | null; fetchedAt: number }>
```

No Zustand store involved. `serializePrefetchResult`/`deserializePrefetchResult` for
passing the result across a server/client boundary; serialization flattens an error to
its `.message` string.

```tsx
// Server Component
export default async function TodosPage() {
  const { data } = await prefetch<Todo>(supabase, 'todos', { sort: [{ column: 'created_at', ascending: false }], limit: 50 })
  return <TodoList initialData={data} />
}
```

## Errors

```typescript
class AnchorError extends Error {
  readonly code?: string       // "23505", "42501", "PGRST116", …
  readonly details?: string
  readonly hint?: string
  readonly status?: number     // HTTP status, where a boundary exposes one (storage, functions)
}
function fromSupabaseError(error: unknown, fallbackMessage?: string): AnchorError
function isTransportError(error: unknown, status: number | undefined): boolean
const PG_INSUFFICIENT_PRIVILEGE = "42501"
const PG_UNIQUE_VIOLATION = "23505"
const PG_FOREIGN_KEY_VIOLATION = "23503"
const PGRST_NO_ROWS = "PGRST116"
```

`isTransportError` requires `status === 0` **and** an empty/missing `code`, a 5xx with
an unparseable body reached a server and is not treated as a transport failure (it is not
queued, even with `queueWrites: true`).

## Resilience utilities

```typescript
withRetry<T>(fn: () => Promise<T>, options?: { maxAttempts?: 3; baseDelay?: 1000; jitter?: true; isRetryable?: (e) => boolean }): Promise<T>
// loop is `attempt <= maxAttempts`, so maxAttempts: 3 means up to 4 total calls

class CircuitBreaker {
  constructor(options?: { failureThreshold?: 5; cooldownMs?: 30000; onStateChange?: (s) => void })
  execute<T>(fn: () => Promise<T>): Promise<T>   // throws CircuitOpenError immediately once open
  reset(): void
  getState(): "closed" | "open" | "half-open"
}

class RateLimiter {
  constructor(options: { maxRequests: number; windowMs: number })  // both required, no defaults
  execute<T>(fn: () => Promise<T>): Promise<T>
  get pendingCount(): number
  destroy(): void   // rejects every still-queued call
}
```

Composite-key helpers (`/index` root export, always available regardless of composite-PK
store support, see below): `encodeKey(row, primaryKey)`, `buildPkFilter(primaryKey,
id)`, `applyPkFilters(builder, primaryKey, id)`, `normalizePk(primaryKey)`.

## Composite primary keys

`primaryKey` accepts `string | string[]`. An array names a composite key, for a join
table whose real uniqueness spans more than one column and has no surrogate `id`.

```typescript
const stayServicesStore = createTableStore<Database, StayServiceRow, StayServiceRow, Partial<StayServiceRow>>({
  supabase,
  table: 'stay_services',
  primaryKey: ['stay_id', 'service_id'],
})
```

A composite key is stored internally as a single JSON-encoded string
(`encodeKey(row, primaryKey)`), so `records`/`order` still key on one plain `string |
number` exactly as a single-column table always has, nothing about the Map,
persistence, or the query/select layer changes, and every single-column-PK call takes
the same scalar branch as before (byte-identical behavior, not just API-compatible).

```typescript
type PrimaryKeyValue = string | number | Record<string, unknown>
```

`update`, `remove`, `fetchOne`, `setRecord`, `removeRecord` all take `id:
PrimaryKeyValue`, either the pre-encoded key or a plain `{ column: value, ... }` object
(the row itself, or its primary-key columns), whichever the caller already has:

```typescript
await stayServicesStore.getState().update({ stay_id, service_id }, { note: 'late checkout' })
await stayServicesStore.getState().remove({ stay_id, service_id })
```

`insert`/`insertMany`/`upsert` **require every primary-key column present in the
payload** for a composite-key table, there is no server-generated id to optimistically
stand in for one, since every composite-PK table is in practice a join table whose
columns are all client-supplied foreign keys. A payload missing a PK column throws
`AnchorError` before any optimistic apply or network call.

**Realtime is not supported on a composite-key table.** `store.subscribe()` throws, and
`createSupabaseStores`'s `tableOptions[x].realtime.enabled` throws at setup time:
`bindRealtimeToStore`/`RealtimeManager` key a single column only, and failing loudly
beats silently binding the wrong (first) column. Everything else (fetch, mutation,
offline queue, persistence, conflict resolution, cross-tab sync) works unchanged.

Views (`viewOptions[view].primaryKey`) still take only a single column, composite keys
are scoped to `createTableStore`/`createSupabaseStores` table stores.

`setupMultiDeviceSync`'s `ConflictContext` previously hardcoded `primaryKey: { id }`
regardless of a table's real key (a pre-existing bug found while wiring this, not
specific to composite keys). Fixed via a new option:

```typescript
setupMultiDeviceSync(supabase, stores, {
  primaryKeys: { stay_services: ['stay_id', 'service_id'] },  // default: "id" per table
})
```

## Gotchas / anti-hallucination list

- `useInfiniteQuery` is not exported from `/hooks`, import it from the root.
- A composite `primaryKey` array cannot be subscribed to realtime; `subscribe()` and
  `tableOptions[x].realtime.enabled` both throw for a composite-key table (single-column
  tables are unaffected). See "Composite primary keys" above.
- Passing `realtime`/`conflict`/`network`/`offlineQueue` to standalone `createTableStore`
  does not throw, it `console.warn`s and silently ignores the option.
- `offlineQueue.queueWrites` needs **both** a queue (i.e. `createSupabaseStores`) and a
  `network` adapter, or nothing is ever queued (with a setup-time warning).
- `store.subscribe()` throws without a shared `RealtimeManager` (standalone
  `createTableStore`), and throws unconditionally on a view store.
- `useRpc`'s `args` is captured in a ref; changing it alone does not refetch, pass a
  `deps` array that changes instead.
- `insertMany` and `removeWhere` never queue offline, regardless of `queueWrites`.
- `fetchWithSwr`/`isStale`/`isExpired`/`setupAutoRevalidation` all read the table-level
  `lastFetchedAt`, not any individual query's.
- `aggregateRpc` defaults its Postgres function name to `` `zs_${fn}_${table}_${column}`
  ``, that function must exist in the database, or pass `rpcName` explicitly.
- `ConflictAuditLog` records nothing unless `resolveConflict` is called with an audit log
  instance directly, no automatic path feeds it.
- A row reaching the store with a nullish primary key **throws** rather than silently
  colliding with another row, set `viewOptions[view].primaryKey` explicitly for any
  view, since generated view columns are always nullable in the `Database` type.
- `fieldLevelMerge` is a shallow merge; nested objects/arrays are not merged field by
  field.
- No MFA support exists. No presence/broadcast primitive beyond what
  `setupMultiDeviceSync` uses internally.
- `getPublicUrl` throws rather than returning `{data, error}`, unlike every other storage
  function.
- `checkSchemaVersion`'s mismatch path clears the offline mutation queue and temp-id map
  too, since they share the `anchor:` key prefix.

## Recipes

### Offline-first web app

```typescript
import { createAnchorClient, createSupabaseStores, setupAuthGate, eq, isPending } from '@drakkar.software/anchor'
import { setupAppLifecycle } from '@drakkar.software/anchor/lifecycle'
import { LocalStorageAdapter, WebNetworkStatus, WebAppLifecycle } from '@drakkar.software/anchor-adapter-web'
import type { Database } from './database.types'

const supabase = createAnchorClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)

export const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos'],
  persistence: { adapter: new LocalStorageAdapter() },
  network: new WebNetworkStatus(),
  offlineQueue: { queueWrites: true, maxRetries: 10 },
  realtime: { enabled: true },
})

setupAuthGate(supabase, stores.auth, [stores.todos])
setupAppLifecycle({ adapter: new WebAppLifecycle(), stores: [stores.todos], authStore: stores.auth })

// Component
function TodoList() {
  const { data, isLoading } = useQuery(stores.todos, { filters: [eq('completed', false)] })
  const { insert, remove } = useMutation(stores.todos)
  return (
    <ul>
      {data.map((t) => <li key={t.id}>{t.title}{isPending(t) && ' (saving...)'}</li>)}
    </ul>
  )
}
```

### Auth-gated stores with callback handling

```typescript
import { useAuthCallback } from '@drakkar.software/anchor'

function AuthCallbackPage() {
  const { isProcessing, error } = useAuthCallback(supabase, stores.auth, {
    getUrl: () => window.location.href,
    routes: { recovery: '/reset-password', default: '/' },
  })
  if (isProcessing) return <Spinner />
  if (error) return <ErrorPage error={error} />
  return null
}
```

### Read a view

```typescript
const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos'],
  views: ['todo_summary'],
  viewOptions: { todo_summary: { primaryKey: 'user_id' } },
})

function Summary() {
  const { data } = useQuery(stores.todo_summary)
  return <div>{data[0]?.open_count} open</div>
}
```

### RSC prefetch + client hydration

```tsx
// Server Component
import { prefetch } from '@drakkar.software/anchor'

export default async function Page() {
  const { data } = await prefetch<Todo>(serverSupabase, 'todos', { limit: 50 })
  return <ClientTodoList initialData={data} />
}

// Client Component
function ClientTodoList({ initialData }: { initialData: Todo[] }) {
  useEffect(() => { stores.todos.getState().mergeRecords(initialData) }, [])
  const { data } = useQuery(stores.todos)
  return <ul>{data.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
}
```

### React Native with background sync

```typescript
import { createSupabaseStores } from '@drakkar.software/anchor'
import { setupBackgroundSync } from '@drakkar.software/anchor/sync/background'
import { ExpoSqliteAdapter, RNNetworkStatus, RNBackgroundSync } from '@drakkar.software/anchor-adapter-react-native'
import * as SQLite from 'expo-sqlite'
import NetInfo from '@react-native-community/netinfo'
import * as TaskManager from 'expo-task-manager'
import * as BackgroundFetch from 'expo-background-fetch'

const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos'],
  persistence: { adapter: new ExpoSqliteAdapter(SQLite) },
  network: new RNNetworkStatus(NetInfo),
  offlineQueue: { queueWrites: true },
})

const cleanup = await setupBackgroundSync(
  { flush: () => stores.todos.getState().flushQueue() },
  new RNBackgroundSync(TaskManager, BackgroundFetch),
)
```

## Task → API decision table

| Task | API |
|---|---|
| Render a filtered/sorted list, reactive | `useQuery(store, { filters, sort })` |
| Insert/update/delete with optimistic UI | `useMutation(store)` |
| A list backed by a join or complex select | `views:` in `createSupabaseStores`, or `useLinkedQuery` if it needs to stay outside the store model |
| Cursor-based infinite scroll | `useInfiniteQuery(supabase, options)` (bypasses the store) |
| Cursor pagination while keeping a store | `buildCursorQuery` + `store.fetch()` + `processCursorResults` |
| React Suspense data fetching | `useSuspenseQuery(store, options?)` |
| Selector-scoped store read (avoid re-render) | `createTableHook(store)` then `useHook(selector)` |
| Read one row by id | `useRecord(store, id)` |
| Work offline with retry | `createSupabaseStores({ offlineQueue: { queueWrites: true }, network })` |
| Show sync/queue health in UI | `useSyncStatus`, `useQueueStatus`, `usePendingChanges` |
| Resolve write conflicts | `conflict: ConflictConfig` on the table (or per-table via `tableOptions`) |
| Validate before writing | `validate: { insert, update }`, or `zodValidator(schema)` |
| Encrypt persisted data at rest | `EncryptedAdapter` + `createWebCryptoEncryption` |
| Bound local storage growth | `StorageQuotaManager` |
| Invalidate cache on a schema change | `checkSchemaVersion(adapter, version)` |
| Auto-flush/refresh/revalidate on app foreground | `setupAppLifecycle` / `useAppLifecycle` |
| Sync across browser tabs | `setupCrossTabSync` |
| Sync across devices (not tabs) | `setupMultiDeviceSync` |
| Delta-fetch only changed rows | `incrementalSync` / `selectiveSync` |
| Background-flush the queue on mobile | `setupBackgroundSync` + `RNBackgroundSync` |
| Session-gated stores (clear/refetch on auth change) | `setupAuthGate` |
| Handle magic-link/recovery/invite redirect | `useAuthCallback` or `createSessionFromUrl` directly |
| Re-authenticate before a destructive account change | `signInWithPassword` (free action, not the store's `signIn`) |
| Read a Postgres function typed from the schema | `createSchemaRpc<DB>(supabase)` |
| Call a Postgres function the generated types don't cover | `createRpcAction<T>(supabase, name)` |
| Upload/download/list/sign storage files | `createStorageActions(supabase, bucket)` |
| Invoke an Edge Function | `createEdgeFunctionAction<T>(supabase, name)` |
| Prefetch data in a Server Component | `prefetch(supabase, table, options)` |
| Wrap a flaky call with retry/backoff | `withRetry(fn, options)` |
| Protect against a cascading failing endpoint | `CircuitBreaker` |
| Throttle a burst of requests | `RateLimiter` |
| Monitor sync health metrics | `SyncMetrics` as a store's `logger` |
| Log/react to conflict resolutions | `ConflictAuditLog` |
