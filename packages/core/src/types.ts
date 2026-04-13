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

export type FetchOptions<Row = Record<string, unknown>> = {
  filters?: FilterDescriptor<Row>[]
  sort?: SortDescriptor<Row>[]
  limit?: number
  offset?: number
  select?: string
  count?: "exact" | "planned" | "estimated"
  /** Escape hatch: direct access to the PostgREST query builder */
  queryFn?: (builder: unknown) => unknown
  /** Override the store's default cache strategy for this fetch */
  cacheStrategy?: CacheStrategy
}

// ─── Table Store State ───────────────────────────────────────────────

export type TableStoreState<Row> = {
  /** Normalized record map keyed by primary key value */
  records: Map<string | number, TrackedRow<Row>>
  /** Ordered array of primary key values (preserves query ordering) */
  order: (string | number)[]
  /** Loading state */
  isLoading: boolean
  /** Error from last operation */
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
  refetch: () => Promise<TrackedRow<Row>[]>

  // Mutations
  insert: (row: InsertRow) => Promise<TrackedRow<Row>>
  insertMany: (rows: InsertRow[]) => Promise<TrackedRow<Row>[]>
  update: (
    id: string | number,
    changes: UpdateRow,
  ) => Promise<TrackedRow<Row>>
  upsert: (row: InsertRow) => Promise<TrackedRow<Row>>
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
}

// ─── Temp ID Management ──────────────────────────────────────────────

export const TEMP_ID_PREFIX = "_temp:" as const

export function createTempId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${TEMP_ID_PREFIX}${crypto.randomUUID()}`
  }
  // Fallback for non-secure contexts (HTTP, some React Native environments)
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  const s = (n: number) => Array.from({ length: n }, hex).join("")
  return `${TEMP_ID_PREFIX}${s(8)}-${s(4)}-4${s(3)}-${s(4)}-${s(12)}`
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
  /** Get a specific claim from the JWT access token */
  getClaim: (key: string) => unknown
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
  queueFlushStart(count: number): void
  queueFlushSuccess(succeeded: number, failed: number): void
  conflict(table: string, id: string | number): void
  realtimeEvent(table: string, event: string): void
}

export const noopLogger: SyncLogger = {
  fetchStart() {},
  fetchSuccess() {},
  fetchError() {},
  mutationStart() {},
  mutationSuccess() {},
  mutationError() {},
  queueFlushStart() {},
  queueFlushSuccess() {},
  conflict() {},
  realtimeEvent() {},
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
  }

  // Network
  network?: NetworkStatusAdapter

  // Realtime
  realtime?: {
    enabled?: boolean
    events?: RealtimeEvent[]
    filter?: string
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

  // Global defaults
  persistence?: { adapter: PersistenceAdapter }
  network?: NetworkStatusAdapter
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
        realtime?: {
          enabled?: boolean
          events?: RealtimeEvent[]
          filter?: string
        }
        conflict?: ConflictConfig
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
  auth: StoreApi<AuthStore>
  _supabase: SupabaseClient<DB>
  _destroy: () => void
}
