import type { SupabaseClient } from "@supabase/supabase-js"
import { createStore, type StoreApi } from "zustand/vanilla"
import { subscribeWithSelector, devtools } from "zustand/middleware"
import type {
  TableStore,
  TableStoreState,
  TableStoreActions,
  TrackedRow,
  CreateTableStoreOptions,
  FilterDescriptor,
  FetchOptions,
} from "./types.js"
import { noopLogger, createTempId } from "./types.js"
import { runValidation } from "./mutation/validation.js"
import { fromSupabaseError } from "./errors.js"
import { executeQuery, executeQueryOne, fromTable, applyFilters } from "./query/queryExecutor.js"

type StoreSet<Row, InsertRow, UpdateRow> = StoreApi<
  TableStore<Row, InsertRow, UpdateRow>
>["setState"]
type StoreGet<Row, InsertRow, UpdateRow> = StoreApi<
  TableStore<Row, InsertRow, UpdateRow>
>["getState"]

/**
 * Creates a Zustand store for a single Supabase table.
 */
export function createTableStore<
  DB,
  Row extends Record<string, unknown>,
  InsertRow extends Record<string, unknown>,
  UpdateRow extends Record<string, unknown>,
  Extensions extends Record<string, unknown> = Record<string, never>,
>(
  options: CreateTableStoreOptions<DB, Row, InsertRow, UpdateRow, Extensions>,
): StoreApi<TableStore<Row, InsertRow, UpdateRow> & Extensions> {
  const {
    supabase,
    table,
    schema = "public",
    primaryKey: rawPrimaryKey = "id",
    defaultFilters,
    defaultSort,
    defaultSelect,
    persistence,
    offlineQueue: offlineQueueOpts,
    network: networkOpts,
    realtime: realtimeOpts,
    conflict: conflictOpts,
    logger = noopLogger,
    isView = false,
    immer: immerMiddleware,
    devtools: devtoolsOption,
    validate,
    cacheStrategy: defaultCacheStrategy = "replace",
    _queue,
    extend,
  } = options

  // Composite primary keys are supported via the encodeKey/applyPkFilters utilities.
  // createTableStore currently operates on a single PK column for Map key usage.
  // If an array PK is passed, throw to prevent silent data corruption.
  if (Array.isArray(rawPrimaryKey) && rawPrimaryKey.length > 1) {
    throw new Error(
      `createTableStore does not yet support composite primary keys (received [${rawPrimaryKey.join(", ")}] for table "${table}"). ` +
      `Use the encodeKey/applyPkFilters utilities from "@drakkar.software/anchor" for composite key tables.`,
    )
  }
  const primaryKey = typeof rawPrimaryKey === "string" ? rawPrimaryKey : rawPrimaryKey[0]!

  // Warn about options that only work via createSupabaseStores
  if (!_queue) {
    if (realtimeOpts?.enabled) {
      console.warn(`[anchor:${table}] "realtime" option requires createSupabaseStores(). Use createSupabaseStores() or manually set up RealtimeManager + bindRealtimeToStore().`)
    }
    if (offlineQueueOpts?.enabled) {
      console.warn(`[anchor:${table}] "offlineQueue" option requires createSupabaseStores(). Use createSupabaseStores() or manually create an OfflineQueue.`)
    }
    if (conflictOpts) {
      console.warn(`[anchor:${table}] "conflict" option requires createSupabaseStores() with realtime enabled. Configure conflict resolution via bindRealtimeToStore().`)
    }
    if (networkOpts) {
      console.warn(`[anchor:${table}] "network" option requires createSupabaseStores(). Use createSupabaseStores() or manually wire NetworkStatusAdapter.`)
    }
  }

  // Track last fetch options for refetch and generation counter for stale response detection
  let lastFetchOptions: FetchOptions<Row> | undefined
  let fetchGeneration = 0

  const storeCreator = (
    set: StoreSet<Row, InsertRow, UpdateRow>,
    get: StoreGet<Row, InsertRow, UpdateRow>,
    api: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
  ): TableStore<Row, InsertRow, UpdateRow> & Extensions => {
    // ── Helpers ────────────────────────────────────────────────────

    function mergeFilters(
      custom?: FilterDescriptor<Row>[],
    ): FilterDescriptor<Row>[] | undefined {
      if (!defaultFilters && !custom) return undefined
      return [...(defaultFilters ?? []), ...(custom ?? [])]
    }

    function recordsToArray(
      records: Map<string | number, TrackedRow<Row>>,
      order: (string | number)[],
    ): TrackedRow<Row>[] {
      const result: TrackedRow<Row>[] = []
      for (const id of order) {
        const record = records.get(id)
        if (record) result.push(record)
      }
      return result
    }

    function rowsToMap(
      rows: Row[],
    ): { records: Map<string | number, TrackedRow<Row>>; order: (string | number)[] } {
      const records = new Map<string | number, TrackedRow<Row>>()
      const order: (string | number)[] = []
      for (const row of rows) {
        const id = (row as Record<string, unknown>)[primaryKey] as
          | string
          | number
        records.set(id, row as TrackedRow<Row>)
        order.push(id)
      }
      return { records, order }
    }

    const persistenceKey = persistence?.key ?? `anchor:${schema}:${table}`

    // Debounce persistence writes to avoid excessive serialization on rapid mutations
    let persistTimer: ReturnType<typeof setTimeout> | null = null

    function persistIfConfigured(): void {
      if (!persistence) return
      if (persistTimer) clearTimeout(persistTimer)
      persistTimer = setTimeout(() => {
        persistTimer = null
        const state = get()
        const data = recordsToArray(state.records, state.order)
        persistence.adapter
          .setItem(persistenceKey, data)
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            logger.mutationError(table, "PERSIST" as any, msg)
            set({ error: new Error(`Persistence failed: ${msg}`) } as Partial<
              TableStore<Row, InsertRow, UpdateRow>
            >)
          })
      }, 100)
    }

    function assertNotView(): void {
      if (isView) throw new Error(`Cannot mutate view "${table}"`)
    }

    // ── Initial state ─────────────────────────────────────────────

    const initialState: TableStoreState<Row> = {
      records: new Map(),
      order: [],
      isLoading: false,
      error: null,
      isHydrated: false,
      isRestoring: false,
      lastFetchedAt: null,
      realtimeStatus: "disconnected",
    }

    // ── Actions ───────────────────────────────────────────────────

    // In-flight fetch deduplication
    let inflightPromise: Promise<TrackedRow<Row>[]> | null = null

    const actions: TableStoreActions<Row, InsertRow, UpdateRow> = {
      // ── Query ─────────────────────────────────────────────────

      async fetch(fetchOptions) {
        // Deduplicate concurrent fetches — return in-flight promise if one exists
        if (inflightPromise) return inflightPromise

        const doFetch = async (): Promise<TrackedRow<Row>[]> => {
          const thisGeneration = ++fetchGeneration
          // Stale-while-revalidate: only show loading if no cached data exists
          const hasData = get().records.size > 0
          set({ isLoading: !hasData, error: null } as Partial<
            TableStore<Row, InsertRow, UpdateRow>
          >)
          lastFetchOptions = fetchOptions

          const start = Date.now()
          logger.fetchStart(table)

          try {
            const opts: FetchOptions<Row> = {
              ...fetchOptions,
              filters: mergeFilters(fetchOptions?.filters),
              sort: fetchOptions?.sort ?? defaultSort,
              select: fetchOptions?.select ?? defaultSelect,
            }

            const { data, error, count } = await executeQuery<Row>(
              supabase as SupabaseClient,
              table,
              schema,
              opts,
            )

            if (error) {
              logger.fetchError(table, error.message)
              if (thisGeneration === fetchGeneration) {
                set({ isLoading: false, error } as Partial<
                  TableStore<Row, InsertRow, UpdateRow>
                >)
              }
              return []
            }

            // Discard stale response if a newer fetch was initiated
            if (thisGeneration !== fetchGeneration) {
              return []
            }

            // Warn if result was likely truncated by Supabase's default row limit
            if (
              !opts.limit &&
              count != null &&
              data.length < count
            ) {
              logger.fetchError(
                table,
                `Fetch returned ${data.length} of ${count} total rows. Use pagination or set a limit to retrieve all data.`,
              )
            }

            // Resolve effective strategy: per-fetch option > store-level default
            const effectiveStrategy = fetchOptions?.cacheStrategy ?? defaultCacheStrategy

            let records: Map<string | number, TrackedRow<Row>>
            let order: (string | number)[]

            if (effectiveStrategy === "merge") {
              // Merge mode: records accumulate, order reflects latest query
              const currentState = get()
              records = new Map(currentState.records)
              order = []

              for (const row of data) {
                const id = (row as Record<string, unknown>)[primaryKey] as string | number
                const existing = records.get(id)
                if (existing?._anchor_pending) {
                  // Keep pending version but include in order
                  order.push(id)
                  continue
                }
                records.set(id, row as TrackedRow<Row>)
                order.push(id)
              }

              // Preserve pending rows not in the latest query at the end of order
              const orderSet = new Set(order)
              for (const [id, existing] of currentState.records) {
                if (existing._anchor_pending && !orderSet.has(id)) {
                  order.push(id)
                }
              }
            } else {
              // Replace mode (default): existing behavior
              const mapped = rowsToMap(data)
              records = mapped.records
              order = mapped.order

              // Preserve rows with pending mutations
              const currentState = get()
              for (const [id, existing] of currentState.records) {
                if (existing._anchor_pending && !records.has(id)) {
                  records.set(id, existing)
                  order.push(id)
                } else if (existing._anchor_pending && records.has(id)) {
                  records.set(id, existing)
                }
              }
            }

            logger.fetchSuccess(table, data.length, Date.now() - start)
            set({
              records,
              order,
              isLoading: false,
              error: null,
              lastFetchedAt: Date.now(),
            } as Partial<TableStore<Row, InsertRow, UpdateRow>>)

            persistIfConfigured()

            return recordsToArray(records, order)
          } catch (err) {
            logger.fetchError(table, err instanceof Error ? err.message : String(err))
            if (thisGeneration === fetchGeneration) {
              set({
                isLoading: false,
                error: err instanceof Error ? err : new Error(String(err)),
              } as Partial<TableStore<Row, InsertRow, UpdateRow>>)
            }
            return []
          }
        }

        inflightPromise = doFetch().finally(() => { inflightPromise = null })
        return inflightPromise
      },

      async fetchOne(id) {
        const { data, error } = await executeQueryOne<Row>(
          supabase as SupabaseClient,
          table,
          primaryKey,
          id,
          defaultSelect,
          schema,
        )

        if (error) {
          set({ error } as Partial<TableStore<Row, InsertRow, UpdateRow>>)
          return null
        }
        if (!data) return null

        const tracked = data as TrackedRow<Row>
        set((prev) => {
          const records = new Map(prev.records)
          const order = [...prev.order]
          records.set(id, tracked)
          if (!prev.records.has(id)) order.push(id)
          return { ...prev, records, order }
        })

        persistIfConfigured()
        return tracked
      },

      async refetch() {
        return actions.fetch(lastFetchOptions)
      },

      // ── Mutations ─────────────────────────────────────────────

      async insert(row) {
        assertNotView()
        runValidation(validate?.insert, row, "insert")
        const start = Date.now()
        logger.mutationStart(table, "INSERT")

        // Optimistically add
        const tempId =
          (row as Record<string, unknown>)[primaryKey] ??
          createTempId()
        const optimisticRow: TrackedRow<Row> = {
          ...(row as unknown as Row),
          [primaryKey]: tempId,
          _anchor_pending: "insert",
          _anchor_optimistic: true,
        }

        set((prev) => {
          const records = new Map(prev.records)
          const order = [...prev.order]
          records.set(tempId as string | number, optimisticRow)
          order.push(tempId as string | number)
          return { ...prev, records, order, error: null }
        })

        // Execute remote
        const { data, error } = await fromTable(supabase as unknown as SupabaseClient, table, schema)
          .insert(row as any)
          .select(defaultSelect ?? "*")
          .single()

        if (error) {
          // Rollback
          logger.mutationError(table, "INSERT", error.message)
          set((prev) => {
            const records = new Map(prev.records)
            const order = prev.order.filter((o) => o !== tempId)
            records.delete(tempId as string | number)
            return { ...prev, records, order, error: fromSupabaseError(error) }
          })
          throw fromSupabaseError(error)
        }

        const serverRow = data as unknown as Row
        const serverId = (serverRow as Record<string, unknown>)[
          primaryKey
        ] as string | number

        // Confirm: replace optimistic with server response
        set((prev) => {
          const records = new Map(prev.records)
          const order = [...prev.order]

          // Remove temp entry if ID changed
          if (serverId !== tempId) {
            records.delete(tempId as string | number)
            const idx = order.indexOf(tempId as string | number)
            if (idx >= 0) order[idx] = serverId
          }

          records.set(serverId, serverRow as TrackedRow<Row>)
          // Ensure serverId is in order (handles edge case where optimistic set threw)
          if (!order.includes(serverId)) order.push(serverId)
          return { ...prev, records, order }
        })

        logger.mutationSuccess(table, "INSERT", Date.now() - start)
        persistIfConfigured()
        return serverRow as TrackedRow<Row>
      },

      async insertMany(rows) {
        assertNotView()
        for (const row of rows) {
          runValidation(validate?.insert, row, "insert")
        }
        const start = Date.now()
        logger.mutationStart(table, "INSERT")

        // Build optimistic rows
        const tempIds: (string | number)[] = []
        const optimisticRows: TrackedRow<Row>[] = []
        for (const row of rows) {
          const tempId =
            (row as Record<string, unknown>)[primaryKey] ??
            createTempId()
          tempIds.push(tempId as string | number)
          optimisticRows.push({
            ...(row as unknown as Row),
            [primaryKey]: tempId,
            _anchor_pending: "insert",
            _anchor_optimistic: true,
          } as TrackedRow<Row>)
        }

        // Single batched optimistic apply
        set((prev) => {
          const records = new Map(prev.records)
          const order = [...prev.order]
          for (let i = 0; i < tempIds.length; i++) {
            records.set(tempIds[i]!, optimisticRows[i]!)
            order.push(tempIds[i]!)
          }
          return { ...prev, records, order, error: null }
        })

        // Batched remote insert
        const { data, error } = await fromTable(supabase as unknown as SupabaseClient, table, schema)
          .insert(rows as any[])
          .select(defaultSelect ?? "*")

        if (error) {
          // Rollback all optimistic inserts
          logger.mutationError(table, "INSERT", error.message)
          const tempIdSet = new Set(tempIds)
          set((prev) => {
            const records = new Map(prev.records)
            const order = prev.order.filter(
              (o) => !tempIdSet.has(o),
            )
            for (const id of tempIds) records.delete(id)
            return { ...prev, records, order, error: fromSupabaseError(error) }
          })
          throw fromSupabaseError(error)
        }

        // Confirm: replace optimistic with server responses
        const serverRows = (data as unknown as Row[]) ?? []
        set((prev) => {
          const records = new Map(prev.records)

          // Remove all temp entries from records
          for (const tempId of tempIds) {
            records.delete(tempId)
          }

          // Remove all temp IDs from order, preserving non-temp entries
          const tempIdSet = new Set(tempIds)
          const order = prev.order.filter((o) => !tempIdSet.has(o))

          // Add server rows to records and order
          for (const serverRow of serverRows) {
            const serverId = (serverRow as Record<string, unknown>)[
              primaryKey
            ] as string | number
            records.set(serverId, serverRow as TrackedRow<Row>)
            order.push(serverId)
          }

          return { ...prev, records, order }
        })

        logger.mutationSuccess(table, "INSERT", Date.now() - start)
        persistIfConfigured()
        return serverRows as TrackedRow<Row>[]
      },

      async update(id, changes) {
        assertNotView()
        runValidation(validate?.update, changes, "update")
        const start = Date.now()
        logger.mutationStart(table, "UPDATE")

        // Unique ID for this mutation (used for compare-and-swap rollback)
        const mutationId = crypto.randomUUID()

        // Snapshot for rollback
        const snapshot = get().records.get(id)

        // Optimistic apply
        set((prev) => {
          const records = new Map(prev.records)
          const existing = records.get(id)
          if (existing) {
            records.set(id, {
              ...existing,
              ...(changes as Record<string, unknown>),
              _anchor_pending: "update",
              _anchor_optimistic: true,
              _anchor_mutationId: mutationId,
            } as TrackedRow<Row>)
          }
          return { ...prev, records, error: null }
        })

        // Execute remote
        const { data, error } = await fromTable(supabase as unknown as SupabaseClient, table, schema)
          .update(changes as any)
          .eq(primaryKey, id as any)
          .select(defaultSelect ?? "*")
          .single()

        if (error) {
          // Compare-and-swap rollback: only roll back if this mutation's
          // optimistic write is still the current value (not overwritten
          // by a concurrent mutation)
          logger.mutationError(table, "UPDATE", error.message)
          set((prev) => {
            const records = new Map(prev.records)
            const current = records.get(id)
            if (current?._anchor_mutationId === mutationId && snapshot) {
              records.set(id, snapshot)
            }
            return { ...prev, records, error: fromSupabaseError(error) }
          })
          throw fromSupabaseError(error)
        }

        // Confirm with server response
        set((prev) => {
          const records = new Map(prev.records)
          records.set(id, data as unknown as TrackedRow<Row>)
          return { ...prev, records }
        })

        logger.mutationSuccess(table, "UPDATE", Date.now() - start)
        persistIfConfigured()
        return data as unknown as TrackedRow<Row>
      },

      async upsert(row) {
        assertNotView()
        runValidation(validate?.insert, row, "upsert")
        const start = Date.now()
        logger.mutationStart(table, "UPSERT")

        // Optimistic apply with CAS mutation ID
        const mutationId = crypto.randomUUID()
        const optimisticId =
          (row as Record<string, unknown>)[primaryKey] as
            | string
            | number
            | undefined
        const snapshot = optimisticId
          ? get().records.get(optimisticId)
          : undefined

        if (optimisticId) {
          set((prev) => {
            const records = new Map(prev.records)
            const order = [...prev.order]
            records.set(optimisticId, {
              ...(row as unknown as Row),
              _anchor_pending: "update",
              _anchor_optimistic: true,
              _anchor_mutationId: mutationId,
            } as TrackedRow<Row>)
            if (!prev.records.has(optimisticId)) order.push(optimisticId)
            return { ...prev, records, order, error: null }
          })
        }

        const { data, error } = await fromTable(supabase as unknown as SupabaseClient, table, schema)
          .upsert(row as any)
          .select(defaultSelect ?? "*")
          .single()

        if (error) {
          logger.mutationError(table, "UPSERT", error.message)
          // Compare-and-swap rollback
          if (optimisticId) {
            set((prev) => {
              const records = new Map(prev.records)
              const order = [...prev.order]
              const current = records.get(optimisticId)
              // Only roll back if this mutation's write is still current
              if (current?._anchor_mutationId !== mutationId) {
                return { ...prev, error: fromSupabaseError(error) }
              }
              if (snapshot) {
                records.set(optimisticId, snapshot)
              } else {
                records.delete(optimisticId)
                const idx = order.indexOf(optimisticId)
                if (idx >= 0) order.splice(idx, 1)
              }
              return { ...prev, records, order, error: fromSupabaseError(error) }
            })
          }
          throw fromSupabaseError(error)
        }

        const serverRow = data as unknown as Row
        const id = (serverRow as Record<string, unknown>)[primaryKey] as
          | string
          | number

        set((prev) => {
          const records = new Map(prev.records)
          const order = [...prev.order]

          // Clean up optimistic entry if server returned a different ID
          if (optimisticId && optimisticId !== id) {
            records.delete(optimisticId)
            const idx = order.indexOf(optimisticId)
            if (idx >= 0) order[idx] = id
          }

          records.set(id, serverRow as TrackedRow<Row>)
          if (!prev.records.has(id) && !order.includes(id)) order.push(id)
          return { ...prev, records, order }
        })

        logger.mutationSuccess(table, "UPSERT", Date.now() - start)
        persistIfConfigured()
        return serverRow as TrackedRow<Row>
      },

      async remove(id) {
        assertNotView()
        const start = Date.now()
        logger.mutationStart(table, "DELETE")

        // Snapshot for rollback
        const snapshot = get().records.get(id)

        // Optimistic remove
        set((prev) => {
          const records = new Map(prev.records)
          const order = prev.order.filter((o) => o !== id)
          records.delete(id)
          return { ...prev, records, order, error: null }
        })

        // Execute remote
        const { error } = await fromTable(supabase as unknown as SupabaseClient, table, schema)
          .delete()
          .eq(primaryKey, id as any)

        if (error) {
          // Rollback — re-insert row into current order (preserves concurrent changes)
          logger.mutationError(table, "DELETE", error.message)
          set((prev) => {
            const records = new Map(prev.records)
            const order = [...prev.order]
            if (snapshot) {
              records.set(id, snapshot)
              if (!order.includes(id)) order.push(id)
            }
            return { ...prev, records, order, error: fromSupabaseError(error) }
          })
          throw fromSupabaseError(error)
        }

        logger.mutationSuccess(table, "DELETE", Date.now() - start)
        persistIfConfigured()
      },

      async removeWhere(filters) {
        assertNotView()
        const start = Date.now()
        logger.mutationStart(table, "DELETE")

        // Find matching rows client-side for optimistic removal
        const snapshots = new Map<string | number, TrackedRow<Row>>()
        const current = get()
        for (const [id, record] of current.records) {
          const matches = filters.every((f) => {
            const val = (record as Record<string, unknown>)[f.column as string]
            switch (f.op) {
              case "eq": return val === f.value
              case "neq": return val !== f.value
              default: return true // conservative: assume match for complex ops
            }
          })
          if (matches) snapshots.set(id, record)
        }

        // Optimistic remove
        if (snapshots.size > 0) {
          set((prev) => {
            const records = new Map(prev.records)
            const removedIds = new Set(snapshots.keys())
            const order = prev.order.filter((o) => !removedIds.has(o))
            for (const id of removedIds) records.delete(id)
            return { ...prev, records, order, error: null }
          })
        }

        // Execute remote DELETE with filters
        let query = fromTable(supabase as unknown as SupabaseClient, table, schema).delete()
        query = applyFilters(query, filters as any[])
        const { error } = await query

        if (error) {
          logger.mutationError(table, "DELETE", error.message)
          // Rollback — restore all snapshots
          set((prev) => {
            const records = new Map(prev.records)
            const order = [...prev.order]
            for (const [id, snapshot] of snapshots) {
              records.set(id, snapshot)
              if (!order.includes(id)) order.push(id)
            }
            return { ...prev, records, order, error: fromSupabaseError(error) }
          })
          throw fromSupabaseError(error)
        }

        logger.mutationSuccess(table, "DELETE", Date.now() - start)
        persistIfConfigured()
      },

      // ── Local-only ────────────────────────────────────────────

      setRecord(id, row) {
        set((prev) => {
          const records = new Map(prev.records)
          const order = [...prev.order]
          records.set(id, row)
          if (!prev.records.has(id)) order.push(id)
          return { ...prev, records, order }
        })
        persistIfConfigured()
      },

      removeRecord(id) {
        set((prev) => {
          const records = new Map(prev.records)
          const order = prev.order.filter((o) => o !== id)
          records.delete(id)
          return { ...prev, records, order }
        })
        persistIfConfigured()
      },

      clearAll() {
        // Cancel any pending debounced persist to avoid re-persisting stale data
        if (persistTimer) {
          clearTimeout(persistTimer)
          persistTimer = null
        }
        set({
          records: new Map(),
          order: [],
          error: null,
          lastFetchedAt: null,
        } as Partial<TableStore<Row, InsertRow, UpdateRow>>)
        if (persistence) {
          persistence.adapter
            .removeItem(persistenceKey)
            .catch((err) => {
              logger.mutationError(table, "PERSIST" as any, err instanceof Error ? err.message : String(err))
            })
        }
      },

      mergeRecords(rows) {
        set((prev) => {
          const records = new Map(prev.records)
          const order = [...prev.order]
          for (const row of rows) {
            const id = (row as Record<string, unknown>)[primaryKey] as
              | string
              | number
            // Don't overwrite pending records
            const existing = records.get(id)
            if (existing?._anchor_pending) continue
            const isNew = !records.has(id)
            records.set(id, row as TrackedRow<Row>)
            if (isNew) order.push(id)
          }
          return { ...prev, records, order }
        })
        persistIfConfigured()
      },

      async clearAndFetch(fetchOpts) {
        // Clear records
        if (persistTimer) {
          clearTimeout(persistTimer)
          persistTimer = null
        }
        set({
          records: new Map(),
          order: [],
          error: null,
          lastFetchedAt: null,
        } as Partial<TableStore<Row, InsertRow, UpdateRow>>)
        if (persistence) {
          persistence.adapter
            .removeItem(persistenceKey)
            .catch((err) => {
              logger.mutationError(table, "PERSIST" as any, err instanceof Error ? err.message : String(err))
            })
        }
        // Discard any in-flight fetch so we don't reuse a stale response
        inflightPromise = null
        // Fetch with replace strategy forced
        return actions.fetch({ ...fetchOpts, cacheStrategy: "replace" })
      },

      // ── Realtime (stub — implemented in realtimeBindings) ─────

      subscribe(_filter) {
        return () => {}
      },

      unsubscribe() {},

      // ── Persistence ───────────────────────────────────────────

      async hydrate() {
        if (!persistence) return

        set({ isRestoring: true } as Partial<
          TableStore<Row, InsertRow, UpdateRow>
        >)

        try {
          const key = persistenceKey
          const data = await persistence.adapter.getItem<Row[]>(key)

          if (data && Array.isArray(data)) {
            const { records, order } = rowsToMap(data)
            set({
              records,
              order,
              isHydrated: true,
              isRestoring: false,
            } as Partial<TableStore<Row, InsertRow, UpdateRow>>)
          } else {
            set({ isHydrated: true, isRestoring: false } as Partial<
              TableStore<Row, InsertRow, UpdateRow>
            >)
          }
        } catch (err) {
          logger.fetchError(table, `Hydration failed: ${err instanceof Error ? err.message : String(err)}`)
          set({
            isHydrated: true,
            isRestoring: false,
            error: err instanceof Error ? err : new Error(String(err)),
          } as Partial<TableStore<Row, InsertRow, UpdateRow>>)
        }
      },

      async persist() {
        persistIfConfigured()
      },

      // ── Queue (stub — implemented in offlineQueue) ────────────

      async flushQueue() {
        if (_queue) {
          const q = _queue as import("./mutation/offlineQueue.js").OfflineQueue
          await q.flush()
        }
      },

      getQueueSize() {
        if (_queue) {
          const q = _queue as import("./mutation/offlineQueue.js").OfflineQueue
          return q.pendingMutations.filter((m) => m.table === table).length
        }
        return 0
      },
    }

    // ── Build the full store ──────────────────────────────────────

    const extensions = extend
      ? extend(
          set as any,
          get as any,
          api as any,
          supabase,
        )
      : ({} as Extensions)

    return {
      ...initialState,
      ...actions,
      ...extensions,
    }
  }

  // ── Create the store with middleware ─────────────────────────────
  // Middleware order (outermost wraps first):
  //   immer → devtools → subscribeWithSelector → storeCreator

  let combinedCreator: any = subscribeWithSelector(storeCreator as any)

  if (devtoolsOption) {
    const devtoolsName =
      typeof devtoolsOption === "object"
        ? devtoolsOption.name ?? `anchor:${table}`
        : `anchor:${table}`
    combinedCreator = devtools(combinedCreator, { name: devtoolsName })
  }

  if (immerMiddleware) {
    combinedCreator = immerMiddleware(combinedCreator)
  }

  const store = createStore<TableStore<Row, InsertRow, UpdateRow> & Extensions>()(
    combinedCreator as any,
  )

  // Auto-hydrate if persistence configured
  if (persistence) {
    store.getState().hydrate()
  }

  // Set up cross-tab sync if configured
  if (options.crossTab?.enabled) {
    import("./sync/crossTabSync.js").then(({ setupCrossTabSync }) => {
      const cleanup = setupCrossTabSync(
        store as any,
        options.crossTab!.name ?? `${schema}:${table}`,
        options.crossTab!.sessionId,
      )
      // Attach cleanup so createSupabaseStores._destroy() can call it
      ;(store as any)._destroyCrossTab = cleanup
    }).catch((err) => {
      logger.fetchError(table, `Cross-tab sync setup failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  return store
}
