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
    offlineQueue: offlineQueueOpts,
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

  // Declared before the queue because `onRollback` closes over it. Nothing
  // reads it until a flush, which is long after both loops below have filled it.
  const stores: Record<string, StoreApi<TableStore<any, any, any>>> = {}

  const offlineQueue = new OfflineQueue({
    adapter: persistence?.adapter,
    network,
    logger,
    maxRetries: offlineQueueOpts?.maxRetries,
    flushDebounceMs: offlineQueueOpts?.flushDebounceMs,
    /**
     * The last exit for a queued write that the server will never accept.
     *
     * `OfflineQueue` marks a mutation `rolled_back` once it exceeds
     * `maxRetries` and then prunes it, so this callback is the only remaining
     * chance to undo what the optimistic apply did. Unwired — as it was while
     * nothing could enqueue — the row it belongs to stays on screen, still
     * flagged pending, after the write has been abandoned: the interface
     * showing a record the server refused, which is the exact failure this
     * project has already shipped once.
     *
     * `rollbackSnapshot` is what the row was before. Its absence means there
     * was no row before (an insert, or an upsert that turned out to be one), so
     * the undo is a removal.
     *
     * **It undoes only a row that is still optimistic**, which is this path's
     * equivalent of the compare-and-swap every rollback inside
     * `createTableStore` performs against `_anchor_mutationId`. Minutes can pass
     * between the enqueue and the queue giving up, and a realtime event, a
     * refetch or a cross-tab merge can put a confirmed server row at that id in
     * the meantime. Restoring over it would replace a value the server holds
     * with an older one, and the `removeRecord` branch would delete a row this
     * mutation never created — gone from every list until a full refetch. A row
     * carrying no `_anchor_optimistic` flag is the server's answer, not ours to
     * undo.
     *
     * **A row that is not there at all means two different things, and the
     * operation is what tells them apart.** For a DELETE it is the expected
     * state: `remove` takes the row out of `records` and `order` outright
     * rather than leaving a pending tombstone, so the snapshot going back is
     * exactly the undo. For an INSERT, UPSERT or UPDATE it means the optimistic
     * row this mutation created is already gone — cleared at sign-out, dropped
     * by a `replace` refetch — and there is nothing left to undo. Writing the
     * snapshot there does not restore anything: `setRecord` re-adds the id to
     * `records` AND `order` and persists it, so a previous user's row would
     * return to the screen and to disk minutes after `clearAll()` removed it,
     * and a `merge` cache would then keep it through the next user's fetch.
     *
     * It is also the last word on a write, so it says so. Nothing else reports
     * that a queued mutation was abandoned, and a deleted row quietly
     * reappearing in a list some minutes later is not something to leave
     * unlogged.
     */
    onRollback: (mutation) => {
      const store = stores[mutation.table]
      logger?.mutationError?.(
        mutation.table,
        mutation.operation,
        `Abandoned after ${mutation.retryCount} attempts: ${mutation.lastError ?? "unknown error"}`,
      )
      if (!store) return
      const id = Object.values(mutation.primaryKey)[0] as string | number
      const current = store.getState().records.get(id)
      if (current && !current._anchor_optimistic) return
      if (!current && mutation.operation !== "DELETE") return
      const snapshot = mutation.rollbackSnapshot
      if (snapshot) store.getState().setRecord(id, snapshot as any)
      else if (current) store.getState().removeRecord(id)
    },
  })

  // Cleanup functions
  const cleanupFns: (() => void)[] = []

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
      offlineQueue: offlineQueueOpts,
      conflict: (tableOpts?.conflict as any) ?? conflict,
      cacheStrategy: (tableOpts?.cacheStrategy as any) ?? options.cacheStrategy,
      immer,
      devtools,
      logger,
      _queue: offlineQueue,
      // Views deliberately do not get this: Postgres publishes changes under the
      // underlying table's name, so a channel on a view never fires.
      _realtimeManager: realtimeManager,
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
    // A queue read back off disk needs a flush scheduled for it, and this is a
    // race with the auth event that would otherwise schedule one: reading
    // storage and supabase-js recovering a stored session are both in flight
    // from here, in an order that native and web do not agree on. Whichever
    // finishes second is the one that starts the drain — the auth gate covers
    // hydrate-then-session, this covers session-then-hydrate, and neither alone
    // covers both. `scheduleFlush` resets one debounce timer rather than
    // stacking, so being called twice costs nothing.
    //
    // It matters more than it did: until a tagged mutation began waiting for
    // its own user, an unauthenticated flush from any source would have drained
    // the queue regardless. Now nothing else can.
    if (offlineQueue.isDirty) offlineQueue.scheduleFlush()
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
