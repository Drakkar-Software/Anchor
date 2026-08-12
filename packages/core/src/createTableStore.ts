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
  QueryEntry,
} from "./types.js"
import { noopLogger, createTempId } from "./types.js"
import { runValidation } from "./mutation/validation.js"
import { AnchorError, fromSupabaseError } from "./errors.js"
import { queryKey, isKeyable } from "./query/queryKey.js"
import { selectAllRows, selectQueryRows } from "./query/selectRows.js"
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

  // Per-query fetch bookkeeping, all keyed by `queryKey(opts)`.
  //
  // Each of these was a single slot shared by every query on the table, which
  // is what made two components with different filters collide: `refetch()`
  // replayed whichever options were written last, the generation counter let a
  // second query's response discard the first's, and the in-flight promise
  // handed the second caller the first caller's rows without ever issuing its
  // request.
  //
  // `liveQueryOptions` holds only queries a caller has explicitly retained —
  // `useQuery` retains on mount and releases on unmount. Filling it from every
  // fetch instead would make `refetch()` fan out to every filter combination
  // the store had ever seen, which on a foreground resume is dozens of
  // concurrent requests for screens nobody is looking at.
  const liveQueryOptions = new Map<string, FetchOptions<Row> | undefined>()
  const retainCounts = new Map<string, number>()
  const generations = new Map<string, number>()
  let generationTick = 0
  const inflight = new Map<string, Promise<TrackedRow<Row>[]>>()
  // Fetches that cannot be keyed (an opaque `queryFn`) get a private key so
  // they neither share nor poison a real query's entry.
  let unkeyedCounter = 0

  /** How many distinct queries a store remembers. See `setQueryEntry`. */
  const MAX_QUERY_ENTRIES = 32

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

    /** Kept as a local name; the projection itself now lives in one place. */
    function recordsToArray(
      records: Map<string | number, TrackedRow<Row>>,
      order: (string | number)[],
    ): TrackedRow<Row>[] {
      return selectAllRows<Row>({ records, order })
    }

    /**
     * A row's identity, or a hard failure.
     *
     * `records` is a Map keyed on this value, so a nullish key silently
     * collapses every such row onto one entry: three rows arrive, one record is
     * kept, `order` holds three copies of `undefined`, and every projection
     * renders the last row three times. Nothing about that reads as broken.
     *
     * Views make it reachable in ordinary use — a generated `Database` marks
     * every view column nullable, a LEFT JOIN really can produce a null id, and
     * a `defaultSelect` that omits the key column produces the same shape — so
     * this fails where the row arrives instead. Both call sites are inside the
     * fetch/hydrate try, which turns it into a query error naming the column.
     */
    function rowId(row: Row): string | number {
      const id = (row as Record<string, unknown>)[primaryKey]
      if (id == null) {
        const where = isView ? "viewOptions" : "tableOptions"
        throw new AnchorError(
          `${isView ? "View" : "Table"} "${table}" returned a row with no "${primaryKey}". ` +
          `Set ${where}.${table}.primaryKey to a column that is present and unique, ` +
          `and make sure defaultSelect includes it.`,
        )
      }
      return id as string | number
    }

    function rowsToMap(
      rows: Row[],
    ): { records: Map<string | number, TrackedRow<Row>>; order: (string | number)[] } {
      const records = new Map<string | number, TrackedRow<Row>>()
      const order: (string | number)[] = []
      for (const row of rows) {
        const id = rowId(row)
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
      queries: new Map(),
      isLoading: false,
      error: null,
      isHydrated: false,
      isRestoring: false,
      lastFetchedAt: null,
      realtimeStatus: "disconnected",
    }

    /**
     * Drop every trace of every query. Used where the store's contents stop
     * being an answer to anything — sign-out, `clearAll`, `clearAndFetch`. The
     * in-flight promises go too: a response that lands after the clear would
     * otherwise repopulate the store the caller just emptied.
     */
    function forgetQueries(): void {
      generations.clear()
      inflight.clear()
      // `liveQueryOptions` is NOT cleared: it records what is mounted, and
      // clearing the store's contents does not unmount anything. Dropping it
      // on sign-out would make the next foreground `refetch()` fall back to
      // pulling the whole table instead of the screens actually on display.
    }

    /** Write one query's entry without disturbing the others. */
    function setQueryEntry(key: string, patch: Partial<QueryEntry>): void {
      set((prev) => {
        const queries = new Map(prev.queries)
        const existing = queries.get(key) ?? {
          count: null,
          isLoading: false,
          error: null,
          lastFetchedAt: null,
        }
        queries.set(key, { ...existing, ...patch })

        // Bounded: a screen filtering on a free-text field would otherwise add
        // one entry per keystroke and never drop any. Entries hold no rows —
        // a count, two flags and a timestamp — so this is hygiene rather than a
        // memory limit, and Map iteration order makes the oldest still-idle
        // entry the one to lose.
        if (queries.size > MAX_QUERY_ENTRIES) {
          for (const [candidate, entry] of queries) {
            // Never evict a query something is still watching — dropping a
            // mounted screen's entry sends it back to "loading, with no data"
            // and makes it refetch on its next render.
            if (candidate !== key && !entry.isLoading && !retainCounts.has(candidate)) {
              queries.delete(candidate)
              generations.delete(candidate)
              break
            }
          }
        }

        return { ...prev, queries }
      })
    }

    // ── Actions ───────────────────────────────────────────────────

    const actions: TableStoreActions<Row, InsertRow, UpdateRow> = {
      // ── Query ─────────────────────────────────────────────────

      retainQuery(fetchOptions) {
        const key = queryKey(actions.resolveFetchOptions(fetchOptions))
        retainCounts.set(key, (retainCounts.get(key) ?? 0) + 1)
        liveQueryOptions.set(key, fetchOptions)
        return key
      },

      releaseQuery(fetchOptions) {
        const key = queryKey(actions.resolveFetchOptions(fetchOptions))
        const next = (retainCounts.get(key) ?? 0) - 1
        if (next > 0) {
          retainCounts.set(key, next)
          return
        }
        retainCounts.delete(key)
        liveQueryOptions.delete(key)
      },

      resolveFetchOptions(fetchOptions) {
        return {
          ...fetchOptions,
          filters: mergeFilters(fetchOptions?.filters),
          sort: fetchOptions?.sort ?? defaultSort,
          select: fetchOptions?.select ?? defaultSelect,
        }
      },

      async fetch(fetchOptions) {
        // The key has to come from the EFFECTIVE options, after the store's
        // defaults are merged in — which is also why `resolveFetchOptions` is
        // public: the hook has to key on the same thing this does, and it
        // cannot see the store's defaults. Keying on the caller's raw options
        // would file the entry under a key the read never looks up on any store
        // configured with `defaultFilters`, which reads as "loading forever,
        // over nothing".
        const opts = actions.resolveFetchOptions(fetchOptions)
        const keyable = isKeyable(opts)
        const key = keyable ? queryKey(opts) : `unkeyed:${++unkeyedCounter}`

        // Deduplicate concurrent fetches of the SAME query only.
        const existing = inflight.get(key)
        if (existing) return existing

        const doFetch = async (): Promise<TrackedRow<Row>[]> => {
          // Drawn from a counter that only ever goes up, per store. Deriving it
          // from the map's current value would let `forgetQueries()` reset it:
          // a fetch still in flight across a sign-out would then hold the same
          // number as its replacement, pass the staleness guard, and write the
          // previous account's rows into a store that was just cleared.
          const thisGeneration = ++generationTick
          generations.set(key, thisGeneration)
          // Stale-while-revalidate, judged per query: a table that already
          // holds another query's rows tells this one nothing. Counting the
          // whole table made a brand-new query report "not loading" while it
          // had nothing to show, so the screen rendered its empty state.
          const hasData = selectQueryRows<Row>(get(), opts.filters, opts.sort).length > 0
          set({ isLoading: !hasData, error: null } as Partial<
            TableStore<Row, InsertRow, UpdateRow>
          >)
          if (keyable) setQueryEntry(key, { isLoading: !hasData, error: null })

          const start = Date.now()
          logger.fetchStart(table)

          try {
            const { data, error, count } = await executeQuery<Row>(
              supabase as SupabaseClient,
              table,
              schema,
              opts,
            )

            if (error) {
              logger.fetchError(table, error.message)
              if (thisGeneration === generations.get(key)) {
                set({ isLoading: false, error } as Partial<
                  TableStore<Row, InsertRow, UpdateRow>
                >)
                // The entry is written on failure too. Writing it only on
                // success means a cold offline boot — hydrate fills `records`,
                // the fetch rejects, no entry exists — reports a permanent
                // spinner over rows that are already in memory, which is the
                // case this library exists to serve.
                if (keyable) setQueryEntry(key, { isLoading: false, error })
              }
              return []
            }

            // Discard a stale response — but only against THIS query's own
            // generation. A shared counter let an unrelated query's fetch
            // invalidate this one's result.
            if (thisGeneration !== generations.get(key)) {
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
                const id = rowId(row)
                const existing = records.get(id)
                if (existing?._anchor_pending) {
                  // Keep pending version but include in order
                  order.push(id)
                  continue
                }
                records.set(id, row as TrackedRow<Row>)
                order.push(id)
              }

              // Append every record the latest query did not mention, not just
              // the pending ones. "merge" promises that records accumulate, and
              // `order` is the only way any projection reaches them: a row left
              // out of `order` is in memory and invisible. That made a second,
              // narrower fetch silently drop the first fetch's rows from every
              // read while `records.size` still counted them.
              const orderSet = new Set(order)
              for (const id of currentState.order) {
                if (!orderSet.has(id)) {
                  order.push(id)
                  orderSet.add(id)
                }
              }
              for (const [id, existing] of currentState.records) {
                if (existing._anchor_pending && !orderSet.has(id)) {
                  order.push(id)
                  orderSet.add(id)
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
            if (keyable) {
              setQueryEntry(key, {
                count,
                isLoading: false,
                error: null,
                lastFetchedAt: Date.now(),
              })
            }

            persistIfConfigured()

            return recordsToArray(records, order)
          } catch (err) {
            logger.fetchError(table, err instanceof Error ? err.message : String(err))
            if (thisGeneration === generations.get(key)) {
              const error = err instanceof Error ? err : new Error(String(err))
              set({ isLoading: false, error } as Partial<
                TableStore<Row, InsertRow, UpdateRow>
              >)
              if (keyable) setQueryEntry(key, { isLoading: false, error })
            }
            return []
          }
        }

        // Delete only if this promise is still the registered one. `clearAll`
        // empties the map without cancelling anything, so an abandoned promise
        // settling later would otherwise evict its replacement and let the next
        // caller issue a duplicate request instead of joining the live one.
        const promise: Promise<TrackedRow<Row>[]> = doFetch().finally(() => {
          if (inflight.get(key) === promise) inflight.delete(key)
        })
        inflight.set(key, promise)
        return promise
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
        // Replay every live query, not just the one whose options were written
        // last. `appLifecycle`'s foreground handler calls this for every stale
        // store, so with a single slot, backgrounding an app with two screens
        // on one table and reopening it refetched one of them and — under
        // "replace" — evicted the other's rows.
        if (liveQueryOptions.size === 0) return actions.fetch(undefined)

        const results = await Promise.all(
          [...liveQueryOptions.values()].map((opts) => actions.fetch(opts)),
        )
        // The rows of the most recently registered query, matching what a
        // single-query caller got before.
        return results[results.length - 1] ?? []
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
        forgetQueries()
        set({
          records: new Map(),
          order: [],
          queries: new Map(),
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
        forgetQueries()
        set({
          records: new Map(),
          order: [],
          queries: new Map(),
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
