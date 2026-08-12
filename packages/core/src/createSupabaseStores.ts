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
    views = [],
    persistence,
    network,
    realtime,
    conflict,
    immer,
    devtools,
    logger,
    tableOptions = {},
    viewOptions = {},
    tableOrder,
    fetchRemoteOnBoot = true,
    auth = true,
    authGate: authGateOpts,
  } = options

  // Both loops write into one flat map, views second, so a name in both lists
  // would leave `stores.foo` pointing at the read-only store while realtime and
  // the offline-queue executor stayed wired to the writable one nobody holds —
  // every write rejected with `Cannot mutate view`, live updates landing
  // nowhere, and two boot fetches for the same relation. Refuse it instead.
  const duplicated = (views as string[]).filter((v) =>
    (tables as string[]).includes(v),
  )
  if (duplicated.length > 0) {
    throw new Error(
      `createSupabaseStores: ${duplicated.map((d) => `"${d}"`).join(", ")} ` +
      `named in both "tables" and "views". A relation belongs to one of them.`,
    )
  }

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
      defaultQueryFn: tableOpts?.defaultQueryFn as any,
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
          select: tableRealtime.select,
          conflict: (tableOpts?.conflict as any) ?? conflict,
          getPendingMutations: (t) => offlineQueue.pendingMutations.filter((m) => m.table === t),
        },
      )
      cleanupFns.push(unsubscribe)
    }
  }

  // Views. Same store, same persistence, same auth gate — but no offline-queue
  // *executor*, because a view is not writable, and no realtime subscription,
  // because Postgres publishes changes under the underlying table's name and a
  // channel on the view's name would simply never fire.
  //
  // The queue itself is still handed over. Nothing can enqueue for a view (all
  // four mutators are behind `assertNotView`), so `getQueueSize()` is a truthful
  // 0 rather than a hardcoded one, `flushQueue()` flushes the shared queue like
  // it does from any other store instead of resolving to nothing, and the
  // factory stops warning that options it passed itself "require
  // createSupabaseStores()" — that warning is gated on the queue being absent.
  for (const viewName of views) {
    const viewOpts = (viewOptions as Record<string, any>)[viewName as string] as
      | Record<string, unknown>
      | undefined

    stores[viewName as string] = createTableStore<DB, any, any, any>({
      supabase,
      table: viewName as string,
      schema: schema as string | undefined,
      isView: true,
      primaryKey: (viewOpts?.primaryKey as string) ?? "id",
      defaultFilters: viewOpts?.defaultFilters as any,
      defaultSort: viewOpts?.defaultSort as any,
      defaultSelect: viewOpts?.defaultSelect as string,
      defaultQueryFn: viewOpts?.defaultQueryFn as any,
      persistence: persistence ? { adapter: persistence.adapter } : undefined,
      network,
      cacheStrategy: (viewOpts?.cacheStrategy as any) ?? options.cacheStrategy,
      immer,
      devtools,
      logger,
      _queue: offlineQueue,
    })
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
    for (const name of [...orderedTables, ...views]) {
      stores[name as string]?.getState().fetch().catch((err: unknown) => {
        logger?.fetchError?.(name as string, err instanceof Error ? err.message : String(err))
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
      for (const name of [...orderedTables, ...views]) {
        const s = stores[name as string] as any
        if (s?._destroyCrossTab) s._destroyCrossTab()
      }
      realtimeManager.destroy()
      offlineQueue.destroy()
    },
  } as SupabaseStores<DB, SchemaName>

  return result
}
