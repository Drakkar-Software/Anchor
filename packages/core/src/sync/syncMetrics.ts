import type { MutationOperation,SyncLogger } from "../types.js"

export type MetricsSnapshot = {
  conflictCount: number
  fetchCount: number
  fetchErrorCount: number
  fetchLatencyP50: number
  fetchLatencyP95: number
  fetchLatencyP99: number
  mutationCount: number
  mutationErrorCount: number
  mutationLatencyP50: number
  mutationLatencyP95: number
  mutationLatencyP99: number
  queueFlushCount: number
  realtimeErrorCount: number
  realtimeEventCount: number
}

export class SyncMetrics implements SyncLogger {
  fetchStart(_table: string): void {
    // No state change — skip notification
  }

fetchSuccess(_table: string, _count: number, durationMs: number): void {
    this._fetchCount++
    this._fetchLatencies.push(durationMs)
    this._sortedFetchDirty = true
    this._notify()
  }

fetchError(_table: string, _error: string): void {
    this._fetchErrorCount++
    this._notify()
  }

mutationStart(_table: string, _operation: MutationOperation): void {
    // No state change — skip notification
  }

mutationSuccess(_table: string, _operation: MutationOperation, durationMs: number): void {
    this._mutationCount++
    this._mutationLatencies.push(durationMs)
    this._sortedMutationDirty = true
    this._notify()
  }

mutationError(_table: string, _operation: MutationOperation, _error: string): void {
    this._mutationErrorCount++
    this._notify()
  }

queueFlushStart(_count: number): void {
    // No state change — skip notification
  }

queueFlushSuccess(_succeeded: number, _failed: number): void {
    this._queueFlushCount++
    this._notify()
  }

conflict(_table: string, _id: string | number): void {
    this._conflictCount++
    this._notify()
  }
private _fetchCount = 0
  private _fetchErrorCount = 0
  private _fetchLatencies: number[] = []
  private _mutationCount = 0
  private _mutationErrorCount = 0
  private _mutationLatencies: number[] = []
  private _queueFlushCount = 0
  private _conflictCount = 0
  private _realtimeEventCount = 0
  private _realtimeErrorCount = 0
  private readonly _subscribers = new Set<(snapshot: MetricsSnapshot) => void>()
  // Cached sorted arrays — invalidated on new entries
  private _sortedFetchDirty = true
  private _sortedFetch: number[] = []
  private _sortedMutationDirty = true
  private _sortedMutation: number[] = []

  private _notify(): void {
    if (this._subscribers.size === 0) {return}

    const snapshot = this.getMetrics()

    for (const cb of this._subscribers) {
      cb(snapshot)
    }
  }

  

  

  

  

  

  

  

  

  

  realtimeEvent(_table: string, _event: string): void {
    this._realtimeEventCount++
    this._notify()
  }

  /**
   * A channel that errored, timed out or closed.
   *
   * Counted separately from `realtimeEvent`: a connection dropping is not a row
   * changing, and folding the two together would make a flapping subscription
   * look like healthy traffic on the dashboard.
   */
  realtimeError(_table: string, _status: string, _error?: Error): void {
    this._realtimeErrorCount++
    this._notify()
  }

  getMetrics(): MetricsSnapshot {
    if (this._sortedFetchDirty) {
      this._sortedFetch = Array.from(this._fetchLatencies).sort((a, b) => a - b)
      this._sortedFetchDirty = false
    }

    if (this._sortedMutationDirty) {
      this._sortedMutation = Array.from(this._mutationLatencies).sort((a, b) => a - b)
      this._sortedMutationDirty = false
    }

    return {
      conflictCount: this._conflictCount,
      fetchCount: this._fetchCount,
      fetchErrorCount: this._fetchErrorCount,
      fetchLatencyP50: percentile(this._sortedFetch, 50),
      fetchLatencyP95: percentile(this._sortedFetch, 95),
      fetchLatencyP99: percentile(this._sortedFetch, 99),
      mutationCount: this._mutationCount,
      mutationErrorCount: this._mutationErrorCount,
      mutationLatencyP50: percentile(this._sortedMutation, 50),
      mutationLatencyP95: percentile(this._sortedMutation, 95),
      mutationLatencyP99: percentile(this._sortedMutation, 99),
      queueFlushCount: this._queueFlushCount,
      realtimeErrorCount: this._realtimeErrorCount,
      realtimeEventCount: this._realtimeEventCount,
    }
  }

  resetMetrics(): void {
    this._fetchCount = 0
    this._fetchErrorCount = 0
    this._fetchLatencies = []
    this._mutationCount = 0
    this._mutationErrorCount = 0
    this._mutationLatencies = []
    this._queueFlushCount = 0
    this._conflictCount = 0
    this._realtimeEventCount = 0
    this._realtimeErrorCount = 0
    this._sortedFetch = []
    this._sortedMutation = []
    this._sortedFetchDirty = true
    this._sortedMutationDirty = true
  }

  onMetricsUpdate(cb: (snapshot: MetricsSnapshot) => void): () => void {
    this._subscribers.add(cb)

    return () => {
      this._subscribers.delete(cb)
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {return 0}

  const idx = Math.ceil((p / 100) * sorted.length) - 1

  return sorted[Math.max(0, idx)]!
}
