import type {
  QueuedMutation,
  MutationId,
  PersistenceAdapter,
  NetworkStatusAdapter,
  SyncLogger,
} from "../types.js"
import { noopLogger } from "../types.js"

export type FlushResult = {
  succeeded: MutationId[]
  failed: MutationId[]
  rolledBack: MutationId[]
  complete: boolean
}

export type MutationExecutor = (
  mutation: QueuedMutation,
  tempIdMap: Map<string, unknown>,
) => Promise<{ serverId?: unknown }>

type OfflineQueueOptions = {
  adapter?: PersistenceAdapter
  network?: NetworkStatusAdapter
  maxRetries?: number
  flushDebounceMs?: number
  /** Base delay for exponential backoff in ms (default: 1000) */
  retryBaseDelay?: number
  logger?: SyncLogger
  onRollback?: (mutation: QueuedMutation) => void
  onTempIdResolved?: (
    tempId: string,
    realId: unknown,
    table: string,
  ) => void
}

const QUEUE_KEY = "anchor:__mutation_queue"
const TEMP_ID_MAP_KEY = "anchor:__temp_id_map"

/**
 * Persistent FIFO mutation queue with coalescing, retry, and auto-flush.
 */
export class OfflineQueue {
  private queue: QueuedMutation[] = []
  private executors = new Map<string, MutationExecutor>()
  private flushing = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private unsubNetwork: (() => void) | null = null
  /** Persisted temp ID → real ID mappings that survive across flushes */
  private persistedTempIdMap = new Map<string, unknown>()
  /** Current user ID for mutation attribution and isolation */
  private currentUserId: string | undefined

  private readonly adapter?: PersistenceAdapter
  private readonly network?: NetworkStatusAdapter
  private readonly maxRetries: number
  private readonly flushDebounceMs: number
  private readonly retryBaseDelay: number
  private readonly logger: SyncLogger
  private readonly onRollback?: (mutation: QueuedMutation) => void
  private readonly onTempIdResolved?: (
    tempId: string,
    realId: unknown,
    table: string,
  ) => void

  constructor(options: OfflineQueueOptions = {}) {
    this.adapter = options.adapter
    this.network = options.network
    this.maxRetries = options.maxRetries ?? 3
    this.flushDebounceMs = options.flushDebounceMs ?? 2000
    this.retryBaseDelay = options.retryBaseDelay ?? 1000
    this.logger = options.logger ?? noopLogger
    this.onRollback = options.onRollback
    this.onTempIdResolved = options.onTempIdResolved
  }

  // ── User Context ─────────────────────────────────────────────────

  /**
   * Set the current user ID. Mutations enqueued after this call
   * will be tagged with this userId. On flush, only mutations
   * matching the current userId (or untagged) are executed.
   */
  setUserId(userId: string | undefined): void {
    this.currentUserId = userId
  }

  // ── Registration ─────────────────────────────────────────────────

  registerExecutor(table: string, executor: MutationExecutor): void {
    this.executors.set(table, executor)
  }

  // ── Hydration ────────────────────────────────────────────────────

  async hydrate(): Promise<void> {
    if (!this.adapter) return
    const data = await this.adapter.getItem<QueuedMutation[]>(QUEUE_KEY)
    if (data && Array.isArray(data)) {
      this.queue = data.filter(
        (m) => m.status === "pending" || m.status === "failed",
      )
    }
    // Restore persisted temp ID mappings from previous flushes
    const tempIdData = await this.adapter.getItem<[string, unknown][]>(TEMP_ID_MAP_KEY)
    if (tempIdData && Array.isArray(tempIdData)) {
      this.persistedTempIdMap = new Map(tempIdData)
    }
  }

  // ── Enqueue ──────────────────────────────────────────────────────

  async enqueue(mutation: QueuedMutation): Promise<void> {
    if (!this.executors.has(mutation.table)) {
      console.warn(`[anchor:queue] No executor registered for table "${mutation.table}" — mutation may not flush`)
    }
    // Tag with current user for multi-user isolation
    if (this.currentUserId && !mutation.userId) {
      mutation.userId = this.currentUserId
    }
    this.queue.push(mutation)
    await this.persist()
    this.scheduleFlush()
  }

  // ── Coalescing ───────────────────────────────────────────────────

  compact(): void {
    const compacted: QueuedMutation[] = []
    const seen = new Map<string, number>() // row key → index in compacted
    // Which mutation absorbed each one that coalescing removes, so a third
    // mutation pointing at a removed id can be repointed at whatever now
    // carries its work. `undefined` means the work is gone entirely.
    //
    // Without this, `UPDATE + DELETE` alone is enough to wedge the queue: the
    // DELETE replaces the UPDATE and keeps its own id, and its `dependsOn`
    // still names the UPDATE that no longer exists — so `flush` skips it on
    // every pass, waiting for a mutation that can never succeed.
    const absorbedBy = new Map<MutationId, MutationId | undefined>()

    for (const mutation of this.queue) {
      if (mutation.status !== "pending") {
        compacted.push(mutation)
        continue
      }

      const rowKey = `${mutation.table}:${JSON.stringify(mutation.primaryKey)}`
      const existingIdx = seen.get(rowKey)

      if (existingIdx == null) {
        seen.set(rowKey, compacted.length)
        compacted.push(mutation)
        continue
      }

      const existing = compacted[existingIdx]!

      // INSERT + UPDATE → single INSERT with merged payload
      if (
        existing.operation === "INSERT" &&
        mutation.operation === "UPDATE"
      ) {
        existing.payload = { ...existing.payload, ...mutation.payload }
        absorbedBy.set(mutation.id, existing.id)
        continue
      }

      // INSERT + DELETE → remove both
      if (
        existing.operation === "INSERT" &&
        mutation.operation === "DELETE"
      ) {
        compacted.splice(existingIdx, 1)
        // Fix indices in seen map
        for (const [key, idx] of seen) {
          if (idx > existingIdx) seen.set(key, idx - 1)
        }
        seen.delete(rowKey)
        absorbedBy.set(existing.id, undefined)
        absorbedBy.set(mutation.id, undefined)
        continue
      }

      // UPDATE + UPDATE → single UPDATE with merged payload
      if (
        existing.operation === "UPDATE" &&
        mutation.operation === "UPDATE"
      ) {
        existing.payload = { ...existing.payload, ...mutation.payload }
        absorbedBy.set(mutation.id, existing.id)
        continue
      }

      // UPDATE + DELETE → single DELETE
      if (
        existing.operation === "UPDATE" &&
        mutation.operation === "DELETE"
      ) {
        compacted[existingIdx] = {
          ...mutation,
          rollbackSnapshot: existing.rollbackSnapshot,
        }
        absorbedBy.set(existing.id, mutation.id)
        continue
      }

      // Default: keep both
      seen.set(rowKey, compacted.length)
      compacted.push(mutation)
    }

    // Repoint every dependency that coalescing moved or removed. Chains are
    // followed (A absorbed into B, B into C) and bounded by the map's size, and
    // a mutation that ends up depending on itself — which is what
    // `UPDATE + DELETE` produces — depends on nothing.
    for (const mutation of compacted) {
      let target = mutation.dependsOn
      for (let hops = 0; target != null && absorbedBy.has(target); hops++) {
        if (hops > absorbedBy.size) { target = undefined; break }
        target = absorbedBy.get(target)
      }
      mutation.dependsOn = target === mutation.id ? undefined : target
    }

    this.queue = compacted
  }

  // ── Flush ────────────────────────────────────────────────────────

  async flush(): Promise<FlushResult> {
    if (this.flushing) {
      return { succeeded: [], failed: [], rolledBack: [], complete: false }
    }

    if (this.network && !this.network.isOnline()) {
      return { succeeded: [], failed: [], rolledBack: [], complete: false }
    }

    this.flushing = true

    try {
      this.compact()

      const pending = this.queue.filter(
        (m) =>
          (m.status === "pending" || m.status === "failed") &&
          // Skip mutations belonging to a different user
          (!m.userId || !this.currentUserId || m.userId === this.currentUserId),
      )

      if (pending.length === 0) {
        return { succeeded: [], failed: [], rolledBack: [], complete: true }
      }

      this.logger.queueFlushStart(pending.length)

      const result: FlushResult = {
        succeeded: [],
        failed: [],
        rolledBack: [],
        complete: false,
      }

      // Seed with persisted mappings from previous flushes, then add new ones
      const tempIdMap = new Map<string, unknown>(this.persistedTempIdMap)
      const succeededIds = new Set<MutationId>()
      const rolledBackIds = new Set<MutationId>()

      for (const mutation of pending) {
        // Enforce dependsOn: skip if dependency hasn't succeeded yet
        if (mutation.dependsOn) {
          if (rolledBackIds.has(mutation.dependsOn)) {
            // Dependency was rolled back — cascade rollback
            mutation.status = "rolled_back"
            mutation.lastError = `Dependency ${mutation.dependsOn} was rolled back`
            result.rolledBack.push(mutation.id)
            rolledBackIds.add(mutation.id)
            this.onRollback?.(mutation)
            continue
          }
          if (!succeededIds.has(mutation.dependsOn)) {
            // Dependency hasn't succeeded in this flush — skip for next flush
            continue
          }
        }

        const executor = this.executors.get(mutation.table)
        if (!executor) {
          result.failed.push(mutation.id)
          mutation.status = "failed"
          mutation.lastError = `No executor registered for table: ${mutation.table}`
          continue
        }

        mutation.status = "in_flight"

        try {
          const { serverId } = await executor(mutation, tempIdMap)

          // Track temp ID resolution for all PK columns (supports composite keys).
          //
          // UPSERT counts as well as INSERT: an upsert identified by `onConflict`
          // carries no primary key, so the store mints a temp id for it exactly
          // as it does for an insert. Registering only INSERTs left any later
          // queued write to that row replaying `.eq(pk, '_temp:…')` against a
          // uuid column, which errors on every flush and never resolves.
          if (
            serverId != null &&
            (mutation.operation === "INSERT" || mutation.operation === "UPSERT")
          ) {
            for (const pkValue of Object.values(mutation.primaryKey)) {
              if (
                typeof pkValue === "string" &&
                pkValue.startsWith("_temp:")
              ) {
                tempIdMap.set(pkValue, serverId)
                this.persistedTempIdMap.set(pkValue, serverId)
                this.onTempIdResolved?.(pkValue, serverId, mutation.table)
              }
            }
          }

          mutation.status = "succeeded"
          result.succeeded.push(mutation.id)
          succeededIds.add(mutation.id)

          // Release anything waiting on it, now, rather than relying on
          // `succeededIds` still being around when that dependent runs.
          // Succeeded mutations are pruned at the end of this flush, so a
          // dependent that does not execute in the same pass — its own turn
          // came after another mutation failed and broke the loop, or it failed
          // once and is being retried — would find its dependency gone from
          // both the queue and `succeededIds` and be skipped on every future
          // flush. Stranded silently: no error, no rollback, `pendingCount`
          // simply never reaching zero.
          for (const other of this.queue) {
            if (other.dependsOn === mutation.id) other.dependsOn = undefined
          }
        } catch (err) {
          mutation.retryCount++
          const errorMessage =
            err instanceof Error ? err.message : String(err)
          mutation.lastError = errorMessage

          if (mutation.retryCount > this.maxRetries) {
            mutation.status = "rolled_back"
            result.rolledBack.push(mutation.id)
            rolledBackIds.add(mutation.id)
            this.onRollback?.(mutation)
          } else {
            mutation.status = "failed"
            result.failed.push(mutation.id)
            // Stop on first failure
            break
          }
        }
      }

      // Prune succeeded and rolled-back mutations in-place to avoid
      // losing mutations enqueued during flush (race condition fix)
      const pruneStatuses = new Set(["succeeded", "rolled_back"])
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (pruneStatuses.has(this.queue[i]!.status)) {
          this.queue.splice(i, 1)
        }
      }

      await this.persist()
      await this.persistTempIdMap()

      result.complete = result.failed.length === 0
      this.logger.queueFlushSuccess(
        result.succeeded.length,
        result.failed.length,
      )

      // Schedule retry with backoff if there are failed mutations
      if (result.failed.length > 0) {
        const maxAttempt = Math.max(
          ...this.queue
            .filter((m) => m.status === "failed")
            .map((m) => m.retryCount),
          0,
        )
        this.scheduleFlush(maxAttempt)
      }

      return result
    } finally {
      this.flushing = false
    }
  }

  // ── Auto-flush ───────────────────────────────────────────────────

  /** Calculate exponential backoff delay with jitter */
  private getRetryDelay(attempt: number): number {
    const exponential = this.retryBaseDelay * Math.pow(2, attempt)
    const jitter = Math.random() * this.retryBaseDelay
    return exponential + jitter
  }

  scheduleFlush(retryAttempt?: number): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    const delay = retryAttempt != null
      ? this.getRetryDelay(retryAttempt)
      : this.flushDebounceMs
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush().catch((err) => {
        this.logger.mutationError("__queue", "FLUSH" as any, err instanceof Error ? err.message : String(err))
      })
    }, delay)
  }

  cancelFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  startAutoFlush(): void {
    if (!this.network) return
    this.unsubNetwork = this.network.subscribe((online) => {
      if (online && this.isDirty) {
        this.scheduleFlush()
      }
    })
  }

  stopAutoFlush(): void {
    this.unsubNetwork?.()
    this.unsubNetwork = null
    this.cancelFlush()
  }

  // ── Accessors ────────────────────────────────────────────────────

  get pendingCount(): number {
    return this.queue.filter(
      (m) => m.status === "pending" || m.status === "failed",
    ).length
  }

  get isDirty(): boolean {
    return this.pendingCount > 0
  }

  get pendingMutations(): QueuedMutation[] {
    return this.queue.filter(
      (m) => m.status === "pending" || m.status === "failed",
    )
  }

  // ── Persistence ──────────────────────────────────────────────────

  private async persist(): Promise<void> {
    if (!this.adapter) return
    try {
      await this.adapter.setItem(QUEUE_KEY, this.queue)
    } catch (err) {
      this.logger.mutationError(
        "__queue",
        "PERSIST" as any,
        `Failed to persist queue: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private async persistTempIdMap(): Promise<void> {
    if (!this.adapter || this.persistedTempIdMap.size === 0) return
    try {
      await this.adapter.setItem(TEMP_ID_MAP_KEY, [...this.persistedTempIdMap.entries()])
    } catch (err) {
      this.logger.mutationError(
        "__queue",
        "PERSIST" as any,
        `Failed to persist temp ID map: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  /**
   * Clear all queued mutations and persisted state without stopping auto-flush.
   * Use on sign-out to prevent orphaned mutations from executing under a different user.
   */
  async clearQueue(): Promise<void> {
    this.queue = []
    this.persistedTempIdMap.clear()
    await this.persist()
    await this.persistTempIdMap()
  }

  destroy(): void {
    this.stopAutoFlush()
    this.queue = []
  }
}
