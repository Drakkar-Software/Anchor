import {
  type MutationId,
  type NetworkStatusAdapter,
 noopLogger,  type PersistenceAdapter,
  type QueuedMutation,
  type SyncLogger } from "../types.js"

export type FlushResult = {
  complete: boolean
  failed: MutationId[]
  rolledBack: MutationId[]
  succeeded: MutationId[]
}

export type MutationExecutor = (
  mutation: QueuedMutation,
  tempIdMap: Map<string, unknown>,
) => Promise<{ serverId?: unknown }>

type OfflineQueueOptions = {
  adapter?: PersistenceAdapter
  flushDebounceMs?: number
  logger?: SyncLogger
  maxRetries?: number
  network?: NetworkStatusAdapter
  onRollback?: (mutation: QueuedMutation) => void
  onTempIdResolved?: (
    tempId: string,
    realId: unknown,
    table: string,
  ) => void

  /** Base delay for exponential backoff in ms (default: 1000) */
  retryBaseDelay?: number
}

const QUEUE_KEY = "anchor:__mutation_queue"
const TEMP_ID_MAP_KEY = "anchor:__temp_id_map"

/**
 * Persistent FIFO mutation queue with coalescing, retry, and auto-flush.
 */
export class OfflineQueue {
  private queue: QueuedMutation[] = []

  private readonly executors = new Map<string, MutationExecutor>()

  private flushing = false


  /**
   * A flush was asked for while one was already running, and the work it was
   * asked for is not in the batch that is running — `pending` is captured
   * before the first `await`. See the re-arm in `flush`'s `finally`.
   */
  private flushRequestedWhileRunning = false

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
   * Set the current user ID. Mutations enqueued after this call are tagged with
   * it, and on flush only mutations carrying this same id — or no id at all —
   * are executed.
   *
   * **`undefined` means nobody is signed in, and a tagged mutation therefore
   * waits rather than running.** It used to mean the opposite: the filter read
   * `!m.userId || !this.currentUserId || m.userId === this.currentUserId`, so
   * clearing the user made every tagged mutation eligible. That is precisely
   * the state right after SIGNED_OUT — supabase-js emits it on its own once a
   * refresh token finally fails to renew, which is how a long offline session
   * ends — and the queue would then replay a signed-in user's writes with no
   * JWT, as `anon`, where RLS refuses them `42501`. A refusal is correctly not
   * a transport failure, so each one burnt its retry budget and was rolled
   * back: the writes the auth gate stopped deleting were destroyed a slower
   * way. Untagged mutations still flush for anyone, which is what an
   * `auth: false` deployment needs.
   */
  setUserId(userId: string | undefined): void {
    this.currentUserId = userId
  }

  // ── Registration ─────────────────────────────────────────────────

  registerExecutor(table: string, executor: MutationExecutor): void {
    this.executors.set(table, executor)
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

      // Keyed on the user as well as the row. Two people writing the same row
      // from one device is exactly what `userId` isolates on flush, and
      // coalescing defeated that isolation one line earlier: `UPDATE + UPDATE`
      // merges the newer payload into the OLDER mutation, which keeps the older
      // one's `userId` — so B's edit went out under A's session, or waited
      // forever for an A who never signed back in. `INSERT + DELETE` was worse
      // still, dropping both. An untagged mutation keys separately from a tagged
      // one for the same reason: nothing says they are the same person.
      const rowKey = `${mutation.userId ?? ""}:${mutation.table}:${JSON.stringify(mutation.primaryKey)}`
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
          if (idx > existingIdx) {seen.set(key, idx - 1)}
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
        if (hops > absorbedBy.size) { target = undefined;

 break }

        target = absorbedBy.get(target)
      }

      mutation.dependsOn = target === mutation.id ? undefined : target
    }

    this.queue = compacted
  }

/** Calculate exponential backoff delay with jitter */
private getRetryDelay(attempt: number): number {
    const exponential = this.retryBaseDelay * 2**attempt
    const jitter = Math.random() * this.retryBaseDelay

    return exponential + jitter
  }

// ── Auto-flush ───────────────────────────────────────────────────
scheduleFlush(retryAttempt?: number): void {
    if (this.flushTimer) {clearTimeout(this.flushTimer)}

    const delay = retryAttempt == null
      ? this.flushDebounceMs
      : this.getRetryDelay(retryAttempt)

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush().catch((error: unknown) => {
        this.logger.mutationError("__queue", "FLUSH" as any, error instanceof Error ? error.message : String(error))
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
    if (!this.network) {return}

    this.unsubNetwork = this.network.subscribe((online) => {
      if (online && this.isDirty) {
        this.scheduleFlush()
      }
    })
  }

// ── Hydration ────────────────────────────────────────────────────

  async hydrate(): Promise<void> {
    if (!this.adapter) {return}

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

  









stopAutoFlush(): void {
    this.unsubNetwork?.()
    this.unsubNetwork = null
    this.cancelFlush()
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

  

  

  











// ── Flush ────────────────────────────────────────────────────────

  async flush(): Promise<FlushResult> {
    if (this.flushing) {
      // Not a no-op: whatever asked for this flush wanted work done that the
      // running one cannot do, because it filtered `pending` before its first
      // `await`. Dropping the request strands that work until some other
      // trigger happens along — and since 2.2.1 there are only two, a
      // connectivity transition and an auth event, neither of which a device
      // sitting on wifi with a signed-in user will produce. Re-armed in
      // `finally`.
      this.flushRequestedWhileRunning = true

      return { complete: false, failed: [], rolledBack: [], succeeded: [] }
    }

    if (this.network && !this.network.isOnline()) {
      return { complete: false, failed: [], rolledBack: [], succeeded: [] }
    }

    this.flushing = true

    try {
      this.compact()

      const pending = this.queue.filter(
        (m) =>
          (m.status === "pending" || m.status === "failed") &&

          // Skip mutations belonging to a different user — and to no current
          // user at all, which is a signed-out session, not a wildcard. See
          // `setUserId`.
          (!m.userId || m.userId === this.currentUserId),
      )

      if (pending.length === 0) {
        return { complete: true, failed: [], rolledBack: [], succeeded: [] }
      }

      this.logger.queueFlushStart(pending.length)

      const result: FlushResult = {
        complete: false,
        failed: [],
        rolledBack: [],
        succeeded: [],
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
          // Mutations must run in order so dependsOn + temp-id remaps stay correct.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
            if (other.dependsOn === mutation.id) {other.dependsOn = undefined}
          }
        } catch (error) {
          mutation.retryCount++

          const errorMessage =
            error instanceof Error ? error.message : String(error)

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
      const pruneStatuses = new Set(["rolled_back", "succeeded"])

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
        let maxAttempt = 0

        for (const m of this.queue) {
          if (m.status === "failed" && m.retryCount > maxAttempt) {
            maxAttempt = m.retryCount
          }
        }

        this.scheduleFlush(maxAttempt)
      }

      return result
    } finally {
      this.flushing = false

      if (this.flushRequestedWhileRunning) {
        this.flushRequestedWhileRunning = false


        // `!this.flushTimer` keeps the retry backoff scheduled above: a plain
        // `scheduleFlush()` here would clear that timer and replace an
        // exponential delay with the debounce, which is how a queue full of
        // failing writes turns into a tight retry loop.
        if (this.isDirty && !this.flushTimer) {this.scheduleFlush()}
      }
    }
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

  destroy(): void {
    this.stopAutoFlush()
    this.queue = []
  }

// ── Persistence ──────────────────────────────────────────────────

  private async persist(): Promise<void> {
    if (!this.adapter) {return}

    try {
      await this.adapter.setItem(QUEUE_KEY, this.queue)
    } catch (error) {
      this.logger.mutationError(
        "__queue",
        "PERSIST" as any,
        `Failed to persist queue: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async persistTempIdMap(): Promise<void> {
    if (!this.adapter || this.persistedTempIdMap.size === 0) {return}

    try {
      await this.adapter.setItem(TEMP_ID_MAP_KEY, Array.from(this.persistedTempIdMap.entries()))
    } catch (error) {
      this.logger.mutationError(
        "__queue",
        "PERSIST" as any,
        `Failed to persist temp ID map: ${error instanceof Error ? error.message : String(error)}`,
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

  
}
