/**
 * Example: Setting up anchor stores for a Todo app.
 *
 * This file creates typed stores for all tables with:
 * - Offline-first persistence (localStorage)
 * - Realtime subscriptions with conflict resolution
 * - Network status detection
 * - Redux DevTools integration
 * - App lifecycle management (auto-flush, revalidation on foreground)
 * - Sync health monitoring
 * - Cache strategy (merge mode)
 * - Custom extensions (computed values + actions)
 */
import { createClient } from "@supabase/supabase-js"
import {
  createSupabaseStores,
  createTableStore,
  setupAuthGate,
  SyncMetrics,
  isPending,
  eq,
  gt,
} from "@drakkar.software/anchor"
import { setupAppLifecycle } from "@drakkar.software/anchor/lifecycle"
import { LocalStorageAdapter, WebNetworkStatus, WebAppLifecycle } from "@drakkar.software/anchor-adapter-web"
import type { Database } from "./database.types"

// ─── Supabase Client ─────────────────────────────────────────────────

// VITE_SUPABASE_PUBLISHABLE_KEY: sb_publishable_... (new format) or the legacy anon key
const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
)

// ─── Sync Metrics ────────────────────────────────────────────────────

export const syncMetrics = new SyncMetrics()

// ─── Option A: Quick setup with createSupabaseStores ─────────────────

export const stores = createSupabaseStores<Database>({
  supabase,
  tables: ["todos", "profiles"],
  // A view is how a join reaches a store: `records` is keyed on a primary key
  // and realtime writes the flat postgres_changes payload into it, so an
  // embedded child collection is dropped by the first event after a fetch. A
  // view is flat, so it survives. Read-only, and no realtime — Postgres
  // publishes changes under the underlying table's name, so a channel on the
  // view's name would register and never fire.
  views: ["todo_summary"],
  persistence: { adapter: new LocalStorageAdapter() },
  network: new WebNetworkStatus(),
  realtime: { enabled: true },
  devtools: import.meta.env.DEV,
  logger: syncMetrics,
  tableOptions: {
    todos: {
      defaultSort: [{ column: "created_at", ascending: false }],
      realtime: {
        events: ["INSERT", "UPDATE", "DELETE"],
        // Server-side column projection (realtime-js 2.109.0): only these
        // columns are sent over the wire. Must include the primary key.
        select: ["id", "title", "completed", "priority", "updated_at"],
        // Typed filter built from Anchor's own FilterDescriptor DSL instead
        // of a hand-written PostgREST filter string.
        filter: [gt("priority", 0)],
      },
      cacheStrategy: "merge", // accumulate records across filtered fetches
      conflict: {
        strategy: "last-write-wins",
        timestampColumn: "updated_at",
      },
    },
    profiles: {
      realtime: { enabled: false },
    },
  },
  viewOptions: {
    // Name the column that identifies a row. Every view column is nullable in
    // the generated types, so the default "id" is not safe to lean on — and a
    // row that reaches the store without its key fails the fetch rather than
    // collapsing onto another row's record.
    todo_summary: {
      primaryKey: "user_id",
      defaultSort: [{ column: "open_count", ascending: false }],
    },
  },
})

// Set up auth-gated stores: clear on sign-out, refetch on sign-in
setupAuthGate(supabase, stores.auth, [stores.todos, stores.profiles], {
  clearOnSignOut: true,
  refetchOnSignIn: true,
})

// ─── App Lifecycle ───────────────────────────────────────────────────
// Auto-flush queue, refresh auth, revalidate stale data on foreground

export const cleanupLifecycle = setupAppLifecycle({
  adapter: new WebAppLifecycle(),
  stores: [stores.todos, stores.profiles],
  authStore: stores.auth,
  flushQueueOnForeground: true,
  refreshAuthOnForeground: true,
  revalidateOnForeground: true,
  staleTTL: 5 * 60 * 1000, // 5 minutes
})

// ─── Option B: Single store with extensions ──────────────────────────

type TodoRow = Database["public"]["Tables"]["todos"]["Row"]
type TodoInsert = Database["public"]["Tables"]["todos"]["Insert"]
type TodoUpdate = Database["public"]["Tables"]["todos"]["Update"]

type TodoExtensions = {
  completedCount: () => number
  pendingCount: () => number
  toggleComplete: (id: string) => Promise<void>
  clearCompleted: () => Promise<void>
}

export const todosStore = createTableStore<
  Database,
  TodoRow,
  TodoInsert,
  TodoUpdate,
  TodoExtensions
>({
  supabase,
  table: "todos",
  primaryKey: "id",
  defaultSort: [{ column: "created_at", ascending: false }],
  persistence: { adapter: new LocalStorageAdapter() },
  // Note: realtime, conflict, network, and offlineQueue options require
  // createSupabaseStores(). For standalone stores, use manual setup with
  // RealtimeManager + bindRealtimeToStore, or use createSupabaseStores above.
  devtools: { name: "todos" },
  crossTab: { enabled: true },
  validate: {
    insert: (data) =>
      data.title && data.title.length > 0
        ? true
        : ["Title is required"],
  },
  extend: (_set, get, _store, _supabase) => ({
    completedCount: () =>
      [...get().records.values()].filter((t) => t.completed).length,

    pendingCount: () =>
      [...get().records.values()].filter((t) => isPending(t)).length,

    toggleComplete: async (id: string) => {
      const todo = get().records.get(id)
      if (todo) {
        await get().update(id, { completed: !todo.completed })
      }
    },

    clearCompleted: async () => {
      const completed = [...get().records.entries()].filter(
        ([, t]) => t.completed,
      )
      for (const [id] of completed) {
        await get().remove(id)
      }
    },
  }),
})
