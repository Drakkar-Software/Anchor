<p align="center">
  <img src="https://raw.githubusercontent.com/Drakkar-Software/Anchor/main/logo.png" alt="Anchor" width="200" />
</p>

<h1 align="center">Anchor - React Native Adapter</h1>

<p align="center">React Native platform adapters for <a href="https://www.npmjs.com/package/@drakkar.software/anchor">Anchor</a> (expo-sqlite, AsyncStorage, network, lifecycle, background sync, OAuth).</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@drakkar.software/anchor-adapter-react-native"><img src="https://img.shields.io/npm/v/@drakkar.software/anchor-adapter-react-native" alt="npm" /></a>
  <a href="https://github.com/Drakkar-Software/Anchor/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@drakkar.software/anchor-adapter-react-native" alt="license" /></a>
</p>

## Installation

```bash
npm install @drakkar.software/anchor @drakkar.software/anchor-adapter-react-native zustand @supabase/supabase-js
```

Install the peer dependencies you need:

```bash
# Persistence (pick one or both)
npx expo install expo-sqlite
npm install @react-native-async-storage/async-storage

# Network detection
npm install @react-native-community/netinfo

# Background sync
npx expo install expo-task-manager expo-background-fetch

# OAuth deep links
npx expo install expo-linking
```

All peer dependencies are optional -- install only the ones your app uses.

## Adapters

### `ExpoSqliteAdapter`

Persistence adapter backed by `expo-sqlite`. Recommended for structured data and larger datasets.

Takes the `expo-sqlite` module as its first argument -- to avoid bundler
resolution issues in pnpm virtual store environments, the same reason
`RNNetworkStatus` and `createExpoOAuthHandler` below take `NetInfo`/`Linking` the
same way -- and an optional database name (defaults to `"anchor"`).

```typescript
import { ExpoSqliteAdapter } from '@drakkar.software/anchor-adapter-react-native'
import * as SQLite from 'expo-sqlite'

createSupabaseStores({
  persistence: { adapter: new ExpoSqliteAdapter(SQLite, 'my-app-cache') },
})
```

### `AsyncStorageAdapter`

Persistence adapter backed by `@react-native-async-storage/async-storage`. Simple key-value fallback.

```typescript
import { AsyncStorageAdapter } from '@drakkar.software/anchor-adapter-react-native'

createSupabaseStores({
  persistence: { adapter: new AsyncStorageAdapter() },
})
```

### `RNNetworkStatus`

Detects online/offline state using `@react-native-community/netinfo`. Enables automatic offline queue flush on reconnect.

Takes the NetInfo default export as its argument, for the same bundler-resolution
reason `ExpoSqliteAdapter` above takes the `expo-sqlite` module.

```typescript
import { RNNetworkStatus } from '@drakkar.software/anchor-adapter-react-native'
import NetInfo from '@react-native-community/netinfo'

createSupabaseStores({
  network: new RNNetworkStatus(NetInfo),
})
```

### `RNAppLifecycle`

Detects foreground/background transitions using React Native's `AppState` API. Enables auto-revalidation and queue flush when the app returns to the foreground.

```typescript
import { RNAppLifecycle } from '@drakkar.software/anchor-adapter-react-native'
import { setupAppLifecycle } from '@drakkar.software/anchor'

setupAppLifecycle({
  adapter: new RNAppLifecycle(),
  stores: [stores.todos, stores.profiles],
})
```

### `RNBackgroundSync`

Flushes the offline mutation queue in the background using `expo-task-manager` and `expo-background-fetch`.

```typescript
import { RNBackgroundSync } from '@drakkar.software/anchor-adapter-react-native'
import { setupBackgroundSync } from '@drakkar.software/anchor'

await setupBackgroundSync(offlineQueue, new RNBackgroundSync())
```

### `createExpoOAuthHandler`

Handles OAuth flows with Supabase using Expo deep links (`expo-linking`).

Takes the `expo-linking` module as its second argument, for the same
bundler-resolution reason as the adapters above.

```typescript
import { createExpoOAuthHandler } from '@drakkar.software/anchor-adapter-react-native'
import * as Linking from 'expo-linking'

const oauth = createExpoOAuthHandler(supabase, Linking)
const { url } = await oauth.signInWithProvider('google')
```

## Full Example

```typescript
import { createClient } from '@supabase/supabase-js'
import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo from '@react-native-community/netinfo'
import * as SQLite from 'expo-sqlite'
import { createSupabaseStores, setupAppLifecycle, setupBackgroundSync } from '@drakkar.software/anchor'
import {
  ExpoSqliteAdapter, RNNetworkStatus, RNAppLifecycle, RNBackgroundSync,
} from '@drakkar.software/anchor-adapter-react-native'
import type { Database } from './database.types'

// SUPABASE_PUBLISHABLE_KEY: sb_publishable_... (new format) or the legacy anon key.
// `auth.storage`/`autoRefreshToken`/`persistSession`/`detectSessionInUrl` are supabase-js
// client options -- Anchor's AsyncStorageAdapter above is for *table* persistence only and
// does not wire auth session storage; set this up yourself as shown here.
const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})

const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos', 'profiles'],
  persistence: { adapter: new ExpoSqliteAdapter(SQLite) },
  network: new RNNetworkStatus(NetInfo),
  realtime: { enabled: true },
})

setupAppLifecycle({
  adapter: new RNAppLifecycle(),
  stores: [stores.todos, stores.profiles],
  authStore: stores.auth,
})

await setupBackgroundSync(offlineQueue, new RNBackgroundSync())
```

## Related Packages

| Package | Description |
|---------|-------------|
| [`@drakkar.software/anchor`](https://www.npmjs.com/package/@drakkar.software/anchor) | Core library |
| [`@drakkar.software/anchor-adapter-web`](https://www.npmjs.com/package/@drakkar.software/anchor-adapter-web) | Web adapters |

## Documentation

Full documentation: [github.com/Drakkar-Software/Anchor](https://github.com/Drakkar-Software/Anchor)

## License

MIT
