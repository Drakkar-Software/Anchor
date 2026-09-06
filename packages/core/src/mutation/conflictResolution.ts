import type {
  ConflictConfig,
  ConflictContext,
  ConflictResolver,
  TrackedRow,
} from "../types.js"
import type { ConflictAuditLog } from "./conflictAudit.js"

/**
 * Field-level merge: per-field, newer value wins.
 * NOTE: Uses shallow assignment — nested objects and arrays are not deep-merged.
 * For complex nested data, use a custom resolver.
 */
export function fieldLevelMerge<Row extends Record<string, unknown>>(options?: {
  clientOwnedFields?: string[]
  serverOwnedFields?: string[]
  timestampColumn?: string
}): ConflictResolver<Row> {
  const {
    clientOwnedFields = [],
    serverOwnedFields = [],
    timestampColumn = "updated_at",
  } = options ?? {}
  const serverOwned = new Set(serverOwnedFields)
  const clientOwned = new Set(clientOwnedFields)

  return (local, remote, _context) => {
    const merged = { ...remote } as Record<string, unknown>

    const localTs = (local as Record<string, unknown>)[timestampColumn]
    const remoteTs = (remote as Record<string, unknown>)[timestampColumn]
    const localNewer =
      localTs && remoteTs
        ? new Date(localTs as string).getTime() >
          new Date(remoteTs as string).getTime()
        : false

    for (const key of Object.keys(local as Record<string, unknown>)) {
      // Skip metadata
      if (key.startsWith("_anchor_")) {continue}

      // Server-owned: always use remote
      if (serverOwned.has(key)) {continue}

      // Client-owned: always use local
      if (clientOwned.has(key)) {
        merged[key] = (local as Record<string, unknown>)[key]

        continue
      }

      // For other fields: use whichever is newer
      if (localNewer) {
        merged[key] = (local as Record<string, unknown>)[key]
      }
    }

    return merged as Row
  }
}

/**
 * Last-write-wins based on a timestamp column.
 * When timestamps are equal (ties), the remote (server) value wins
 * since the server is the authoritative source of truth.
 */
export function lastWriteWins<Row extends Record<string, unknown>>(
  timestampColumn = "updated_at",
): ConflictResolver<Row> {
  return (local, remote, _context) => {
    const localTs = (local as Record<string, unknown>)[timestampColumn]
    const remoteTs = (remote as Record<string, unknown>)[timestampColumn]

    if (!localTs || !remoteTs) {return remote}

    const localTime =
      typeof localTs === "string"
        ? new Date(localTs).getTime()
        : (localTs as number)
    const remoteTime =
      typeof remoteTs === "string"
        ? new Date(remoteTs).getTime()
        : (remoteTs as number)

    if (localTime > remoteTime) {
      const { _anchor_mutationId, _anchor_optimistic, _anchor_pending, ...clean } =
        local as TrackedRow<Row> & Record<string, unknown>

      return clean as Row
    }

    return remote
  }
}

/**
 * Local always wins. Offline edits are preserved.
 */
export function localWins<
  Row extends Record<string, unknown>,
>(): ConflictResolver<Row> {
  return (local, _remote, _context) => {
    // Strip tracking metadata
    const { _anchor_mutationId, _anchor_optimistic, _anchor_pending, ...clean } =
      local as TrackedRow<Row> & Record<string, unknown>

    return clean as Row
  }
}

/**
 * Remote always wins. Simplest strategy.
 */
export function remoteWins<
  Row extends Record<string, unknown>,
>(): ConflictResolver<Row> {
  return (_local, remote, _context) => remote
}

/**
 * Resolve a conflict using the configured strategy.
 */
export function resolveConflict<Row extends Record<string, unknown>>(
  local: TrackedRow<Row> | undefined,
  remote: Row,
  config: ConflictConfig<Row>,
  context: ConflictContext,
  auditLog?: ConflictAuditLog,
): Row | null {
  if (!local) {return remote}

  let result: Row | null

  // Custom resolver takes precedence
  if (config.resolver) {
    result = config.resolver(local, remote, context)
  } else {
    switch (config.strategy ?? "server-wins") {
      case "client-wins": {
        result = localWins<Row>()(local, remote, context)

        break
      }
      case "custom": {
        // Requires resolver to be set
        result = remote

        break
      }
      case "field-merge": {
        result = fieldLevelMerge<Row>({
          clientOwnedFields: config.clientOwnedFields,
          serverOwnedFields: config.serverOwnedFields,
          timestampColumn: config.timestampColumn,
        })(local, remote, context)

        break
      }
      case "last-write-wins": {
        result = lastWriteWins<Row>(config.timestampColumn)(
          local,
          remote,
          context,
        )

        break
      }
      case "server-wins": {
        result = remoteWins<Row>()(local, remote, context)

        break
      }

      default: {
        result = remote

        break
      }
    }
  }

  if (auditLog && local) {
    const pk = context.primaryKey
    const rowId = Object.values(pk)[0] as string | number

    auditLog.record({
      localValue: local as Record<string, unknown>,
      remoteValue: remote as Record<string, unknown>,
      resolvedValue: result as Record<string, unknown> | null,
      rowId,
      strategy: config.strategy ?? "server-wins",
      table: context.table,
    })
  }

  return result
}
