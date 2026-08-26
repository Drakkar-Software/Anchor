import type { SupabaseClient } from "@supabase/supabase-js"
import type { StoreApi } from "zustand"

// ─── Supabase Database Schema Extraction ─────────────────────────────

/** Extract the schema from a Database type */
export type ExtractSchema<
  DB,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = DB[SchemaName] extends {
  Tables: Record<string, unknown>
}
  ? DB[SchemaName]
  : never

/** Extract table names from a schema */
export type TableNames<
  DB,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = string & keyof ExtractSchema<DB, SchemaName>["Tables"]

/**
 * Extract view names from a schema.
 *
 * A generated Supabase `Database` type keeps views in their own `Views` block,
 * so they are not reachable through `TableNames` at all. Resolves to `never`
 * for a schema with no views, which is what the generator emits as `Views: {}`.
 */
export type ViewNames<
  DB,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = ExtractSchema<DB, SchemaName> extends { Views: infer V }
  ? string & keyof V
  : never

/** Extract the Row type for a specific view */
export type ViewRow<
  DB,
  ViewName extends ViewNames<DB, SchemaName>,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = ExtractSchema<DB, SchemaName> extends { Views: infer V }
  ? ViewName extends keyof V
    ? V[ViewName] extends { Row: infer R }
      ? R
      : never
    : never
  : never

/**
 * Extract Postgres function names from a schema.
 *
 * A generated `Database` types every function with an `Args` and a `Returns`
 * block, none of which the package read: `callRpc` took a bare `string` and an
 * unparameterised client, so the name, the argument object and the return type
 * were all unchecked. Resolves to `never` for a schema with no functions, which
 * the generator emits as `Functions: {}`.
 */
export type FunctionNames<
  DB,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = ExtractSchema<DB, SchemaName> extends { Functions: infer F }
  ? string & keyof F
  : never

/** The argument object a Postgres function takes, from the generated types. */
export type RpcArgs<
  DB,
  FunctionName extends FunctionNames<DB, SchemaName>,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = ExtractSchema<DB, SchemaName> extends { Functions: infer F }
  ? F[FunctionName & keyof F] extends { Args: infer A }
    ? A
    : never
  : never

/** What a Postgres function returns, from the generated types. */
export type RpcReturns<
  DB,
  FunctionName extends FunctionNames<DB, SchemaName>,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = ExtractSchema<DB, SchemaName> extends { Functions: infer F }
  ? F[FunctionName & keyof F] extends { Returns: infer R }
    ? R
    : never
  : never

/** Extract Row type for a specific table */
export type TableRow<
  DB,
  TableName extends TableNames<DB, SchemaName>,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = ExtractSchema<DB, SchemaName>["Tables"][TableName] extends {
  Row: infer R
}
  ? R
  : never

/** Extract Insert type for a specific table */
export type TableInsert<
  DB,
  TableName extends TableNames<DB, SchemaName>,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = ExtractSchema<DB, SchemaName>["Tables"][TableName] extends {
  Insert: infer I
}
  ? I
  : never

/** Extract Update type for a specific table */
export type TableUpdate<
  DB,
  TableName extends TableNames<DB, SchemaName>,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = ExtractSchema<DB, SchemaName>["Tables"][TableName] extends {
  Update: infer U
}
  ? U
  : never

/** Extract Enum type */
export type DatabaseEnum<
  DB,
  EnumName extends string,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = ExtractSchema<DB, SchemaName> extends { Enums: Record<string, unknown> }
  ? ExtractSchema<DB, SchemaName>["Enums"] extends Record<EnumName, infer E>
    ? E
    : never
  : never

// ─── Record Metadata (optimistic tracking) ───────────────────────────

export type RecordMeta = {
  _anchor_pending?: "insert" | "update" | "delete"
  _anchor_optimistic?: boolean
  _anchor_mutationId?: string
}

/** A row with optional tracking metadata */
export type TrackedRow<Row> = Row & Partial<RecordMeta>

// ─── Realtime Event Types ────────────────────────────────────────────

export type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE" | "*"

// ─── Cache Strategy ─────────────────────────────────────────────────

/** Controls how fetch() handles existing records.
 *  - "replace": Each fetch replaces all records (store is a window into the latest query)
 *  - "merge": Each fetch merges new records into existing ones (records accumulate,
 *    order reflects only the latest query) */
export type CacheStrategy = "replace" | "merge"

// ─── Filter & Query Types ────────────────────────────────────────────

export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "is"
  | "in"
  | "contains"
  | "containedBy"
  | "overlaps"
  | "textSearch"
  | "match"
  | "not"
  | "or"
  | "filter"

export type FilterDescriptor<Row = Record<string, unknown>> = {
  column: string & keyof Row
  op: FilterOperator
  value: unknown
}

export type SortDescriptor<Row = Record<string, unknown>> = {
  column: string & keyof Row
  ascending?: boolean
  nullsFirst?: boolean
}

/**
 * Which row an `upsert` writes.
 *
 * Without `onConflict`, PostgREST infers the conflict target from the primary
 * key. A table whose "one of these per day" rule lives in a *different* unique
 * constraint therefore cannot be upserted through a store at all: the insert
 * violates that constraint and Postgres raises `23505`, which reads as a
 * duplicate-key bug in the caller rather than as a missing option. `onConflict`
 * names the constraint's columns — `"journey_id,date"` — as the one
 * comma-separated string supabase-js takes.
 *
 * **`ignoreDuplicates` swaps `ON CONFLICT DO UPDATE` for `DO NOTHING`.**
 * Needed for a join table granted only `select, insert, delete` — no
 * `update` — where a plain upsert's `ON CONFLICT DO UPDATE` clause is
 * refused with `42501` even on a row that would not actually change,
 * because Postgres checks UPDATE privilege for that clause whether or not a
 * conflict occurs. `store.upsert(row, { onConflict, ignoreDuplicates: true
 * })` is the only shape such a table can be upserted through at all.
 *
 * Because a `DO NOTHING` conflict returns no representation, `upsert` reads
 * the row back with `.maybeSingle()` rather than `.single()` when this is
 * set, and a `null` response with no error resolves to the store's own
 * already-merged optimistic row (cleared of its pending flag) rather than
 * throwing `PGRST116` — "the server confirmed this already exists" is a
 * success, not a failure to roll back.
 */
export type UpsertOptions = {
  /** Comma-separated columns of the unique constraint to conflict on. */
  onConflict?: string
  /**
   * `ON CONFLICT DO NOTHING` instead of `DO UPDATE`. See this type's own
   * docblock for why this is the one option a no-`update`-grant join table
   * needs, and what a resolved conflict returns when set.
   */
  ignoreDuplicates?: boolean
}

export type FetchOptions<Row = Record<string, unknown>> = {
  filters?: FilterDescriptor<Row>[]
  sort?: SortDescriptor<Row>[]
  limit?: number
  offset?: number
  select?: string
  count?: "exact" | "planned" | "estimated"
  /**
   * Escape hatch: direct access to the PostgREST query builder. It arrives with
   * `select`, the filters and the pagination already applied — but **not the
   * sort**, which is the callback's own to set: `order` is the one PostgREST
   * parameter that accumulates rather than overwrites, so pre-applying it would
   * demote a `queryFn`'s `.order()` to a tiebreaker behind `defaultSort`.
   *
   * A `queryFn` passed here makes the fetch unkeyable — an opaque function
   * cannot go in a value-based key — so the query reads the table's own loading
   * and error flags instead of its own. Configure it once as the store's
   * `defaultQueryFn` if it is a property of the source rather than of the query;
   * that keeps per-query scoping, because the function is then the same for
   * every query on the store and the rest of the options still identify them.
   */
  queryFn?: (builder: unknown) => unknown
  /** Override the store's default cache strategy for this fetch */
  cacheStrategy?: CacheStrategy
}

// ─── Table Store State ───────────────────────────────────────────────

/**
 * What one query knows about itself.
 *
 * Metadata only — deliberately no row ids. A row that matches a query's filters
 * locally cannot know which *page* of that query it belongs to, so an id list
 * would be wrong as soon as `limit`/`offset` is involved; it would also need a
 * client-side comparator to place optimistic rows, and would go stale on the
 * offline queue's temp-id → server-id remap. Rows are read from `order`
 * filtered by `matchRow` instead, and `order` is the one structure every writer
 * in this package already maintains positionally.
 */
export type QueryEntry = {
  /** Total matching rows, when the fetch asked for a count. */
  count: number | null
  /** Whether THIS query is fetching — not whether the table is. */
  isLoading: boolean
  /** The error THIS query got, if any. */
  error: Error | null
  /** When this query last succeeded, which is what `staleTime` gates on. */
  lastFetchedAt: number | null
}

export type TableStoreState<Row> = {
  /** Normalized record map keyed by primary key value */
  records: Map<string | number, TrackedRow<Row>>
  /** Ordered array of primary key values (preserves query ordering) */
  order: (string | number)[]
  /** Per-query state, keyed by `queryKey(options)`. See `QueryEntry`. */
  queries: Map<string, QueryEntry>
  /** Loading state for the table as a whole — whichever query fetched last */
  isLoading: boolean
  /** Error from the last operation on any query */
  error: Error | null
  /** Whether initial data has been hydrated from persistence */
  isHydrated: boolean
  /** Whether the store is currently restoring from persistence (feedback loop prevention) */
  isRestoring: boolean
  /** Timestamp of last successful fetch */
  lastFetchedAt: number | null
  /** Active realtime subscription status */
  realtimeStatus: RealtimeStatus
}

export type RealtimeStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"

// ─── Table Store Actions ─────────────────────────────────────────────

export type TableStoreActions<
  Row,
  InsertRow,
  UpdateRow,
> = {
  // Query
  fetch: (options?: FetchOptions<Row>) => Promise<TrackedRow<Row>[]>
  fetchOne: (id: string | number) => Promise<TrackedRow<Row> | null>
  /** Replays every live query, not only the one that fetched last. */
  refetch: () => Promise<TrackedRow<Row>[]>
  /**
   * The options `fetch` would actually use, with this store's `defaultFilters`,
   * `defaultSort` and `defaultSelect` merged in.
   *
   * Public because a caller that wants to read one query's state has to key on
   * the same thing `fetch` filed it under, and the store's defaults are closure
   * variables it cannot see. `useQuery` uses it for exactly that.
   */
  resolveFetchOptions: (options?: FetchOptions<Row>) => FetchOptions<Row>
  /**
   * Declare that a caller is watching this query, and return its key.
   *
   * Only retained queries are replayed by `refetch()`. Without this the store
   * cannot tell a screen that is on display from a filter combination someone
   * typed once, and a foreground refresh fans out to all of them.
   * `useQuery` retains on mount and releases on unmount; the two are
   * refcounted, so React 18's double-invoked effects are harmless.
   */
  retainQuery: (options?: FetchOptions<Row>) => string
  releaseQuery: (options?: FetchOptions<Row>) => void

  // Mutations
  insert: (row: InsertRow) => Promise<TrackedRow<Row>>
  insertMany: (rows: InsertRow[]) => Promise<TrackedRow<Row>[]>
  update: (
    id: string | number,
    changes: UpdateRow,
  ) => Promise<TrackedRow<Row>>
  upsert: (row: InsertRow, options?: UpsertOptions) => Promise<TrackedRow<Row>>
  remove: (id: string | number) => Promise<void>
  removeWhere: (filters: FilterDescriptor<Row>[]) => Promise<void>

  // Local-only (no remote call)
  setRecord: (id: string | number, row: TrackedRow<Row>) => void
  removeRecord: (id: string | number) => void
  clearAll: () => void
  mergeRecords: (rows: Row[]) => void
  clearAndFetch: (options?: FetchOptions<Row>) => Promise<TrackedRow<Row>[]>

  // Realtime
  subscribe: (filter?: FilterDescriptor<Row>[]) => () => void
  unsubscribe: () => void

  // Persistence
  hydrate: () => Promise<void>
  persist: () => Promise<void>

  // Queue
  flushQueue: () => Promise<void>
  getQueueSize: () => number
}

/** Full store type = state + actions */
export type TableStore<
  Row,
  InsertRow,
  UpdateRow,
> = TableStoreState<Row> & TableStoreActions<Row, InsertRow, UpdateRow>

// ─── Mutation Queue Types ────────────────────────────────────────────

export type MutationId = string

export type MutationOperation = "INSERT" | "UPDATE" | "UPSERT" | "DELETE"

export type MutationStatus =
  | "pending"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "rolled_back"

export type QueuedMutation = {
  id: MutationId
  table: string
  operation: MutationOperation
  payload: Record<string, unknown> | null
  primaryKey: Record<string, unknown>
  dependsOn?: MutationId
  createdAt: number
  status: MutationStatus
  retryCount: number
  lastError?: string
  rollbackSnapshot: Record<string, unknown> | null
  /** User who enqueued this mutation (for multi-user isolation) */
  userId?: string
  /**
   * Carried for `UPSERT` only, so the replay writes the row the live call would
   * have written. Dropping it here would reproduce the missing-`onConflict` bug
   * **exclusively on the offline drain** — the one path with no user watching
   * and no test unless it is written on purpose.
   *
   * Optional, so a queue persisted before this field existed rehydrates
   * unchanged and replays with PostgREST's primary-key default, which is what
   * it was enqueued under.
   */
  upsertOptions?: UpsertOptions
}

// ─── Identifiers ─────────────────────────────────────────────────────

/**
 * A UUID: WebCrypto's where there is one, `Math.random`'s where there is not.
 *
 * The fallback is not decoration. Hermes ships no WebCrypto, so a React Native
 * app without a polyfill has no `crypto` global at all, and `crypto.randomUUID`
 * is equally absent from a non-secure browser context (plain HTTP anywhere but
 * localhost). `createTempId` guarded for exactly that from the start — and then
 * four other sites called `crypto.randomUUID()` bare: the mutation ids in
 * `update` and `upsert`, a queued mutation's own id, and `batchOperations`.
 * Between them that is the whole write path, offline or not, throwing
 * `crypto.randomUUID is not a function` on a device before any of this
 * machinery could run. One helper now, so the guard cannot be half-applied
 * again.
 *
 * These ids are local bookkeeping — a compare-and-swap token for a rollback, a
 * key for a queue entry. None is a security boundary, and none is a value the
 * server stores, so `Math.random` is an acceptable source when the real one is
 * missing. Do not reuse this for anything that needs to be unguessable.
 */
export function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  const s = (n: number) => Array.from({ length: n }, hex).join("")
  return `${s(8)}-${s(4)}-4${s(3)}-${s(4)}-${s(12)}`
}

// ─── Temp ID Management ──────────────────────────────────────────────

export const TEMP_ID_PREFIX = "_temp:" as const

export function createTempId(): string {
  return `${TEMP_ID_PREFIX}${randomId()}`
}

export function isTempId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(TEMP_ID_PREFIX)
}

// ─── Row Status Helpers ─────────────────────────────────────────────

/** Returns true if the row has a pending optimistic mutation. */
export function isPending<Row extends Partial<RecordMeta>>(row: Row): boolean {
  return row._anchor_pending != null
}

/** Returns the pending mutation type, or null if the row is confirmed. */
export function getPendingStatus<Row extends Partial<RecordMeta>>(
  row: Row,
): "insert" | "update" | "delete" | null {
  return row._anchor_pending ?? null
}

// ─── Persistence Adapter ─────────────────────────────────────────────

export interface PersistenceAdapter {
  getItem<T>(key: string): Promise<T | null>
  setItem<T>(key: string, value: T): Promise<void>
  removeItem(key: string): Promise<void>
  multiSet?(entries: [string, unknown][]): Promise<void>
  keys?(prefix?: string): Promise<string[]>
  clear?(): Promise<void>
}

// ─── Network Status Adapter ──────────────────────────────────────────

export interface NetworkStatusAdapter {
  isOnline(): boolean
  subscribe(callback: (online: boolean) => void): () => void
}

// ─── App Lifecycle Adapter ──────────────────────────────────────────

export interface AppLifecycleAdapter {
  onForeground(cb: () => void): () => void
  onBackground(cb: () => void): () => void
}

// ─── Background Task Adapter ────────────────────────────────────────

export interface BackgroundTaskAdapter {
  register(taskName: string, handler: () => Promise<void>): Promise<void>
  unregister(taskName: string): Promise<void>
  isRegistered(taskName: string): Promise<boolean>
}

// ─── Conflict Resolution ─────────────────────────────────────────────

export type ConflictStrategy =
  | "server-wins"
  | "client-wins"
  | "last-write-wins"
  | "field-merge"
  | "custom"

export type ConflictResolver<Row = Record<string, unknown>> = (
  local: TrackedRow<Row>,
  remote: Row,
  context: ConflictContext,
) => Row | null

export type ConflictContext = {
  table: string
  primaryKey: Record<string, unknown>
  hasPendingMutations: boolean
  pendingMutations: QueuedMutation[]
}

export type ConflictConfig<Row = Record<string, unknown>> = {
  strategy?: ConflictStrategy
  resolver?: ConflictResolver<Row>
  timestampColumn?: string
  serverOwnedFields?: string[]
  clientOwnedFields?: string[]
}

// ─── Auth Store Types ────────────────────────────────────────────────

export type AuthState = {
  session: import("@supabase/supabase-js").Session | null
  user: import("@supabase/supabase-js").User | null
  isLoading: boolean
  error: Error | null
  /** Parsed custom claims from the JWT access token */
  claims: Record<string, unknown>
}

export type AuthActions = {
  initialize: () => Promise<void>
  signIn: (credentials: {
    email: string
    password: string
  }) => Promise<void>
  signUp: (credentials: {
    email: string
    password: string
  }) => Promise<void>
  signOut: () => Promise<void>
  signInWithOAuth: (options: {
    provider: string
    redirectTo?: string
  }) => Promise<void>
  refreshSession: () => Promise<void>
  onAuthStateChange: () => () => void
  /**
   * Read a claim from the locally decoded access token. **Unverified** — the
   * payload is base64-decoded, not signature-checked. Fine for deciding what to
   * render, since no client-side check is a security boundary anyway; use
   * `getVerifiedClaims()` when the answer has to be trustworthy, and RLS when it
   * has to be enforced.
   */
  getClaim: (key: string) => unknown
  /**
   * Claims verified against the project's JWKS, via `supabase.auth.getClaims()`.
   *
   * Asynchronous because verification is: asymmetric keys are checked locally,
   * a legacy HS256 secret by asking the auth server.
   */
  getVerifiedClaims: () => Promise<{
    claims: Record<string, unknown> | null
    error: Error | null
  }>
}

export type AuthStore = AuthState & AuthActions

// ─── Hydration Types ─────────────────────────────────────────────────

export type HydrationPhase =
  | "idle"
  | "loading_local"
  | "populating_stores"
  | "fetching_remote"
  | "reconciling"
  | "replaying_queue"
  | "ready"
  | "error"

// ─── Sync Logger ─────────────────────────────────────────────────────

export interface SyncLogger {
  fetchStart(table: string): void
  fetchSuccess(table: string, count: number, durationMs: number): void
  fetchError(table: string, error: string): void
  mutationStart(table: string, operation: MutationOperation): void
  mutationSuccess(table: string, operation: MutationOperation, durationMs: number): void
  mutationError(table: string, operation: MutationOperation, error: string): void
  /**
   * A write that could not reach the server and was queued instead.
   *
   * Optional so every logger written against this interface keeps compiling.
   * Without it a queued write logs `mutationStart` and then nothing at all —
   * indistinguishable in a log from one that hung.
   */
  mutationQueued?(table: string, operation: MutationOperation): void
  queueFlushStart(count: number): void
  queueFlushSuccess(succeeded: number, failed: number): void
  conflict(table: string, id: string | number): void
  realtimeEvent(table: string, event: string): void
  /**
   * A channel that failed, timed out or closed.
   *
   * `subscribe()`'s callback carries a second `err` argument that Anchor used to
   * drop on the floor, so a `CHANNEL_ERROR` reached the store as a bare status
   * with no way to find out why. Optional, so every logger written against this
   * interface keeps compiling.
   */
  realtimeError?(table: string, status: string, error?: Error): void
}

export const noopLogger: SyncLogger = {
  fetchStart() {},
  fetchSuccess() {},
  fetchError() {},
  mutationStart() {},
  mutationSuccess() {},
  mutationError() {},
  mutationQueued() {},
  queueFlushStart() {},
  queueFlushSuccess() {},
  conflict() {},
  realtimeEvent() {},
  realtimeError() {},
}

export const consoleLogger: SyncLogger = {
  fetchStart(table) {
    console.log(`[anchor:${table}] fetch start`)
  },
  fetchSuccess(table, count, ms) {
    console.log(`[anchor:${table}] fetch success: ${count} rows in ${ms}ms`)
  },
  fetchError(table, error) {
    console.error(`[anchor:${table}] fetch error: ${error}`)
  },
  mutationStart(table, op) {
    console.log(`[anchor:${table}] ${op} start`)
  },
  mutationSuccess(table, op, ms) {
    console.log(`[anchor:${table}] ${op} success in ${ms}ms`)
  },
  mutationError(table, op, error) {
    console.error(`[anchor:${table}] ${op} error: ${error}`)
  },
  mutationQueued(table, op) {
    console.log(`[anchor:${table}] ${op} queued — server unreachable`)
  },
  queueFlushStart(count) {
    console.log(`[anchor:queue] flush start: ${count} mutations`)
  },
  queueFlushSuccess(succeeded, failed) {
    console.log(
      `[anchor:queue] flush done: ${succeeded} succeeded, ${failed} failed`,
    )
  },
  conflict(table, id) {
    console.warn(`[anchor:${table}] conflict on row ${id}`)
  },
  realtimeEvent(table, event) {
    console.log(`[anchor:${table}] realtime ${event}`)
  },
  realtimeError(table, status, error) {
    console.error(`[anchor:${table}] realtime ${status}`, error ?? "")
  },
}

// ─── Store Factory Options ───────────────────────────────────────────

export type CreateTableStoreOptions<
  DB,
  Row,
  InsertRow,
  UpdateRow,
  Extensions extends Record<string, unknown> = Record<string, never>,
> = {
  supabase: SupabaseClient<DB>
  table: string
  schema?: string
  primaryKey?: string | string[]

  // Query defaults
  defaultFilters?: FilterDescriptor<Row>[]
  defaultSort?: SortDescriptor<Row>[]
  defaultSelect?: string
  /**
   * Applied to every fetch that does not pass its own `queryFn`, for a source
   * that always needs the escape hatch: a PostgREST modifier the filter DSL has
   * no word for. Unlike a per-call `queryFn`, this one does not make queries
   * unkeyable — it is the same function for all of them, so
   * `filters`/`sort`/`select`/`limit`/`offset` still tell them apart and each
   * keeps its own loading state, error and count.
   *
   * **It must not change the shape of a row.** Only `fetch` goes through it:
   * `fetchOne` reads by primary key through its own builder, and each of the six
   * mutations reads its row back with `defaultSelect`, and all of them write into
   * the same `records` map every query then projects. A function that widens the
   * row — an embed, an extra column — therefore holds two shapes in one store,
   * and the narrow one is whatever the user just created or opened by id. Row
   * shape belongs to `defaultSelect`, which every one of those paths honours.
   */
  defaultQueryFn?: (builder: unknown) => unknown

  // Cache strategy
  cacheStrategy?: CacheStrategy

  // Persistence
  persistence?: {
    adapter: PersistenceAdapter
    key?: string
  }

  // Offline queue
  offlineQueue?: {
    enabled?: boolean
    maxRetries?: number
    flushDebounceMs?: number
    /** See `CreateSupabaseStoresOptions.offlineQueue.queueWrites`. */
    queueWrites?: boolean
  }

  // Network
  network?: NetworkStatusAdapter

  // Realtime
  realtime?: {
    enabled?: boolean
    events?: RealtimeEvent[]
    filter?: string | FilterDescriptor<Row>[]
    /** Restrict the postgres_changes payload to these columns. Must include the table's primary key. */
    select?: string[]
  }

  // Conflict
  conflict?: ConflictConfig<Row>

  // Middleware
  /** Pass the `immer` middleware from `zustand/middleware/immer` to enable draft-based mutations */
  immer?: (config: any) => any
  devtools?: boolean | { name?: string }

  // Validation
  validate?: {
    insert?: (data: InsertRow) => true | string[]
    update?: (data: UpdateRow) => true | string[]
  }

  // Logger
  logger?: SyncLogger

  // View mode (disables mutations)
  isView?: boolean

  // Cross-tab sync
  crossTab?: { enabled?: boolean; name?: string; sessionId?: string }

  /** @internal Used by createSupabaseStores to inject shared queue */
  _queue?: unknown

  /**
   * @internal Used by createSupabaseStores to inject the shared RealtimeManager.
   *
   * Without it `store.subscribe()` has nothing to subscribe *with*: one channel
   * per table is the manager's job, and a store opening its own would duplicate
   * the ones `createSupabaseStores` already opened.
   */
  _realtimeManager?: unknown

  // Extension
  extend?: (
    set: StoreApi<TableStore<Row, InsertRow, UpdateRow>>["setState"],
    get: StoreApi<TableStore<Row, InsertRow, UpdateRow>>["getState"],
    store: StoreApi<TableStore<Row, InsertRow, UpdateRow>>,
    supabase: SupabaseClient<DB>,
  ) => Extensions
}

// ─── Bulk Factory Options ────────────────────────────────────────────

export type CreateSupabaseStoresOptions<
  DB,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = {
  supabase: SupabaseClient<DB>
  schema?: SchemaName
  tables: TableNames<DB, SchemaName>[]
  /**
   * Views to back with a read-only store.
   *
   * A view is the route to a join here: `records` is keyed on a primary key and
   * realtime writes the flat `postgres_changes` payload into it, so an embedded
   * child collection is dropped by the first event after a fetch. A view is
   * flat, so it survives.
   *
   * They get the same store, persistence and auth-gate wiring as a table, minus
   * the two things that cannot apply: no offline-queue executor (a view is not
   * writable) and no realtime subscription (Postgres publishes changes under
   * the underlying TABLE's name, never the view's — subscribing to the view
   * would register a channel that never fires). A view whose freshness matters
   * needs a refetch trigger of its own.
   */
  views?: ViewNames<DB, SchemaName>[]

  // Global defaults
  persistence?: {
    adapter: PersistenceAdapter
    /**
     * Prepended to every table/view's own persistence key
     * (`anchor:${schema}:${table}` by default, from `createTableStore`).
     *
     * Without this, `createSupabaseStores` had no way to namespace a shared
     * `adapter` at all — `createTableStore`'s own `persistence.key` exists
     * one level down, but the bulk factory never exposed an equivalent, so a
     * caller wanting one (key rotation, multi-tenant namespacing on a shared
     * `localStorage`/`AsyncStorage`) had to reach below `createSupabaseStores`
     * entirely and hand-wrap the adapter itself.
     */
    keyPrefix?: string
  }
  network?: NetworkStatusAdapter
  /**
   * The shared mutation queue.
   *
   * `queueWrites` is what actually feeds it. Until it is on, `enqueue()` has no
   * caller anywhere in this package: the queue hydrates, auto-flushes and holds
   * an executor per table, and every mutator still calls Supabase directly and
   * throws when it cannot be reached.
   *
   * **Opt-in, and it stays opt-in**, because it changes what a failed write
   * does. Off, a write that cannot reach the server rolls back and rejects, so
   * a caller's `catch` fires and the row disappears. On, that same write
   * resolves with the optimistic row and is retried later — which is right for
   * an offline-first app and wrong for anything that treats a resolved promise
   * as "the server has it". A consumer must read `_anchor_pending` on the
   * returned row to tell the two apart; the promise alone no longer says.
   *
   * Only the single-row mutators queue: `insert`, `update`, `upsert` and
   * `remove`. `insertMany` and `removeWhere` keep rolling back and throwing —
   * see their notes in `createTableStore`.
   *
   * Two limitations to design around rather than discover:
   *
   * **Delivery is at-least-once.** A request whose response is lost is
   * indistinguishable from one that never arrived — postgrest-js reports both
   * as `status: 0` — so a write Postgres committed can be replayed on the
   * drain. An aborted request (a `fetch` timeout, or a caller's own
   * `AbortSignal`) reaches the same code path and is queued too. Make queued
   * writes idempotent: an `upsert` with `onConflict` naming a real unique
   * constraint replays harmlessly, a bare `insert` duplicates the row.
   *
   * **`remove` is the one mutator with no queued/sent signal**, because it
   * resolves to `void`: there is no row to carry `_anchor_pending`, and the row
   * is already gone from the store. A caller that needs to distinguish the two
   * has to read `getQueueSize()` or `usePendingChanges()`. If a queued delete is
   * later abandoned, the row comes back — correctly, since the delete never
   * happened, but possibly minutes after the interface said it was gone.
   *
   * `maxRetries` and `flushDebounceMs` reach the queue from here; before
   * `queueWrites` existed there was nothing in it to configure.
   *
   * **`maxRetries` defaults to 3, and past it a mutation is `rolled_back` —
   * removed from local state via `onRollback`, not merely abandoned.** That
   * default is a reasonable one for a todo app; it is very likely the wrong
   * one for a write that must never quietly disappear (a clinical check-in, a
   * financial record) once the *offline stretch* it can be exposed to may run
   * to hours or days rather than a few failed fetches in a row. Set it high
   * enough that "we gave up and deleted this" cannot happen within any
   * offline duration the app is meant to tolerate, and drive user-facing
   * "this still hasn't sent" messaging off `useSyncStatus`'s `failedCount` —
   * a read, not a reason to roll anything back.
   */
  offlineQueue?: {
    queueWrites?: boolean
    maxRetries?: number
    flushDebounceMs?: number
  }
  realtime?: { enabled?: boolean }
  conflict?: ConflictConfig
  cacheStrategy?: CacheStrategy
  /** Pass the `immer` middleware from `zustand/middleware/immer` */
  immer?: (config: any) => any
  devtools?: boolean
  logger?: SyncLogger

  // Per-table overrides
  tableOptions?: Partial<
    Record<
      TableNames<DB, SchemaName>,
      {
        primaryKey?: string | string[]
        defaultFilters?: FilterDescriptor[]
        defaultSort?: SortDescriptor[]
        defaultSelect?: string
        defaultQueryFn?: (builder: unknown) => unknown
        realtime?: {
          enabled?: boolean
          events?: RealtimeEvent[]
          filter?: string | FilterDescriptor[]
          /** Restrict the postgres_changes payload to these columns. Must include the table's primary key. */
          select?: string[]
        }
        conflict?: ConflictConfig
        cacheStrategy?: CacheStrategy
      }
    >
  >

  /**
   * Per-view overrides. The five keys that mean anything for a read-only
   * store — `realtime` and `conflict` are absent because neither applies.
   *
   * `primaryKey` is worth setting explicitly on almost every view: a generated
   * `Database` type marks every view column nullable, since Postgres infers no
   * NOT NULL through one, so the default `"id"` is not something to lean on. A
   * row that reaches the store without it fails the fetch rather than collapsing
   * onto another row's key.
   *
   * It is a single column, unlike `tableOptions`' — an aggregate or join view is
   * exactly where a composite key is tempting, and `createTableStore` throws on
   * one, which from inside this factory takes down every other store with it.
   * Point it at a column that is unique in the view's own output.
   */
  viewOptions?: Partial<
    Record<
      ViewNames<DB, SchemaName>,
      {
        primaryKey?: string
        defaultFilters?: FilterDescriptor[]
        defaultSort?: SortDescriptor[]
        defaultSelect?: string
        defaultQueryFn?: (builder: unknown) => unknown
        cacheStrategy?: CacheStrategy
      }
    >
  >

  // Hydration
  tableOrder?: TableNames<DB, SchemaName>[]
  fetchRemoteOnBoot?: boolean

  // Auth
  auth?: boolean
  /** Options forwarded to the internal auth gate (only used when auth is true) */
  authGate?: {
    /** Clear all table stores on sign-out (defaults to true) */
    clearOnSignOut?: boolean
    /** Refetch all table stores on sign-in (defaults to true) */
    refetchOnSignIn?: boolean
  }
}

/** Return type of createSupabaseStores */
export type SupabaseStores<
  DB,
  SchemaName extends string & keyof DB = "public" & keyof DB,
> = {
  [TableName in TableNames<DB, SchemaName>]: StoreApi<
    TableStore<
      TableRow<DB, TableName, SchemaName>,
      TableInsert<DB, TableName, SchemaName>,
      TableUpdate<DB, TableName, SchemaName>
    >
  >
} & {
  // A view store is a `TableStore` whose mutators throw, rather than a narrower
  // type: the runtime object is the same one, and typing the writes away would
  // hide `setRecord`/`mergeRecords`, which a view legitimately uses when
  // another store's write should show up in it before the next fetch.
  [ViewName in ViewNames<DB, SchemaName>]: StoreApi<
    TableStore<ViewRow<DB, ViewName, SchemaName>, never, never>
  >
} & {
  auth: StoreApi<AuthStore>
  _supabase: SupabaseClient<DB>
  _destroy: () => void
}
