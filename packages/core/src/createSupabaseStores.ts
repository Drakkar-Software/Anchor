import type { SupabaseClient } from "@supabase/supabase-js"
import type { StoreApi } from "zustand"
import type {
  CreateSupabaseStoresOptions,
  SupabaseStores,
  TableStore,
} from "./types.js"
import { createTableStore } from "./createTableStore.js"
import { createAuthStore } from "./auth/authStore.js"
import { RealtimeManager } from "./realtime/realtimeManager.js"
import { bindRealtimeToStore } from "./realtime/realtimeBindings.js"
import { OfflineQueue } from "./mutation/offlineQueue.js"
import { createMutationExecutor } from "./mutation/mutationPipeline.js"
import { setupAuthGate } from "./auth/authGate.js"

/**
 * Creates typed stores for all specified tables in a Supabase Database.
 *
 * @example
 * ```typescript
 * const stores = createSupabaseStores<Database>({
 *   supabase,
 *   tables: ['todos', 'profiles'],
 *   persistence: { adapter: new LocalStorageAdapter() },
 *   realtime: { enabled: true },
 * })
 *
 * // Fully typed:
 * stores.todos.getState().insert({ title: 'Buy milk' })
 * ```
 */
export function createSupabaseStores<
  DB,
  SchemaName extends string & keyof DB = "public" & keyof DB,
>(
  options: CreateSupabaseStoresOptions<DB, SchemaName>,
): SupabaseStores<DB, SchemaName> {
  const {
    supabase,
    schema,
    tables,
    persistence,
    network,
    realtime,
    conflict,
    immer,
    devtools,
    logger,
    tableOptions = {},
    tableOrder,
    fetchRemoteOnBoot = true,
    auth = true,
    authGate: authGateOpts,
  } = options

  // Shared instances
  const realtimeManager = new RealtimeManager({
    supabase: supabase as SupabaseClient,
    logger,
  })

  const offlineQueue = new OfflineQueue({
    adapter: persistence?.adapter,
    network,
    logger,
  })

  // Cleanup functions
  const cleanupFns: (() => void)[] = []

  // Create stores for each table
  const stores: Record<string, StoreApi<TableStore<any, any, any>>> = {}

  const orderedTables = tableOrder ?? tables
  for (const tableName of orderedTables) {
    const tableOpts = (tableOptions as Record<string, any>)[
      tableName as string
    ] as Record<string, unknown> | undefined

    const store = createTableStore<DB, any, any, any>({
      supabase,
      table: tableName as string,
      schema: schema as string | undefined,
      primaryKey: (tableOpts?.primaryKey as string) ?? "id",
      defaultFilters: tableOpts?.defaultFilters as any,
      defaultSort: tableOpts?.defaultSort as any,
      defaultSelect: tableOpts?.defaultSelect as string,
      persistence: persistence
        ? { adapter: persistence.adapter }
        : undefined,
      network,
      conflict: (tableOpts?.conflict as any) ?? conflict,
      cacheStrategy: (tableOpts?.cacheStrategy as any) ?? options.cacheStrategy,
      immer,
      devtools,
      logger,
      _queue: offlineQueue,
    })

    stores[tableName as string] = store

    // Register mutation executor for offline queue
    offlineQueue.registerExecutor(
      tableName as string,
      createMutationExecutor(
        supabase as SupabaseClient,
        tableName as string,
        (tableOpts?.primaryKey as string) ?? "id",
        store,
        tableOpts?.defaultSelect as string,
        schema as string | undefined,
      ),
    )

    // Set up realtime if enabled
    const tableRealtime = (tableOpts?.realtime as any) ?? realtime
    if (tableRealtime?.enabled) {
      const unsubscribe = bindRealtimeToStore(
        realtimeManager,
        store,
        {
          table: tableName as string,
          schema: schema as string | undefined,
          primaryKey: (tableOpts?.primaryKey as string) ?? "id",
          events: tableRealtime.events,
          filter: tableRealtime.filter,
          conflict: (tableOpts?.conflict as any) ?? conflict,
          getPendingMutations: (t) => offlineQueue.pendingMutations.filter((m) => m.table === t),
        },
      )
      cleanupFns.push(unsubscribe)
    }
  }

  // Create auth store
  const authStore = auth
    ? createAuthStore({ supabase: supabase as SupabaseClient, devtools: !!devtools })
    : createAuthStore({ supabase: supabase as SupabaseClient })

  // Wire auth gate with shared realtime + queue instances
  if (auth) {
    const tableStoreList = Object.values(stores) as StoreApi<TableStore<any, any, any>>[]
    const unsubAuthGate = setupAuthGate(
      supabase as SupabaseClient,
      authStore,
      tableStoreList,
      {
        ...authGateOpts,
        realtimeManager,
        offlineQueue,
        onAuthChange: (_event, session) => {
          // Keep offline queue's userId in sync with current auth
          const userId = (session as any)?.user?.id as string | undefined
          offlineQueue.setUserId(userId)
        },
      },
    )
    cleanupFns.push(unsubAuthGate)

    // Set initial userId from auth store state
    const initialUser = authStore.getState().user
    if (initialUser?.id) {
      offlineQueue.setUserId(initialUser.id)
    }
  }

  // Hydrate offline queue
  offlineQueue.hydrate().then(() => {
    offlineQueue.startAutoFlush()
  }).catch((err) => {
    logger?.fetchError?.("__queue", err instanceof Error ? err.message : String(err))
  })

  // Fetch remote data on boot
  if (fetchRemoteOnBoot) {
    for (const tableName of orderedTables) {
      stores[tableName as string]?.getState().fetch().catch((err: unknown) => {
        logger?.fetchError?.(tableName as string, err instanceof Error ? err.message : String(err))
      })
    }
  }

  // Build the result object
  const result = {
    ...stores,
    auth: authStore,
    _supabase: supabase,
    _destroy: () => {
      for (const fn of cleanupFns) fn()
      // Clean up cross-tab sync for each store
      for (const tableName of orderedTables) {
        const s = stores[tableName as string] as any
        if (s?._destroyCrossTab) s._destroyCrossTab()
      }
      realtimeManager.destroy()
      offlineQueue.destroy()
    },
  } as SupabaseStores<DB, SchemaName>

  return result
}
