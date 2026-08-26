import type { SupabaseClient } from "@supabase/supabase-js"
import type { StoreApi } from "zustand"
import type {
  TableStore,
  QueuedMutation,
} from "../types.js"
import { isTempId } from "../types.js"
import { fromTable } from "../query/queryExecutor.js"
import { fromSupabaseError } from "../errors.js"

/**
 * Execute a remote mutation against Supabase.
 * Handles temp ID resolution from the tempIdMap.
 */
export async function executeRemoteMutation(
  supabase: SupabaseClient,
  table: string,
  primaryKey: string,
  mutation: QueuedMutation,
  tempIdMap: Map<string, unknown>,
  select?: string,
  schema?: string,
): Promise<{ data: Record<string, unknown> | null; serverId?: unknown }> {
  // Resolve temp IDs in payload
  const payload = mutation.payload ? { ...mutation.payload } : null
  const pk = { ...mutation.primaryKey }

  // Replace temp IDs with real IDs from the map
  for (const [key, value] of Object.entries(pk)) {
    if (typeof value === "string" && tempIdMap.has(value)) {
      pk[key] = tempIdMap.get(value)
    }
  }

  if (payload) {
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === "string" && tempIdMap.has(value)) {
        payload[key] = tempIdMap.get(value)
      }
    }
  }

  const pkValue = Object.values(pk)[0]

  switch (mutation.operation) {
    case "INSERT": {
      // For inserts, don't send temp IDs to the server
      const insertPayload = { ...payload }
      const pkFieldValue = insertPayload?.[primaryKey]
      if (
        typeof pkFieldValue === "string" &&
        isTempId(pkFieldValue)
      ) {
        delete insertPayload[primaryKey]
      }

      const { data, error } = await fromTable(supabase, table, schema)
        .insert(insertPayload as any)
        .select(select ?? "*")
        .single()

      if (error) throw fromSupabaseError(error)

      const d = data as unknown as Record<string, unknown>
      const serverId = d[primaryKey]
      return { data: d, serverId }
    }

    case "UPDATE": {
      const { data, error } = await fromTable(supabase, table, schema)
        .update(payload as any)
        .eq(primaryKey, pkValue as any)
        .select(select ?? "*")
        .single()

      if (error) throw fromSupabaseError(error)
      return { data: data as unknown as Record<string, unknown> }
    }

    case "UPSERT": {
      // `upsertOptions` rides on the mutation rather than being recomputed
      // here: the conflict target is a property of the call the caller made,
      // and a replay that fell back to the primary-key default would write a
      // different row than the live path did — visible only after a drain.
      //
      // The temp-id strip mirrors INSERT above. An upsert whose payload carries
      // no primary key is exactly the shape that gets one minted, and a
      // `_temp:…` string reaching Postgres as a uuid fails the statement
      // outright instead of writing the row.
      const upsertPayload = { ...payload }
      if (isTempId(upsertPayload[primaryKey])) delete upsertPayload[primaryKey]

      const upsertQuery = fromTable(supabase, table, schema)
        .upsert(upsertPayload as any, mutation.upsertOptions)
        .select(select ?? "*")

      // Mirrors the live `upsert()` path: `ignoreDuplicates`'s `DO NOTHING` on
      // a real conflict returns no row, which is a successful no-op replay,
      // not a `PGRST116` to fail the drain on — a queue stops at its first
      // failure, so treating this as an error would stall every pending
      // mutation behind it, on every table, for a write the server already
      // confirmed.
      const { data, error } = mutation.upsertOptions?.ignoreDuplicates
        ? await upsertQuery.maybeSingle()
        : await upsertQuery.single()

      if (error) throw fromSupabaseError(error)
      if (data === null) return { data: null }

      const d = data as unknown as Record<string, unknown>
      const serverId = d[primaryKey]
      return { data: d, serverId }
    }

    case "DELETE": {
      const { error } = await fromTable(supabase, table, schema)
        .delete()
        .eq(primaryKey, pkValue as any)

      if (error) throw fromSupabaseError(error)
      return { data: null }
    }

    default:
      throw new Error(`Unknown operation: ${mutation.operation}`)
  }
}

/**
 * Creates a mutation executor function for a table store.
 * Used by the OfflineQueue to replay mutations.
 */
export function createMutationExecutor(
  supabase: SupabaseClient,
  table: string,
  primaryKey: string,
  store: StoreApi<TableStore<any, any, any>>,
  select?: string,
  schema?: string,
) {
  return async (
    mutation: QueuedMutation,
    tempIdMap: Map<string, unknown>,
  ): Promise<{ serverId?: unknown }> => {
    const { data, serverId } = await executeRemoteMutation(
      supabase,
      table,
      primaryKey,
      mutation,
      tempIdMap,
      select,
      schema,
    )

    // Update store with server response
    if (data && mutation.operation !== "DELETE") {
      const id = (data as Record<string, unknown>)[primaryKey] as
        | string
        | number

      store.setState((prev: any) => {
        const records = new Map(prev.records)
        const order = [...prev.order]

        // Remove temp entry if ID changed
        const oldPk = Object.values(mutation.primaryKey)[0] as
          | string
          | number
        if (oldPk !== id) {
          records.delete(oldPk)
          const idx = order.indexOf(oldPk)
          if (idx >= 0) order[idx] = id
        }

        // Set confirmed server data (no _anchor_ metadata)
        records.set(id, data)
        // `order` and `records` have to stay in step. The branch above only
        // touches `order` when the id changed, so a replayed UPDATE — same id
        // throughout — used to leave a row in `records` that no projection can
        // reach, since `selectAllRows`/`selectQueryRows` walk `order` alone.
        if (!order.includes(id)) order.push(id)
        return { ...prev, records, order }
      })
    } else if (
      data === null &&
      mutation.operation === "UPSERT" &&
      mutation.upsertOptions?.ignoreDuplicates
    ) {
      // The only way an UPSERT reaches here with `data === null` and no thrown
      // error is `ignoreDuplicates`'s `DO NOTHING` confirming a row that
      // already exists. There is no server row to adopt, but the row this
      // mutation was about is still marked pending under the id it was
      // enqueued with, and nothing else on this path will ever clear that.
      const pendingId = Object.values(mutation.primaryKey)[0] as string | number
      store.setState((prev: any) => {
        const records = new Map<string | number, Record<string, unknown>>(prev.records)
        const current = records.get(pendingId)
        if (!current?._anchor_pending) return prev
        const {
          _anchor_pending: _pending,
          _anchor_optimistic: _optimistic,
          _anchor_mutationId: _mutationId,
          ...resolved
        } = current
        records.set(pendingId, resolved)
        return { ...prev, records }
      })
    }

    return { serverId }
  }
}
