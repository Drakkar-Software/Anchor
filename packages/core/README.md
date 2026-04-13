<p align="center">
  <img src="https://raw.githubusercontent.com/Drakkar-Software/Anchor/main/logo.png" alt="Anchor" width="200" />
</p>

<h1 align="center">Anchor</h1>

<p align="center">Type-safe Zustand stores auto-generated from your Supabase schema. Offline-first, realtime, with optimistic updates.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@drakkar.software/anchor"><img src="https://img.shields.io/npm/v/@drakkar.software/anchor" alt="npm" /></a>
  <a href="https://github.com/Drakkar-Software/Anchor/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@drakkar.software/anchor" alt="license" /></a>
</p>

## Features

- **Auto-generated, type-safe stores** from Supabase `Database` types
- **Optimistic mutations** with automatic rollback, validation, and conflict resolution
- **Offline-first** with persistent queue, coalescing, dependency tracking, and auto-flush on reconnect
- **Realtime & sync** -- Supabase subscriptions, cross-tab, multi-device, incremental and selective sync
- **Caching** -- query cache strategy, cursor pagination, infinite scroll, stale-while-revalidate
- **Auth, RSC & Suspense** -- session-gated stores, RLS awareness, server prefetch, React Suspense
- **Resilience** -- retry with backoff, circuit breaker, rate limiter, encryption at rest, storage quota
- **Full Supabase coverage** -- Storage, Edge Functions, RPC, aggregation

## Installation

```bash
npm install @drakkar.software/anchor zustand @supabase/supabase-js
```

Platform adapters (pick one or both):

```bash
# Web (localStorage, IndexedDB)
npm install @drakkar.software/anchor-adapter-web

# React Native (expo-sqlite, AsyncStorage, background sync)
npm install @drakkar.software/anchor-adapter-react-native
```

## Quick Start

```typescript
import { createClient } from '@supabase/supabase-js'
import { createSupabaseStores } from '@drakkar.software/anchor'
import { LocalStorageAdapter, WebNetworkStatus } from '@drakkar.software/anchor-adapter-web'
import type { Database } from './database.types'

const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY)

const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos', 'profiles'],
  persistence: { adapter: new LocalStorageAdapter() },
  network: new WebNetworkStatus(),
  realtime: { enabled: true },
})
```

```tsx
import { useQuery, useMutation, eq, isPending } from '@drakkar.software/anchor'

function TodoList() {
  const { data, isLoading } = useQuery(stores.todos, {
    filters: [eq('completed', false)],
  })
  const { insert, remove } = useMutation(stores.todos)

  return (
    <ul>
      {data.map(todo => (
        <li key={todo.id}>
          {todo.title}
          {isPending(todo) && <span> (saving...)</span>}
          <button onClick={() => remove(todo.id)}>Delete</button>
        </li>
      ))}
      <button onClick={() => insert({ title: 'New todo' })}>Add</button>
    </ul>
  )
}
```

## What's Included

| Category | Highlights |
|----------|-----------|
| **Store factories** | `createTableStore`, `createSupabaseStores`, `createViewStore` |
| **Mutations** | Optimistic insert/update/upsert/remove, batch ops, offline queue |
| **Query** | Filter DSL (`eq`, `gt`, `ilike`, ...), fluent builder, cursor pagination |
| **Hooks** | `useQuery`, `useMutation`, `useAuth`, `useRealtime`, `useInfiniteQuery`, `useSuspenseQuery`, `useLinkedQuery` (with `staleTime`, `initialData`, `mergeToStore`), `useRpc`, `useEdgeFunction`, `useStorage`, `useSyncStatus` |
| **Sync** | Cross-tab, multi-device, incremental, selective, background |
| **Conflict resolution** | `remote-wins`, `local-wins`, `last-write-wins`, `field-merge`, custom |
| **Persistence** | Pluggable adapters, encrypted storage, schema versioning, quota management |
| **Auth** | Auth store, session gate, RLS error detection |
| **Resilience** | Retry with backoff, circuit breaker, rate limiter |
| **Server** | RSC prefetch, RPC actions, Edge Functions |

## `useLinkedQuery` — joins & complex queries with SWR

Use when you need a custom Supabase query (join, aggregation, complex select) that should still react to optimistic mutations on related stores.

```tsx
const { data, isLoading } = useLinkedQuery(
  () => supabase.from('offers').select('*, applications(*)').eq('id', offerId).single(),
  {
    stores: [stores.applications], // re-fetch when applications change
    deps: [offerId],
    enabled: !!offerId,
    staleTime: 30_000,             // skip refetch if data is <30s old
    initialData: () => stores.offers.getState().records.get(offerId), // instant cache
    mergeToStore: stores.offers,   // write results back so detail views get initialData
  },
)
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `stores` | `[]` | Zustand table stores to watch — refetches when any store's records change |
| `deps` | `[]` | Additional React deps (like filter params) that trigger a refetch |
| `enabled` | `true` | Disable fetching conditionally |
| `initialData` | — | Seed data before first fetch (value or `() => T \| undefined`). With initial data, `isLoading` starts `false` and the fetch fires in the background (SWR). |
| `mergeToStore` | — | Write array results into this store via `mergeRecords()` — list queries populate the store so detail views can use `initialData` |
| `staleTime` | `0` | ms before cached data is considered stale. Fresh data → refetch skipped, `isLoading` stays `false`. Store mutations always bypass this guard. Combine with `queryKey` for cross-remount SWR. |
| `queryKey` | — | Stable string key for cross-remount SWR. When set with `staleTime > 0`, data and fetch timestamp survive component unmount — back-navigation won't re-fetch fresh data. Must be unique per query (e.g. `"offers:${userId}"`). |

## Tree-Shakeable Imports

```typescript
import { createTableStore, useQuery, eq } from '@drakkar.software/anchor'
import { useQuery, useMutation } from '@drakkar.software/anchor/hooks'
import { setupAppLifecycle } from '@drakkar.software/anchor/lifecycle'
import { setupBackgroundSync } from '@drakkar.software/anchor/sync/background'
import { EncryptedAdapter } from '@drakkar.software/anchor/persistence/encrypted'
import { prefetch } from '@drakkar.software/anchor/server/prefetch'
```

## Related Packages

| Package | Description |
|---------|-------------|
| [`@drakkar.software/anchor-adapter-web`](https://www.npmjs.com/package/@drakkar.software/anchor-adapter-web) | Web: localStorage, IndexedDB, network & lifecycle adapters |
| [`@drakkar.software/anchor-adapter-react-native`](https://www.npmjs.com/package/@drakkar.software/anchor-adapter-react-native) | React Native: expo-sqlite, AsyncStorage, NetInfo, background sync, OAuth |

## Documentation

Full documentation and API reference: [github.com/Drakkar-Software/Anchor](https://github.com/Drakkar-Software/Anchor)

## License

MIT
