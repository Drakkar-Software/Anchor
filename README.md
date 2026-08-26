<p align="center">
  <img src="logo.png" alt="Anchor" width="200" />
</p>

<h1 align="center">Anchor</h1>

<p align="center">Type-safe Zustand stores auto-generated from your Supabase schema. Offline-first, realtime, with optimistic updates.</p>

## Features

- **Auto-generated, type-safe stores** from Supabase `Database` types — filters, mutations, and hooks fully typed
- **Optimistic mutations** with automatic rollback, validation, and conflict resolution
- **Offline-first** with persistent queue, coalescing, dependency tracking, and auto-flush on reconnect
- **Realtime & sync** — Supabase subscriptions, cross-tab (BroadcastChannel), multi-device, incremental and selective sync
- **Caching** — query cache strategy (replace/merge), cursor pagination, infinite scroll, cache TTL with stale-while-revalidate
- **Platform adapters** — Web (localStorage/IndexedDB) and React Native (expo-sqlite/AsyncStorage/background sync)
- **Auth, RSC & Suspense** — session-gated stores, RLS awareness, server prefetch, React Suspense
- **Resilience** — retry with backoff, circuit breaker, rate limiter, encryption at rest, storage quota, schema versioning
- **Observability** — sync status hooks, sync health metrics, conflict audit trail
- **Full Supabase coverage** — Storage, Edge Functions, RPC, aggregation (client & server)

## Installation

```bash
npm install @drakkar.software/anchor zustand
# Web adapters
npm install @drakkar.software/anchor-adapter-web
# React Native adapters
npm install @drakkar.software/anchor-adapter-react-native
```

## Quick Start

### 1. Generate types from your Supabase schema

```bash
npx supabase gen types typescript --project-id $PROJECT_REF > database.types.ts
```

### 2. Create stores for all tables

```typescript
import { createAnchorClient, createSupabaseStores } from '@drakkar.software/anchor'
import { LocalStorageAdapter, WebNetworkStatus } from '@drakkar.software/anchor-adapter-web'
import type { Database } from './database.types'

const supabase = createAnchorClient<Database>(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_PUBLISHABLE_KEY!, // sb_publishable_... (new format) or the legacy anon key
)

export const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos', 'profiles'],
  persistence: { adapter: new LocalStorageAdapter() },
  network: new WebNetworkStatus(),
  realtime: { enabled: true },
  devtools: process.env.NODE_ENV === 'development',
})
```

### 3. Use in React components

```tsx
import { useQuery, useMutation, eq, isPending } from '@drakkar.software/anchor'

function TodoList() {
  const { data, isLoading } = useQuery(stores.todos, {
    filters: [eq('completed', false)],
  })
  const { insert, remove } = useMutation(stores.todos)

  if (isLoading) return <div>Loading...</div>

  return (
    <ul>
      {data.map(todo => (
        <li key={todo.id}>
          {todo.title}
          {isPending(todo) && <span> (saving...)</span>}
          <button onClick={() => remove(todo.id)}>Delete</button>
        </li>
      ))}
      <button onClick={() => insert({ title: 'New todo' })}>
        Add Todo
      </button>
    </ul>
  )
}
```

## API Reference

### Store Factories

#### `createTableStore(options)`

Creates a Zustand store for a single Supabase table.

```typescript
const todosStore = createTableStore<Database, TodoRow, TodoInsert, TodoUpdate>({
  supabase,
  table: 'todos',
  primaryKey: 'id',                    // default: 'id'
  schema: 'public',                    // default: 'public'
  defaultSort: [{ column: 'created_at', ascending: false }],
  persistence: { adapter: new LocalStorageAdapter() },
  devtools: true,
  crossTab: { enabled: true },
  validate: {
    insert: (data) => data.title?.length > 0 ? true : ['Title required'],
    update: (data) => true,
  },
  extend: (set, get, store, supabase) => ({
    completedCount: () =>
      [...get().records.values()].filter(t => t.completed).length,
    toggleComplete: async (id: number) => {
      const current = get().records.get(id)
      if (current) await get().update(id, { completed: !current.completed })
    },
  }),
})
```

> **Note:** `realtime`, `conflict`, `network`, and `offlineQueue` options require `createSupabaseStores()` which wires up the shared RealtimeManager and OfflineQueue. Use `createSupabaseStores()` for full-featured stores, or manually set up these features with `RealtimeManager`, `bindRealtimeToStore`, and `OfflineQueue`.

**Composite primary keys.** `primaryKey` also accepts an array, for a join
table whose real key spans more than one column:

```typescript
const stayServicesStore = createTableStore<Database, StayServiceRow, StayServiceRow, Partial<StayServiceRow>>({
  supabase,
  table: 'stay_services',
  primaryKey: ['stay_id', 'service_id'],   // no surrogate `id` column
})

// update/remove/fetchOne/setRecord/removeRecord all accept either the
// pre-encoded key OR the plain columns, whichever you already have:
await stayServicesStore.getState().update({ stay_id, service_id }, { note: 'late checkout' })
```

`insert`/`upsert` require every primary-key column in the payload for a
composite-key table — there is no server-generated id to optimistically
stand in for one, since a composite-key table is always a join table whose
columns are client-supplied foreign keys. Realtime is not supported on a
composite-key table (`subscribe()` and `tableOptions[x].realtime` both throw)
— `bindRealtimeToStore`/`RealtimeManager` key a single column.

#### `createSupabaseStores(options)`

Creates typed stores for multiple tables at once.

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

// Fully typed:
stores.todos.getState().insert({ title: 'Buy milk' })
stores.profiles.getState().fetch()
stores._destroy() // Clean up all subscriptions
```

#### Views

Name them in `createSupabaseStores`. A view store is read-only (every mutator
throws) and otherwise a normal store: same persistence, same auth gate, same
per-query scoping, readable with `useQuery`.

```typescript
const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos'],
  views: ['dashboard_stats'],
  viewOptions: {
    // Worth setting on almost every view: a generated `Database` marks every
    // view column nullable, so the default "id" is not safe to lean on, and a
    // row that arrives without its key fails the fetch rather than collapsing
    // onto another row's record.
    dashboard_stats: { primaryKey: 'owner_id' },
  },
})

const stats = await stores.dashboard_stats.getState().fetch()
// stores.dashboard_stats.getState().insert({}) // Throws: "Cannot mutate view"
```

A view gets no realtime subscription: Postgres publishes changes under the
underlying *table's* name, so a channel on the view's name would register and
never fire. Refetch it from the table store's events, or on foreground, if its
freshness matters.

#### `createViewStore(options)` — deprecated

Superseded by `views:` above. A standalone view store cannot reach the factory's
shared persistence, auth gate, offline queue or cleanup, and its `ViewStore<Row>`
type hides the three actions `useQuery` calls (`resolveFetchOptions`,
`retainQuery`, `releaseQuery`), so it cannot be read with the hook the rest of
the library is built around.

### Store Actions

Every table store provides these actions:

| Action | Description |
|--------|-------------|
| `fetch(options?)` | Fetch rows from Supabase with filters/sort/pagination |
| `fetchOne(id)` | Fetch a single row by primary key |
| `refetch()` | Re-run the last fetch |
| `insert(row)` | Insert a row (optimistic) |
| `insertMany(rows)` | Batch insert (single HTTP request) |
| `update(id, changes)` | Update a row (optimistic with rollback) |
| `upsert(row)` | Insert or update (optimistic with rollback) |
| `remove(id)` | Delete a row (optimistic with rollback) |
| `subscribe(filter?)` | Subscribe to realtime changes |
| `hydrate()` | Load from local persistence |
| `flushQueue()` | Flush the offline mutation queue |
| `getQueueSize()` | Number of pending mutations |
| `clearAll()` | Clear all records |
| `clearAndFetch(options?)` | Clear cache and re-fetch (invalidation for merge mode) |
| `mergeRecords(rows)` | Merge remote rows (skip pending) |

### Hooks

#### `useQuery(store, options?)`

Declarative data fetching with auto-refetch.

```tsx
const { data, isLoading, error, refetch, isHydrated } = useQuery(
  stores.todos,
  {
    filters: [eq('completed', false)],
    sort: [{ column: 'created_at', ascending: false }],
    limit: 20,
    enabled: true,           // Toggle fetching
    deps: [statusFilter],    // Refetch when deps change
    refetchInterval: 30000,  // Auto-refetch every 30s
  },
)
```

#### `useMutation(store)`

Type-safe mutations with loading/error tracking.

```tsx
const { insert, update, upsert, remove, isLoading, error } = useMutation(stores.todos)

await insert({ title: 'New todo', completed: false })
await update(1, { completed: true })
await remove(1)
```

#### `useLinkedQuery(queryFn, options?)`

Custom query that auto-refetches when linked stores mutate. Use for queries with joins or complex selects that can't use `useQuery` directly.

```tsx
import { useLinkedQuery } from '@drakkar.software/anchor/hooks'

const { data, isLoading, error, refetch } = useLinkedQuery(
  () => fetchOfferApplications(supabase, offerId),
  {
    stores: [stores.applications],  // refetch when these stores mutate
    deps: [offerId],                // refetch when deps change
    enabled: !!offerId,
  },
)
```

**`initialData`** — seed data on mount to avoid loading flash (stale-while-revalidate). The network fetch still fires in the background.

```tsx
const { data: offer } = useLinkedQuery(
  () => fetchOffer(supabase, id),
  {
    stores: [stores.offers],
    deps: [id],
    // Read from the store immediately — renders without a loading state
    initialData: () => stores.offers.getState().records.get(id),
  },
)
```

**`mergeToStore`** — write list results back into a store so detail queries can find them via `initialData`.

```tsx
// List query populates the store as a side-effect
const { data: offers } = useLinkedQuery(
  () => fetchOffers(supabase),
  {
    stores: [stores.offers],
    mergeToStore: stores.offers,  // each fetched offer lands in the store
  },
)

// Detail query reads from the store instantly — no loading state on navigation
const { data: offer } = useLinkedQuery(
  () => fetchOffer(supabase, id),
  {
    stores: [stores.offers],
    deps: [id],
    initialData: () => stores.offers.getState().records.get(id),
  },
)
```

#### `useSuspenseQuery(store, options?)`

React Suspense-compatible query. Throws promise while loading.

```tsx
function TodoList() {
  const data = useSuspenseQuery(stores.todos)
  return <ul>{data.map(t => <li key={t.id}>{t.title}</li>)}</ul>
}

// Wrap in Suspense boundary
<Suspense fallback={<Spinner />}>
  <TodoList />
</Suspense>
```

#### `useInfiniteQuery(supabase, options)`

Cursor-based infinite scroll with load-more support. **Takes the Supabase client
directly, not a store** -- it queries the table itself and bypasses the store
entirely, so a list built with it gets no optimistic rows, no realtime updates,
and no persistence. Reach for `useQuery` first; use this only when a screen
genuinely needs cursor pagination a store's `records`/`order` can't express.

```tsx
import { useInfiniteQuery } from '@drakkar.software/anchor/hooks'

function InfiniteTodoList() {
  const { data, hasMore, loadMore, isLoading, isLoadingMore } = useInfiniteQuery(
    supabase,
    {
      table: 'todos',
      cursorColumn: 'created_at',
      pageSize: 20,
      sort: [{ column: 'created_at', ascending: false }],
    },
  )

  return (
    <>
      <ul>{data.map(t => <li key={t.id}>{t.title}</li>)}</ul>
      {hasMore && <button onClick={loadMore} disabled={isLoadingMore}>Load more</button>}
    </>
  )
}
```

#### `useAuth(authStore)`

Auth state with automatic session listener.

```tsx
const { session, user, isLoading, signIn, signOut } = useAuth(stores.auth)

await signIn({ email: 'user@example.com', password: 'secret' })
```

#### `useRealtime(store, options?)`

Manages realtime subscription lifecycle.

```tsx
const { status } = useRealtime(stores.todos)
// status: 'disconnected' | 'connecting' | 'connected' | 'error'
```

#### `useRpc(supabase, functionName, args?, options?)`

Call Postgres functions.

```tsx
const { data, isLoading, error, refetch } = useRpc<Stats>(
  supabase, 'get_dashboard_stats', { user_id: '123' },
)
```

#### `useEdgeFunction(supabase, functionName)`

Invoke Supabase Edge Functions.

```tsx
const { data, isLoading, invoke } = useEdgeFunction<Response>(supabase, 'send-email')
await invoke({ body: { to: 'user@example.com', subject: 'Hello' } })
```

#### `useStorage(supabase, bucket)`

Supabase Storage operations.

```tsx
const { upload, download, getPublicUrl, list, remove, isLoading } = useStorage(supabase, 'avatars')

await upload('user-123.png', file, { upsert: true })
const url = getPublicUrl('user-123.png')
```

### Filters

Type-safe filter DSL matching Supabase's PostgREST operators:

```typescript
import {
  eq, neq, gt, gte, lt, lte,
  like, ilike, is, inValues,
  contains, containedBy, overlaps, textSearch,
  match, asc, desc,
} from '@drakkar.software/anchor'

// Comparison
eq('status', 'active')
neq('status', 'archived')
gt('priority', 3)
gte('priority', 3)
lt('priority', 10)
lte('priority', 10)

// Pattern matching
like('title', '%milk%')         // case-sensitive
ilike('title', '%milk%')        // case-insensitive

// Null/boolean check
is('deleted_at', null)

// Array/set operations
inValues('category', ['work', 'personal'])
contains('tags', ['urgent'])
containedBy('tags', ['urgent', 'important'])
overlaps('tags', ['urgent'])

// Full-text search
textSearch('body', 'hello & world', { type: 'websearch' })

// Match shorthand (multiple eq)
match({ status: 'active', priority: 1 })

// Advanced: not and filter with custom operator
// These accept { op, value } objects for the inner operator
{ column: 'status', op: 'not', value: { op: 'eq', value: 'archived' } }
{ column: 'priority', op: 'filter', value: { op: 'gt', value: 3 } }
```

### Fluent Query Builder

Alternative to filter arrays:

```typescript
import { query } from '@drakkar.software/anchor'

const result = await store.getState().fetch(
  query<Todo>()
    .where('status').eq('active')
    .where('priority').gte(3)
    .orderBy('created_at', 'desc')
    .limit(20)
    .build()
)
```

### Cursor Pagination

Efficient keyset pagination for large datasets:

```typescript
import { buildCursorQuery, processCursorResults } from '@drakkar.software/anchor'

const { filters, sort, limit } = buildCursorQuery<Todo>({
  cursorColumn: 'created_at',
  pageSize: 20,
  cursor: lastItem?.created_at,
  direction: 'forward',
})

const rows = await store.getState().fetch({ filters, sort, limit })
const { data, pagination } = processCursorResults(rows, { cursorColumn: 'created_at', pageSize: 20 })
// pagination.hasNextPage, pagination.cursor
```

### Offline-First

Mutations can be queued when offline and flushed on reconnect. This is **opt-in**, via
`offlineQueue.queueWrites`, and needs a `network` adapter to know when the server is
unreachable:

```typescript
const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos'],
  persistence: { adapter: new LocalStorageAdapter() },
  network: new WebNetworkStatus(),
  offlineQueue: { queueWrites: true },
})

// Offline, this resolves rather than throwing — the mutation is queued
const row = await stores.todos.getState().insert({ title: 'Offline todo' })

// …so the promise no longer tells you whether the server has it. The row does:
row._anchor_pending // 'insert' while queued, undefined once confirmed

stores.todos.getState().getQueueSize() // 1
await stores.todos.getState().flushQueue()
```

That last point is the reason the option is opt-in rather than the default. Without it, a
write that cannot reach the server rejects: a caller's `catch` fires and the optimistic row
disappears. With it, the same write resolves, and code that reads a resolved promise as
"the server has it" will report success for something only queued. Check `_anchor_pending`
on what the mutator returns.

`insert`, `update`, `upsert` and `remove` queue. `insertMany` and `removeWhere` do not, and
still roll back and throw — see their notes in `createTableStore.ts`.

`offlineQueue.maxRetries` defaults to **3**, and past it a mutation is `rolled_back` —
removed from local state, not merely abandoned. That default suits a write that can fail a
few times in a row and reasonably be given up on; it is very likely the wrong one for a
write that must never quietly disappear once the offline stretch it can be exposed to may
run to hours or days. Set it high enough that "we gave up and deleted this" cannot happen
within any offline duration the app is meant to tolerate, and drive "this still hasn't
sent" messaging off `useSyncStatus`'s `failedCount` instead — a read, not a reason to roll
anything back.

A join table granted only `select, insert, delete` — no `update` — needs
`ignoreDuplicates` on `upsert`: a plain upsert's `ON CONFLICT DO UPDATE` is refused
`42501` even on a conflict that would not actually change anything, because Postgres
checks UPDATE privilege for that clause regardless of whether one occurs.

```typescript
await stores.post_likes.getState().upsert(
  { post_id, profile_id },
  { onConflict: 'post_id,profile_id', ignoreDuplicates: true },
)
```

A `DO NOTHING` conflict returns no row to read back, so this resolves to the store's own
already-merged optimistic row (cleared of its pending flag) rather than throwing
`PGRST116` — "the server confirmed this already exists" is a success, not a failure to
roll back. Works the same way live and on a queued replay.

The queue supports:
- **Coalescing** — insert+update becomes single insert; insert+delete cancels both
- **Dependency tracking** — `dependsOn` field ensures parent mutations complete before children
- **Exponential backoff** — retries with `base * 2^attempt + jitter`
- **Rollback** — a write abandoned past `maxRetries` restores the row's previous state

### Conflict Resolution

Five built-in strategies, configurable per table:

```typescript
import { remoteWins, localWins, lastWriteWins, fieldLevelMerge } from '@drakkar.software/anchor'

createTableStore({
  // ...
  conflict: {
    strategy: 'last-write-wins',
    timestampColumn: 'updated_at',
  },
})

// Or field-level merge:
createTableStore({
  // ...
  conflict: {
    strategy: 'field-merge',
    serverOwnedFields: ['computed_score'],  // Always use server value
    clientOwnedFields: ['draft_content'],   // Always use local value
  },
})

// Or custom resolver:
createTableStore({
  // ...
  conflict: {
    strategy: 'custom',
    resolver: (local, remote, context) => ({
      ...remote,
      title: local.title,  // Keep local title, use remote for rest
    }),
  },
})
```

### Validation

Validate data before mutations:

```typescript
import { zodValidator } from '@drakkar.software/anchor'
import { z } from 'zod'

const todoSchema = z.object({
  title: z.string().min(1, 'Title required'),
  completed: z.boolean(),
})

createTableStore({
  // ...
  validate: {
    insert: zodValidator(todoSchema),
    update: zodValidator(todoSchema.partial()),
  },
})
```

### Concurrency Safety

The library handles concurrent operations safely:

- **Concurrent fetch()**: Uses a generation counter — stale responses from superseded fetches are discarded automatically
- **Concurrent mutations**: Uses compare-and-swap (CAS) rollback with `_anchor_mutationId` — a failed update only rolls back if its own optimistic write is still current, preventing it from destroying a concurrent successful mutation's data
- **Realtime during mutations**: Rows with `_anchor_pending` metadata are protected from being overwritten by realtime INSERT/UPDATE/DELETE events
- **Cross-tab sync**: Pending optimistic rows are preserved when receiving state from other tabs
- **Offline queue**: Flush uses a `flushing` guard to prevent concurrent execution, and in-place pruning preserves mutations enqueued during a flush

### Auth Integration

Session-gated stores with automatic clear/refetch:

```typescript
import { setupAuthGate, isRlsError } from '@drakkar.software/anchor'

const cleanup = setupAuthGate(supabase, stores.auth, [stores.todos, stores.profiles], {
  clearOnSignOut: true,    // Clear all stores when user signs out
  refetchOnSignIn: true,   // Refetch all stores when user signs in
})
```

### Auth Actions

The auth store owns the session and the five actions that change who is signed
in. The flows *around* it are free functions, for code with no store to read —
or no React at all:

```typescript
import {
  getSession, getUser,
  signUpWithPassword, signInWithPassword,
  updateUser, resendOtp,
  verifyOtp, sendPasswordRecovery,
} from '@drakkar.software/anchor'

// Sign up, then confirm from the emailed code
const { user, session } = await signUpWithPassword(supabase, {
  email, password, options: { emailRedirectTo: getWebAuthRedirectTo() },
})
// `session` is null when the project requires confirmation — not an error.
await verifyOtp(supabase, { email, token: code, type: 'signup' })
await resendOtp(supabase, { type: 'signup', email })   // "I didn't get the code"

// Change a password, after re-verifying the current one
await signInWithPassword(supabase, { email, password: currentPassword })
await updateUser(supabase, { password: newPassword })
```

None of them throws: each returns its result beside an `error` wrapped as an
`AnchorError`, so a caller branches on `.code` rather than on message prose.

### Incremental Sync

Delta fetch — only get rows changed since last sync:

```typescript
import { incrementalSync } from '@drakkar.software/anchor'

const { fetchedCount, mergedCount } = await incrementalSync(
  supabase, 'todos', 'id', stores.todos,
  { timestampColumn: 'updated_at' },
)
```

### Cache TTL

Stale-while-revalidate pattern:

```typescript
import { fetchWithSwr, setupAutoRevalidation, isStale } from '@drakkar.software/anchor'

// Serve stale data, refetch in background
await fetchWithSwr(stores.todos, { staleTTL: 5 * 60 * 1000 })

// Auto-revalidate every minute
const cleanup = setupAutoRevalidation(stores.todos, {
  staleTTL: 5 * 60 * 1000,
  checkInterval: 60 * 1000,
})
```

### Query Cache Strategy

Control how `fetch()` handles existing records — replace all (default) or merge into the cache:

```typescript
// Store-level: all fetches accumulate records
const todosStore = createTableStore({
  supabase,
  table: 'todos',
  cacheStrategy: 'merge', // 'replace' (default) | 'merge'
})

// In merge mode:
// - `records` accumulates all seen data (cache)
// - `order` reflects only the latest query (view)
await todosStore.getState().fetch()                                    // records: [1,2,3], order: [1,2,3]
await todosStore.getState().fetch({ filters: [eq('completed', true)] }) // records: [1,2,3], order: [2]

// Per-fetch override
await store.getState().fetch({
  filters: [eq('status', 'active')],
  cacheStrategy: 'merge', // override for this call only
})

// Invalidate accumulated cache
await store.getState().clearAndFetch()
```

Also available on `createSupabaseStores()`, globally and per relation through
`tableOptions` / `viewOptions`.

### Cross-Tab Sync

State changes sync across browser tabs:

```typescript
import { setupCrossTabSync } from '@drakkar.software/anchor'

const cleanup = setupCrossTabSync(store, 'todos')
// Uses BroadcastChannel, falls back to localStorage events
```

Or enable via store options:

```typescript
createTableStore({
  // ...
  crossTab: { enabled: true },
})
```

### App Lifecycle

Auto-flush queue, refresh auth, and revalidate stale data when the app returns to the foreground:

```typescript
import { setupAppLifecycle } from '@drakkar.software/anchor'
import { WebAppLifecycle } from '@drakkar.software/anchor-adapter-web'
// or: import { RNAppLifecycle } from '@drakkar.software/anchor-adapter-react-native'

const cleanup = setupAppLifecycle({
  adapter: new WebAppLifecycle(),
  stores: [stores.todos, stores.profiles],
  authStore: stores.auth,
  queue: offlineQueue,
  flushQueueOnForeground: true,     // default
  refreshAuthOnForeground: true,     // default
  revalidateOnForeground: true,      // default
  pauseRealtimeOnBackground: false,  // default
  staleTTL: 5 * 60 * 1000,          // 5 minutes
})
```

Or use the React hook:

```tsx
import { useAppLifecycle } from '@drakkar.software/anchor'

useAppLifecycle({
  adapter: new WebAppLifecycle(),
  stores: [stores.todos],
  authStore: stores.auth,
})
```

### Background Sync

Flush the offline queue in the background on mobile:

```typescript
import { setupBackgroundSync } from '@drakkar.software/anchor'
import { RNBackgroundSync } from '@drakkar.software/anchor-adapter-react-native'

const cleanup = await setupBackgroundSync(offlineQueue, new RNBackgroundSync())
// Cleanup: await cleanup()
```

### Multi-Device Sync

Sync state across devices via Supabase Realtime broadcast:

```typescript
import { setupMultiDeviceSync } from '@drakkar.software/anchor'

const cleanup = setupMultiDeviceSync(supabase, {
  todos: stores.todos,
  profiles: stores.profiles,
}, {
  conflict: { strategy: 'last-write-wins', timestampColumn: 'updated_at' },
  debounceMs: 1000,
})
```

### Selective Sync

Sync only relevant subsets of data:

```typescript
import { selectiveSync, syncAllByPriority } from '@drakkar.software/anchor'

// Sync only active todos
await selectiveSync(supabase, 'todos', 'id', stores.todos, {
  filters: [eq('status', 'active')],
  timestampColumn: 'updated_at',
})

// Sync stores in priority order
await syncAllByPriority([
  { store: stores.todos, priority: 1 },
  { store: stores.profiles, priority: 2 },
])
```

### Data Encryption

Transparently encrypt persisted data:

```typescript
import { EncryptedAdapter, createWebCryptoEncryption } from '@drakkar.software/anchor'
import { LocalStorageAdapter } from '@drakkar.software/anchor-adapter-web'

const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
const adapter = new EncryptedAdapter(new LocalStorageAdapter(), createWebCryptoEncryption(key))

createSupabaseStores({ persistence: { adapter } })
```

### Storage Quota

Monitor and manage storage usage:

```typescript
import { StorageQuotaManager } from '@drakkar.software/anchor'

const quota = new StorageQuotaManager()
const { count, estimatedBytes } = await quota.getUsage(adapter)

quota.setTableLimit('todos', 1000)
await quota.enforceLimit(adapter, 'todos')
```

### Schema Versioning

Automatic cache invalidation on schema changes:

```typescript
import { checkSchemaVersion } from '@drakkar.software/anchor'

const { versionChanged } = await checkSchemaVersion(adapter, 2)
// If version changed, all cached data is cleared and fetch() repopulates from Supabase
```

### Sync Status Hooks

Monitor sync status across stores:

```tsx
import { useSyncStatus, useQueueStatus, usePendingChanges } from '@drakkar.software/anchor'

function SyncBar() {
  const { status, pendingCount } = useSyncStatus([stores.todos, stores.profiles])
  // status: 'synced' | 'syncing' | 'offline' | 'error'

  return <div>{status} ({pendingCount} pending)</div>
}

function QueueInfo() {
  const { pendingCount, queueSize } = useQueueStatus(stores.todos)
  const pending = usePendingChanges(stores.todos)
  // pending: [{ id, row, mutationType: 'insert' | 'update' | 'delete' }]
}
```

### Sync Metrics

Track sync health for monitoring:

```typescript
import { SyncMetrics } from '@drakkar.software/anchor'

const metrics = new SyncMetrics()
createSupabaseStores({ logger: metrics })

const snap = metrics.getMetrics()
// snap.fetchLatencyP95, snap.mutationErrorCount, snap.conflictCount, ...
```

### Conflict Audit

Log and react to conflict resolutions:

```typescript
import { ConflictAuditLog } from '@drakkar.software/anchor'

const auditLog = new ConflictAuditLog()
auditLog.onConflict((entry) => {
  console.warn(`Conflict on ${entry.table}#${entry.rowId}: ${entry.strategy}`)
})

const log = auditLog.getLog({ table: 'todos', since: Date.now() - 60000 })
```

### Retry with Backoff

Wrap any async operation with exponential backoff and jitter:

```typescript
import { withRetry } from '@drakkar.software/anchor'

const result = await withRetry(() => createRpcAction(supabase, 'heavy_query')(), {
  maxRetries: 3,
  baseDelay: 1000,
})
```

### Circuit Breaker

Protect against cascading failures from repeatedly calling failing endpoints:

```typescript
import { CircuitBreaker } from '@drakkar.software/anchor'

const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 })

const result = await breaker.execute(() => fetch('/api/unstable'))
// After 5 failures: throws immediately without calling the function
// After 30s: allows one probe request (half-open state)
```

### Rate Limiter

Throttle requests using a token bucket algorithm:

```typescript
import { RateLimiter } from '@drakkar.software/anchor'

const limiter = new RateLimiter({ maxTokens: 10, refillRate: 2 }) // 10 burst, 2/sec refill

if (limiter.tryConsume()) {
  await fetch('/api/resource')
}
```

### Aggregation

Client-side and server-side aggregation:

```typescript
import { aggregateLocal, aggregateRpc } from '@drakkar.software/anchor'

// Client-side (on store data)
const stats = aggregateLocal(stores.todos, {
  total: 'count',
  avgPriority: { op: 'avg', column: 'priority' },
  maxPriority: { op: 'max', column: 'priority' },
})

// Server-side (via Postgres function)
const serverStats = await aggregateRpc(supabase, 'aggregate_todos', { user_id: '123' })
```

### Storage

Full Supabase Storage support:

```typescript
import { createStorageActions } from '@drakkar.software/anchor'

const avatars = createStorageActions(supabase, 'avatars')

await avatars.upload('user-123.png', file, { upsert: true })
const url = avatars.getPublicUrl('user-123.png')
const { signedUrl } = await avatars.createSignedUrl('private/doc.pdf', { expiresIn: 3600 })
const files = await avatars.list('uploads/')
await avatars.remove(['old-file.png'])
```

### Edge Functions

```typescript
import { createEdgeFunctionAction } from '@drakkar.software/anchor'

const sendEmail = createEdgeFunctionAction<{ success: boolean }>(supabase, 'send-email')
const result = await sendEmail({ body: { to: 'user@example.com', subject: 'Hello' } })
```

### RPC (Postgres Functions)

`createSchemaRpc` reads the function names, their arguments and their return
types out of the generated `Database`, so none of the three is written twice:

```typescript
import { createSchemaRpc } from '@drakkar.software/anchor'

const rpc = createSchemaRpc<Database>(supabase)   // supabase must be typed too

const { data, error } = await rpc('get_dashboard_stats', { user_id: '123' })
//      ^? the function's own Returns type

await rpc('get_dashboard_stats')     // error: the function declares arguments
await rpc('no_such_function')        // error: not in the schema
await rpc('current_user_is_admin')   // fine: generated as `Args: never`
```

Pass the schema as the second type argument for a `Database` with no `public`
key: `createSchemaRpc<Database, 'app'>(supabase)`.

`callRpc` and `createRpcAction` take the name as a plain string and the return
type as a type argument. They still work, and are what to use for a function the
generated types do not cover:

```typescript
import { createRpcAction } from '@drakkar.software/anchor'

const getStats = createRpcAction<DashboardStats>(supabase, 'get_dashboard_stats')
const { data, error } = await getStats({ user_id: '123' })
```

### Server Components (RSC)

Server-side prefetch for React Server Components:

```tsx
// app/todos/page.tsx (Server Component)
import { prefetch } from '@drakkar.software/anchor'

export default async function TodosPage() {
  const { data } = await prefetch<Todo>(supabase, 'todos', {
    sort: [{ column: 'created_at', ascending: false }],
    limit: 50,
  })

  return <TodoList initialData={data} />
}
```

### Platform Adapters

`createSupabaseStores`'s `persistence.keyPrefix` prepends a string to every table/view's
own default key (`anchor:${schema}:${table}`) — for namespacing one physical adapter
shared across tenants, environments, or a key-rotation migration, without having to
restate the schema/table part `createTableStore` already computes:

```typescript
createSupabaseStores({
  supabase,
  tables: ['todos'],
  persistence: { adapter: new LocalStorageAdapter(), keyPrefix: `tenant-${tenantId}:` },
})
```

#### Web

```typescript
import {
  LocalStorageAdapter, IndexedDBAdapter,
  WebNetworkStatus, WebAppLifecycle,
} from '@drakkar.software/anchor-adapter-web'

new LocalStorageAdapter()   // Small datasets (<5MB)
new IndexedDBAdapter()      // Large datasets
new WebNetworkStatus()      // Network detection
new WebAppLifecycle()       // App lifecycle (Page Visibility API)
```

#### React Native

```typescript
import {
  ExpoSqliteAdapter, AsyncStorageAdapter,
  RNNetworkStatus, RNAppLifecycle,
  RNBackgroundSync, createExpoOAuthHandler,
} from '@drakkar.software/anchor-adapter-react-native'
import * as SQLite from 'expo-sqlite'
import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo from '@react-native-community/netinfo'
import * as Linking from 'expo-linking'

// Each of these takes its underlying module as an argument, to avoid bundler
// resolution issues in pnpm virtual store environments.
new ExpoSqliteAdapter(SQLite)         // Structured (recommended)
new AsyncStorageAdapter(AsyncStorage) // Simple fallback
new RNNetworkStatus(NetInfo)          // Network detection
new RNAppLifecycle()                  // App lifecycle (AppState API)
new RNBackgroundSync()                // Background task (expo-task-manager)
createExpoOAuthHandler(supabase, Linking)  // OAuth with deep links
```

### Middleware

#### Devtools

```typescript
createTableStore({
  // ...
  devtools: true,
  // or with custom name:
  devtools: { name: 'todos-store' },
})
```

#### Immer

```typescript
import { immer } from 'zustand/middleware/immer'

createTableStore({
  // ...
  immer, // Pass the middleware function
})
```

## Packages

| Package | Description |
|---------|-------------|
| `@drakkar.software/anchor` | Core library |
| `@drakkar.software/anchor-adapter-web` | Web: localStorage, IndexedDB, WebNetworkStatus, WebAppLifecycle |
| `@drakkar.software/anchor-adapter-react-native` | React Native: expo-sqlite, AsyncStorage, NetInfo, AppLifecycle, BackgroundSync, OAuth |

## Tree-Shakeable Imports

```typescript
// Full API
import { createTableStore, useQuery, eq } from '@drakkar.software/anchor'

// Hooks only
import { useQuery, useMutation, useSyncStatus } from '@drakkar.software/anchor/hooks'

// Client only
import { createAnchorClient, type AnchorClient } from '@drakkar.software/anchor/client'

// Auth actions only (no store, no React)
import { getSession, updateUser } from '@drakkar.software/anchor/auth/actions'

// Query builder only
import { query, QueryBuilder } from '@drakkar.software/anchor/query/queryBuilder'

// Server-only (no React dependency)
import { prefetch } from '@drakkar.software/anchor/server/prefetch'

// Storage only
import { createStorageActions } from '@drakkar.software/anchor/storage/storageActions'

// New entry points
import { setupAppLifecycle } from '@drakkar.software/anchor/lifecycle'
import { setupBackgroundSync } from '@drakkar.software/anchor/sync/background'
import { selectiveSync } from '@drakkar.software/anchor/sync/selective'
import { setupMultiDeviceSync } from '@drakkar.software/anchor/sync/multiDevice'
import { SyncMetrics } from '@drakkar.software/anchor/sync/metrics'
import { EncryptedAdapter } from '@drakkar.software/anchor/persistence/encrypted'
import { StorageQuotaManager } from '@drakkar.software/anchor/persistence/quota'
import { checkSchemaVersion } from '@drakkar.software/anchor/persistence/schemaVersion'
import { ConflictAuditLog } from '@drakkar.software/anchor/mutation/audit'
import { invokeEdgeFunction } from '@drakkar.software/anchor/functions'
import { fetchWithSwr } from '@drakkar.software/anchor/cache'
import { setupAuthGate } from '@drakkar.software/anchor/auth/gate'
import { buildCursorQuery } from '@drakkar.software/anchor/query/pagination'
import { incrementalSync } from '@drakkar.software/anchor/sync/incremental'
```

Every entry point the build produces is reachable — `src/__tests__/packageExports.test.ts`
asserts it. Until 3.0.0 eight of the 26 were not, including three named in this
very list, and `exports` is an allowlist: a path missing from it throws
`ERR_PACKAGE_PATH_NOT_EXPORTED` however complete `dist/` is.

## Requirements

- **zustand** >= 4.5.0
- **@supabase/supabase-js** — a dependency since 3.1.0, installed with Anchor.
  You no longer name it yourself; `createAnchorClient` creates the client and
  the types it needs (`SupabaseClient`, `Session`, `User`, `PostgrestError`, …)
  are re-exported from the root.
- **TypeScript** >= 5.0 (recommended)
- **React** >= 18.0 (optional, for hooks)
- **immer** (optional, for draft-based mutations)

## License

MIT
