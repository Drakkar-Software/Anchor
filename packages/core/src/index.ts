// ─── Core Types ──────────────────────────────────────────────────────
export type {
  // Schema extraction
  ExtractSchema,
  TableNames,
  TableRow,
  TableInsert,
  TableUpdate,
  DatabaseEnum,
  // Record tracking
  RecordMeta,
  TrackedRow,
  // Filter & Query
  FilterOperator,
  FilterDescriptor,
  SortDescriptor,
  FetchOptions,
  // Store
  TableStoreState,
  TableStoreActions,
  TableStore,
  RealtimeStatus,
  RealtimeEvent,
  // Mutation queue
  MutationId,
  MutationOperation,
  MutationStatus,
  QueuedMutation,
  // Persistence
  PersistenceAdapter,
  NetworkStatusAdapter,
  // Cache
  CacheStrategy,
  // Conflict
  ConflictStrategy,
  ConflictResolver,
  ConflictContext,
  ConflictConfig,
  // Auth
  AuthState,
  AuthActions,
  AuthStore,
  // Hydration
  HydrationPhase,
  // Logger
  SyncLogger,
  // Lifecycle & Background
  AppLifecycleAdapter,
  BackgroundTaskAdapter,
  // Factory options
  CreateTableStoreOptions,
  CreateSupabaseStoresOptions,
  SupabaseStores,
} from "./types.js"

// ─── Runtime Exports ─────────────────────────────────────────────────
export {
  TEMP_ID_PREFIX,
  createTempId,
  isTempId,
  isPending,
  getPendingStatus,
  noopLogger,
  consoleLogger,
} from "./types.js"

// ─── Store Factories ─────────────────────────────────────────────────
export { createTableStore } from "./createTableStore.js"
export { createSupabaseStores } from "./createSupabaseStores.js"

// ─── Query ───────────────────────────────────────────────────────────
export {
  eq, neq, gt, gte, lt, lte,
  like, ilike, is, inValues,
  contains, containedBy, overlaps, textSearch,
  match, asc, desc,
} from "./query/filters.js"
export {
  applyFilters, applySort,
  executeQuery, executeQueryOne, fromTable,
} from "./query/queryExecutor.js"
export { QueryBuilder, query } from "./query/queryBuilder.js"
export { buildCursorQuery, processCursorResults } from "./query/pagination.js"
export type { CursorPaginationOptions, PaginationState } from "./query/pagination.js"
export { aggregateRpc, aggregateLocal } from "./query/aggregation.js"
export type { AggregateFunction, AggregateResult } from "./query/aggregation.js"

// ─── Mutation ────────────────────────────────────────────────────────
export { OfflineQueue } from "./mutation/offlineQueue.js"
export type { FlushResult, MutationExecutor } from "./mutation/offlineQueue.js"
export { executeRemoteMutation, createMutationExecutor } from "./mutation/mutationPipeline.js"
export { remoteWins, localWins, lastWriteWins, fieldLevelMerge, resolveConflict } from "./mutation/conflictResolution.js"
export { ValidationError, zodValidator, runValidation } from "./mutation/validation.js"
export type { Validator, ValidationConfig } from "./mutation/validation.js"
export { updateMany, removeMany } from "./mutation/batchOperations.js"
export { ConflictAuditLog } from "./mutation/conflictAudit.js"
export type { ConflictAuditEntry } from "./mutation/conflictAudit.js"

// ─── Realtime ────────────────────────────────────────────────────────
export { RealtimeManager } from "./realtime/realtimeManager.js"
export { bindRealtimeToStore } from "./realtime/realtimeBindings.js"

// ─── Auth ────────────────────────────────────────────────────────────
export { createAuthStore } from "./auth/authStore.js"
export { setupAuthGate, isRlsError } from "./auth/authGate.js"
export {
  parseAuthCallbackUrl,
  hasAuthCallbackParams,
  createSessionFromUrl,
  getWebAuthRedirectTo,
  sendPasswordRecovery,
  verifyRecoveryOTP,
} from "./auth/authCallbacks.js"
export type {
  AuthCallbackType,
  ParsedAuthCallback,
  AuthCallbackResult,
} from "./auth/authCallbacks.js"

// ─── Persistence ─────────────────────────────────────────────────────
export { MemoryAdapter } from "./persistence/persistenceAdapter.js"
export { EncryptedAdapter, createWebCryptoEncryption } from "./persistence/encryptedAdapter.js"
export type { EncryptionFunctions } from "./persistence/encryptedAdapter.js"
export { StorageQuotaManager } from "./persistence/storageQuota.js"
export type { StorageUsage, EvictionOptions } from "./persistence/storageQuota.js"
export { checkSchemaVersion, getSchemaVersion, setSchemaVersion } from "./persistence/schemaVersion.js"
export type { SchemaVersionResult } from "./persistence/schemaVersion.js"

// ─── Network ─────────────────────────────────────────────────────────
export { ManualNetworkStatus } from "./network/onlineManager.js"

// ─── Views ───────────────────────────────────────────────────────────
export { createViewStore } from "./createViewStore.js"
export type { ViewStore, CreateViewStoreOptions } from "./createViewStore.js"

// ─── RPC ─────────────────────────────────────────────────────────────
export { callRpc, createRpcAction, invalidateRpcCache } from "./rpc/rpcAction.js"
export type { RpcResult, RpcCallOptions, RpcCacheOptions } from "./rpc/rpcAction.js"

// ─── Edge Functions ──────────────────────────────────────────────────
export { invokeEdgeFunction, createEdgeFunctionAction } from "./functions/edgeFunctions.js"
export type { EdgeFunctionResult, InvokeOptions } from "./functions/edgeFunctions.js"

// ─── Storage ─────────────────────────────────────────────────────────
export {
  uploadFile, downloadFile, getPublicUrl,
  createSignedUrl, listFiles, removeFiles,
  createStorageActions,
} from "./storage/storageActions.js"
export type { StorageResult, UploadOptions, ListOptions, SignedUrlOptions } from "./storage/storageActions.js"

// ─── Cross-Tab Sync ──────────────────────────────────────────────────
export { setupCrossTabSync, setupBroadcastSync, setupStorageFallback } from "./sync/crossTabSync.js"

// ─── Incremental Sync ────────────────────────────────────────────────
export { incrementalSync } from "./sync/incrementalSync.js"

// ─── Selective Sync ─────────────────────────────────────────────────
export { selectiveSync, syncAllByPriority, fetchPage } from "./sync/selectiveSync.js"
export type { SelectiveSyncOptions, PrioritizedStore } from "./sync/selectiveSync.js"

// ─── Multi-Device Sync ──────────────────────────────────────────────
export { setupMultiDeviceSync } from "./sync/multiDeviceSync.js"
export type { MultiDeviceSyncOptions } from "./sync/multiDeviceSync.js"

// ─── Background Sync ────────────────────────────────────────────────
export { setupBackgroundSync, isBackgroundSyncRegistered } from "./sync/backgroundSync.js"
export type { BackgroundSyncOptions } from "./sync/backgroundSync.js"

// ─── App Lifecycle ──────────────────────────────────────────────────
export { setupAppLifecycle } from "./lifecycle/appLifecycle.js"
export type { AppLifecycleOptions } from "./lifecycle/appLifecycle.js"

// ─── Sync Metrics ───────────────────────────────────────────────────
export { SyncMetrics } from "./sync/syncMetrics.js"
export type { MetricsSnapshot } from "./sync/syncMetrics.js"

// ─── Cache ───────────────────────────────────────────────────────────
export { isStale, isExpired, fetchWithSwr, setupAutoRevalidation } from "./cache/cacheTtl.js"
export type { CacheConfig } from "./cache/cacheTtl.js"

// ─── Composite Keys ─────────────────────────────────────────────────
export { encodeKey, buildPkFilter, applyPkFilters, normalizePk } from "./utils/compositeKey.js"

// ─── Retry ──────────────────────────────────────────────────────────
export { withRetry } from "./utils/retry.js"
export type { RetryOptions } from "./utils/retry.js"

// ─── Circuit Breaker ────────────────────────────────────────────────
export { CircuitBreaker, CircuitOpenError } from "./utils/circuitBreaker.js"
export type { CircuitBreakerState, CircuitBreakerOptions } from "./utils/circuitBreaker.js"

// ─── Rate Limiter ───────────────────────────────────────────────────
export { RateLimiter } from "./utils/rateLimiter.js"
export type { RateLimiterOptions } from "./utils/rateLimiter.js"

// ─── Hooks ───────────────────────────────────────────────────────────
export { createTableHook, useRecords, useRecord } from "./hooks/useTableStore.js"
export { useQuery } from "./hooks/useQuery.js"
export { useMutation } from "./hooks/useMutation.js"
export { useAuth } from "./hooks/useAuth.js"
export { useRealtime } from "./hooks/useRealtime.js"
export { useRpc } from "./hooks/useRpc.js"
export { useEdgeFunction } from "./hooks/useEdgeFunction.js"
export { useStorage } from "./hooks/useStorage.js"
export { useSuspenseQuery } from "./hooks/useSuspenseQuery.js"
export { useAppLifecycle } from "./hooks/useAppLifecycle.js"
export { useSyncMetrics } from "./hooks/useSyncMetrics.js"
export { useConflictNotifications } from "./hooks/useConflictNotifications.js"
export { useSyncStatus, computeSyncStatus } from "./hooks/useSyncStatus.js"
export type { SyncStatus, SyncStatusResult } from "./hooks/useSyncStatus.js"
export { useQueueStatus } from "./hooks/useQueueStatus.js"
export type { QueueStatusResult } from "./hooks/useQueueStatus.js"
export { usePendingChanges } from "./hooks/usePendingChanges.js"
export type { PendingChange } from "./hooks/usePendingChanges.js"
export { useStorageQuota } from "./hooks/useStorageQuota.js"
export type { UseStorageQuotaResult } from "./hooks/useStorageQuota.js"
export { useLinkedQuery } from "./hooks/useLinkedQuery.js"
export type { UseLinkedQueryResult } from "./hooks/useLinkedQuery.js"
export { useInfiniteQuery } from "./hooks/useInfiniteQuery.js"
export type { UseInfiniteQueryOptions, UseInfiniteQueryResult } from "./hooks/useInfiniteQuery.js"
export { useAuthCallback } from "./hooks/useAuthCallback.js"
export type { UseAuthCallbackOptions, UseAuthCallbackResult } from "./hooks/useAuthCallback.js"

// ─── Server ──────────────────────────────────────────────────────────
export { prefetch, serializePrefetchResult, deserializePrefetchResult } from "./server/prefetch.js"
export type { PrefetchResult } from "./server/prefetch.js"
