<p align="center">
  <img src="https://raw.githubusercontent.com/Drakkar-Software/Anchor/main/logo.png" alt="Anchor" width="200" />
</p>

<h1 align="center">Anchor - Web Adapter</h1>

<p align="center">Web platform adapters for <a href="https://www.npmjs.com/package/@drakkar.software/anchor">Anchor</a> (localStorage, IndexedDB, network & lifecycle detection).</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@drakkar.software/anchor-adapter-web"><img src="https://img.shields.io/npm/v/@drakkar.software/anchor-adapter-web" alt="npm" /></a>
  <a href="https://github.com/Drakkar-Software/Anchor/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@drakkar.software/anchor-adapter-web" alt="license" /></a>
</p>

## Installation

```bash
npm install @drakkar.software/anchor @drakkar.software/anchor-adapter-web zustand @supabase/supabase-js
```

## Adapters

### `LocalStorageAdapter`

Persistence adapter backed by `localStorage`. Best for small datasets (<5 MB).

```typescript
import { LocalStorageAdapter } from '@drakkar.software/anchor-adapter-web'

createSupabaseStores({
  persistence: { adapter: new LocalStorageAdapter() },
})
```

### `IndexedDBAdapter`

Persistence adapter backed by IndexedDB. Recommended for larger datasets.

```typescript
import { IndexedDBAdapter } from '@drakkar.software/anchor-adapter-web'

createSupabaseStores({
  persistence: { adapter: new IndexedDBAdapter() },
})
```

### `WebNetworkStatus`

Detects online/offline state using `navigator.onLine` and network events. Enables automatic offline queue flush on reconnect.

```typescript
import { WebNetworkStatus } from '@drakkar.software/anchor-adapter-web'

createSupabaseStores({
  network: new WebNetworkStatus(),
})
```

### `WebAppLifecycle`

Detects foreground/background transitions using the Page Visibility API. Enables auto-revalidation and queue flush when the app returns to the foreground.

```typescript
import { WebAppLifecycle } from '@drakkar.software/anchor-adapter-web'
import { setupAppLifecycle } from '@drakkar.software/anchor'

setupAppLifecycle({
  adapter: new WebAppLifecycle(),
  stores: [stores.todos, stores.profiles],
})
```

## Full Example

```typescript
import { createClient } from '@supabase/supabase-js'
import { createSupabaseStores } from '@drakkar.software/anchor'
import { LocalStorageAdapter, WebNetworkStatus } from '@drakkar.software/anchor-adapter-web'
import type { Database } from './database.types'

// SUPABASE_PUBLISHABLE_KEY: sb_publishable_... (new format) or the legacy anon key
const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)

const stores = createSupabaseStores<Database>({
  supabase,
  tables: ['todos', 'profiles'],
  persistence: { adapter: new LocalStorageAdapter() },
  network: new WebNetworkStatus(),
  realtime: { enabled: true },
})
```

## Related Packages

| Package | Description |
|---------|-------------|
| [`@drakkar.software/anchor`](https://www.npmjs.com/package/@drakkar.software/anchor) | Core library |
| [`@drakkar.software/anchor-adapter-react-native`](https://www.npmjs.com/package/@drakkar.software/anchor-adapter-react-native) | React Native adapters |

## Documentation

Full documentation: [github.com/Drakkar-Software/Anchor](https://github.com/Drakkar-Software/Anchor)

## License

MIT
