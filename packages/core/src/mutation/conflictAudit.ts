import type { ConflictStrategy } from "../types.js"

export type ConflictAuditEntry = {
  localValue: Record<string, unknown>
  remoteValue: Record<string, unknown>
  resolvedValue: Record<string, unknown> | null
  rowId: string | number
  strategy: ConflictStrategy
  table: string
  timestamp: number

  /** User who triggered the local mutation that caused the conflict */
  userId?: string
}

export class ConflictAuditLog {
  private entries: ConflictAuditEntry[] = []

  private readonly listeners = new Set<(entry: ConflictAuditEntry) => void>()

  record(entry: Omit<ConflictAuditEntry, "timestamp">): void {
    const full: ConflictAuditEntry = { ...entry, timestamp: Date.now() }

    this.entries.push(full)

    for (const cb of this.listeners) {cb(full)}
  }

  getLog(options?: { since?: number; table?: string; userId?: string }): ConflictAuditEntry[] {
    let result = this.entries

    if (options?.table) {result = result.filter((e) => e.table === options.table)}

    if (options?.since)
      {result = result.filter((e) => e.timestamp >= options.since!)}

    if (options?.userId)
      {result = result.filter((e) => e.userId === options.userId)}

    return Array.from(result)
  }

  clearLog(): void {
    this.entries = []
  }

  onConflict(cb: (entry: ConflictAuditEntry) => void): () => void {
    this.listeners.add(cb)

    return () => {
      this.listeners.delete(cb)
    }
  }
}
