// ─── Core Types ──────────────────────────────────────────────────────
export type {
  // Lifecycle & Background
  AppLifecycleAdapter,
  AuthActions,
  // Auth
  AuthState,
  AuthStore,
  BackgroundTaskAdapter,
  // Cache
  CacheStrategy,
  ConflictConfig,
  ConflictContext,
  ConflictResolver,
  // Conflict
  ConflictStrategy,
  CreateSupabaseStoresOptions,
  // Factory options
  CreateTableStoreOptions,
  DatabaseEnum,
  // Schema extraction
  ExtractSchema,
  FetchOptions,
  FilterDescriptor,
  // Filter & Query
  FilterOperator,
  FunctionNames,
  // Hydration
  HydrationPhase,
  // Mutation queue
  MutationId,
  MutationOperation,
  MutationStatus,
  NetworkStatusAdapter,
  // Persistence
  PersistenceAdapter,
  PrimaryKeyValue,
  QueryEntry,
  QueuedMutation,
  RealtimeEvent,
  RealtimeStatus,
  // Record tracking
  RecordMeta,
  RpcArgs,
  RpcReturns,
  SortDescriptor,
  SupabaseStores,
  // Logger
  SyncLogger,
  TableInsert,
  TableNames,
  TableRow,
  TableStore,
  TableStoreActions,
  // Store
  TableStoreState,
  TableUpdate,
  TrackedRow,
  UpsertOptions,
  ViewNames,
  ViewRow,
} from "./types.js"

// ─── Runtime Exports ─────────────────────────────────────────────────
export {
  consoleLogger,
  createTempId,
  getPendingStatus,
  isPending,
  isTempId,
  noopLogger,
  TEMP_ID_PREFIX,
} from "./types.js"

// ─── Client ──────────────────────────────────────────────────────────
export type {
  AnchorClient,
  AuthChangeEvent,
  AuthError,
  PostgrestError,
  Session,
  SupabaseClient,
  SupabaseClientOptions,
  User,
} from "./client/createClient.js"
export { createAnchorClient } from "./client/createClient.js"

// ─── Store Factories ─────────────────────────────────────────────────
export { createSupabaseStores } from "./createSupabaseStores.js"
export { createTableStore } from "./createTableStore.js"

// ─── Query ───────────────────────────────────────────────────────────
export type { AggregateFunction, AggregateResult } from "./query/aggregation.js"
export { aggregateLocal,aggregateRpc } from "./query/aggregation.js"
export {
asc, containedBy,   contains, desc,
  eq, gt, gte, ilike, inValues,
is,   like, lt, lte,
  match, neq, overlaps, textSearch,
} from "./query/filters.js"
export { matchRow } from "./query/matchRow.js"
export type { CursorPaginationOptions, PaginationState } from "./query/pagination.js"
export { buildCursorQuery, processCursorResults } from "./query/pagination.js"
export { query,QueryBuilder } from "./query/queryBuilder.js"
export {
  applyFilters, applySort,
  executeQuery, executeQueryOne, fromTable,
} from "./query/queryExecutor.js"
export { EMPTY_QUERY_KEY,isKeyable, queryKey } from "./query/queryKey.js"
export { selectAllRows, selectQueryRows, sortRows } from "./query/selectRows.js"

// ─── Errors ──────────────────────────────────────────────────────────
export {
  AnchorError,
  fromSupabaseError,
  isTransportError,
  PG_FOREIGN_KEY_VIOLATION,
  PG_INSUFFICIENT_PRIVILEGE,
  PG_UNIQUE_VIOLATION,
  PGRST_NO_ROWS,
} from "./errors.js"

// ─── Mutation ────────────────────────────────────────────────────────
export { removeMany,updateMany } from "./mutation/batchOperations.js"
export type { ConflictAuditEntry } from "./mutation/conflictAudit.js"
export { ConflictAuditLog } from "./mutation/conflictAudit.js"
export { fieldLevelMerge, lastWriteWins, localWins, remoteWins, resolveConflict } from "./mutation/conflictResolution.js"
export { createMutationExecutor,executeRemoteMutation } from "./mutation/mutationPipeline.js"
export type { FlushResult, MutationExecutor } from "./mutation/offlineQueue.js"
export { OfflineQueue } from "./mutation/offlineQueue.js"
export type { ValidationConfig,Validator } from "./mutation/validation.js"
export { runValidation,ValidationError, zodValidator } from "./mutation/validation.js"

// ─── Realtime ────────────────────────────────────────────────────────
export { bindRealtimeToStore } from "./realtime/realtimeBindings.js"
export { RealtimeManager } from "./realtime/realtimeManager.js"

// ─── Auth ────────────────────────────────────────────────────────────
export type {
  ResendOtpParams,
  SignUpOptions,
  UpdateUserAttributes,
} from "./auth/authActions.js"
export {
  getSession,
  getUser,
  resendOtp,
  signInWithPassword,
  signUpWithPassword,
  updateUser,
} from "./auth/authActions.js"
export type {
  AuthCallbackResult,
  AuthCallbackRoutes,
  AuthCallbackType,
  ParsedAuthCallback,
  VerifyOtpParams,
} from "./auth/authCallbacks.js"
export {
  createSessionFromUrl,
  getWebAuthRedirectTo,
  hasAuthCallbackParams,
  parseAuthCallbackUrl,
  resolveAuthRedirect,
  sendPasswordRecovery,
  verifyOtp,
  verifyRecoveryOTP,
} from "./auth/authCallbacks.js"
export { isRlsError,setupAuthGate } from "./auth/authGate.js"
export { createAuthStore } from "./auth/authStore.js"

// ─── Persistence ─────────────────────────────────────────────────────
export type { EncryptionFunctions } from "./persistence/encryptedAdapter.js"
export { createWebCryptoEncryption,EncryptedAdapter } from "./persistence/encryptedAdapter.js"
export { MemoryAdapter } from "./persistence/persistenceAdapter.js"
export type { SchemaVersionResult } from "./persistence/schemaVersion.js"
export { checkSchemaVersion, getSchemaVersion, setSchemaVersion } from "./persistence/schemaVersion.js"
export type { EvictionOptions,StorageUsage } from "./persistence/storageQuota.js"
export { StorageQuotaManager } from "./persistence/storageQuota.js"

// ─── Network ─────────────────────────────────────────────────────────
export { ManualNetworkStatus } from "./network/onlineManager.js"

// ─── Views ───────────────────────────────────────────────────────────
export type { CreateViewStoreOptions,ViewStore } from "./createViewStore.js"
export { createViewStore } from "./createViewStore.js"

// ─── RPC ─────────────────────────────────────────────────────────────
export type { RpcCacheOptions,RpcCallOptions, RpcResult } from "./rpc/rpcAction.js"
export { callRpc, createRpcAction, createSchemaRpc, invalidateRpcCache } from "./rpc/rpcAction.js"

// ─── Edge Functions ──────────────────────────────────────────────────
export type { EdgeFunctionResult, InvokeOptions } from "./functions/edgeFunctions.js"
export { createEdgeFunctionAction,invokeEdgeFunction } from "./functions/edgeFunctions.js"

// ─── Storage ─────────────────────────────────────────────────────────
export type { ListOptions, SignedUrlOptions,StorageResult, UploadOptions } from "./storage/storageActions.js"
export {
  createSignedUrl,   createStorageActions,
downloadFile, getPublicUrl,
listFiles, removeFiles,
  uploadFile, } from "./storage/storageActions.js"

// ─── Cross-Tab Sync ──────────────────────────────────────────────────
export { setupBroadcastSync, setupCrossTabSync, setupStorageFallback } from "./sync/crossTabSync.js"

// ─── Incremental Sync ────────────────────────────────────────────────
export { incrementalSync } from "./sync/incrementalSync.js"

// ─── Selective Sync ─────────────────────────────────────────────────
export type { PrioritizedStore,SelectiveSyncOptions } from "./sync/selectiveSync.js"
export { fetchPage,selectiveSync, syncAllByPriority } from "./sync/selectiveSync.js"

// ─── Multi-Device Sync ──────────────────────────────────────────────
export type { MultiDeviceSyncOptions } from "./sync/multiDeviceSync.js"
export { setupMultiDeviceSync } from "./sync/multiDeviceSync.js"

// ─── Background Sync ────────────────────────────────────────────────
export type { BackgroundSyncOptions } from "./sync/backgroundSync.js"
export { isBackgroundSyncRegistered,setupBackgroundSync } from "./sync/backgroundSync.js"

// ─── App Lifecycle ──────────────────────────────────────────────────
export type { AppLifecycleOptions } from "./lifecycle/appLifecycle.js"
export { setupAppLifecycle } from "./lifecycle/appLifecycle.js"

// ─── Sync Metrics ───────────────────────────────────────────────────
export type { MetricsSnapshot } from "./sync/syncMetrics.js"
export { SyncMetrics } from "./sync/syncMetrics.js"

// ─── Cache ───────────────────────────────────────────────────────────
export type { CacheConfig } from "./cache/cacheTtl.js"
export { fetchWithSwr, isExpired, isStale, setupAutoRevalidation } from "./cache/cacheTtl.js"

// ─── Composite Keys ─────────────────────────────────────────────────
export { applyPkFilters, buildPkFilter, encodeKey, normalizePk } from "./utils/compositeKey.js"

// ─── Retry ──────────────────────────────────────────────────────────
export type { RetryOptions } from "./utils/retry.js"
export { withRetry } from "./utils/retry.js"

// ─── Circuit Breaker ────────────────────────────────────────────────
export type { CircuitBreakerOptions,CircuitBreakerState } from "./utils/circuitBreaker.js"
export { CircuitBreaker, CircuitOpenError } from "./utils/circuitBreaker.js"

// ─── Rate Limiter ───────────────────────────────────────────────────
export type { RateLimiterOptions } from "./utils/rateLimiter.js"
export { RateLimiter } from "./utils/rateLimiter.js"

// ─── Hooks ───────────────────────────────────────────────────────────
export { useAppLifecycle } from "./hooks/useAppLifecycle.js"
export { useAuth } from "./hooks/useAuth.js"
export type { UseAuthCallbackOptions, UseAuthCallbackResult } from "./hooks/useAuthCallback.js"
export { useAuthCallback } from "./hooks/useAuthCallback.js"
export { useConflictNotifications } from "./hooks/useConflictNotifications.js"
export { useEdgeFunction } from "./hooks/useEdgeFunction.js"
export type { UseInfiniteQueryOptions, UseInfiniteQueryResult } from "./hooks/useInfiniteQuery.js"
export { useInfiniteQuery } from "./hooks/useInfiniteQuery.js"
export type { UseLinkedQueryResult } from "./hooks/useLinkedQuery.js"
export { useLinkedQuery } from "./hooks/useLinkedQuery.js"
export { useMutation } from "./hooks/useMutation.js"
export type { PendingChange } from "./hooks/usePendingChanges.js"
export { usePendingChanges } from "./hooks/usePendingChanges.js"
export { useQuery } from "./hooks/useQuery.js"
export type { QueueStatusResult } from "./hooks/useQueueStatus.js"
export { useQueueStatus } from "./hooks/useQueueStatus.js"
export { useRealtime } from "./hooks/useRealtime.js"
export { useRpc } from "./hooks/useRpc.js"
export { useStorage } from "./hooks/useStorage.js"
export type { UseStorageQuotaResult } from "./hooks/useStorageQuota.js"
export { useStorageQuota } from "./hooks/useStorageQuota.js"
export { useSuspenseQuery } from "./hooks/useSuspenseQuery.js"
export { useSyncMetrics } from "./hooks/useSyncMetrics.js"
export type { SyncStatus, SyncStatusResult } from "./hooks/useSyncStatus.js"
export { computeSyncStatus,useSyncStatus } from "./hooks/useSyncStatus.js"
export { createTableHook, useRecord,useRecords } from "./hooks/useTableStore.js"

// ─── Server ──────────────────────────────────────────────────────────
export type { PrefetchResult } from "./server/prefetch.js"
export { deserializePrefetchResult,prefetch, serializePrefetchResult } from "./server/prefetch.js"
