import type { SupabaseClient } from "@supabase/supabase-js"

import { fromSupabaseError } from "../errors.js"
import type { FunctionNames, RpcArgs, RpcReturns } from "../types.js"
import { type RetryOptions,withRetry } from "../utils/retry.js"

export type RpcCacheOptions = {
  /** Cache TTL in milliseconds */
  ttlMs: number
}

export type RpcCallOptions = {
  /** Cache configuration — results are cached by function name + serialized args */
  cache?: RpcCacheOptions

  /** Retry configuration for transient failures */
  retry?: RetryOptions
}

export type RpcResult<T> = {
  data: T | null
  error: Error | null
}

type CacheEntry = {
  data: unknown
  timestamp: number
}

// Module-level cache shared across all callRpc invocations
const rpcCache = new Map<string, CacheEntry>()
const inflightRequests = new Map<string, Promise<RpcResult<unknown>>>()

/**
 * The trailing parameters of a schema-typed RPC call.
 *
 * `args?` for every function would defeat the point: a function with required
 * arguments would compile with none and fail at runtime with `PGRST202`, which
 * reads like a missing grant. So the argument object is **required** unless the
 * schema says it can be left out. Two shapes count as "can": `never`, which is
 * what the generator emits for a zero-argument function, and an object all of
 * whose properties are optional.
 */
type RpcCallParams<Args> = [Args] extends [never]
  ? [args?: undefined, options?: RpcCallOptions]
  : Record<string, never> extends Args
    ? [args?: Args, options?: RpcCallOptions]
    : [args: Args, options?: RpcCallOptions]

/**
 * Call a Postgres function via Supabase RPC.
 */
export async function callRpc<
  T = unknown,
  Args extends Record<string, unknown> = Record<string, unknown>,
>(
  supabase: SupabaseClient,
  functionName: string,
  args?: Args,
  options?: RpcCallOptions,
): Promise<RpcResult<T>> {
  const cacheKey = buildCacheKey(functionName, args)

  // Check cache
  if (options?.cache) {
    const cached = rpcCache.get(cacheKey)

    if (cached && Date.now() - cached.timestamp < options.cache.ttlMs) {
      return { data: cached.data as T, error: null }
    }

    // Deduplicate in-flight requests
    const inflight = inflightRequests.get(cacheKey)

    if (inflight) {
      return await (inflight as Promise<RpcResult<T>>)
    }
  }

  const execute = async (): Promise<RpcResult<T>> => {
    const { data, error } = await supabase.rpc(functionName, args as any)

    if (error) {return { data: null, error: fromSupabaseError(error) }}

    return { data: data as T, error: null }
  }

  const request = (async (): Promise<RpcResult<T>> => {
    try {
      const result = options?.retry
        ? await withRetry(execute, options.retry)
        : await execute()

      // Populate cache on success
      if (options?.cache && result.error === null) {
        rpcCache.set(cacheKey, { data: result.data, timestamp: Date.now() })
      }

      return result
    } finally {
      inflightRequests.delete(cacheKey)
    }
  })()

  if (options?.cache) {
    inflightRequests.set(cacheKey, request as Promise<RpcResult<unknown>>)
  }

  return await request
}

/**
 * Creates a reusable typed RPC action.
 *
 * @example
 * ```typescript
 * const getStats = createRpcAction<Stats>(supabase, 'get_dashboard_stats')
 * const result = await getStats({ user_id: '123' })
 * ```
 */
export function createRpcAction<
  T = unknown,
  Args extends Record<string, unknown> = Record<string, unknown>,
>(supabase: SupabaseClient, functionName: string, defaultOptions?: RpcCallOptions) {
  return async (args?: Args, options?: RpcCallOptions): Promise<RpcResult<T>> =>
    await callRpc<T, Args>(supabase, functionName, args, { ...defaultOptions, ...options })
}

/**
 * `callRpc` with the function name, arguments and return type read from the
 * generated `Database` instead of supplied by hand.
 *
 * ```typescript
 * const rpc = createSchemaRpc<Database>(supabase)
 * const { data } = await rpc("record_consent", { p_kind: "care", p_granted: true })
 * ```
 *
 * Pass the schema as the second type argument for a `Database` with no `public`
 * key — `createSchemaRpc<Database, "app">(supabase)` — or every function name
 * resolves to `never` and no call compiles.
 *
 * A separate entry point rather than new generics on `callRpc`: the existing
 * signature takes the return type as its first type argument, so making it
 * generic over `DB` would bind `Database` where every existing
 * `callRpc<Stats>(...)` call site means `Stats`.
 */
export function createSchemaRpc<
  DB,
  SchemaName extends string & keyof DB = "public" & keyof DB,
>(supabase: SupabaseClient<DB>) {
  return async <FunctionName extends FunctionNames<DB, SchemaName>>(
    functionName: FunctionName,
    ...rest: RpcCallParams<RpcArgs<DB, FunctionName, SchemaName>>
  ): Promise<RpcResult<RpcReturns<DB, FunctionName, SchemaName>>> => {
    const [args, options] = rest

    return await callRpc<RpcReturns<DB, FunctionName, SchemaName>>(
      supabase as SupabaseClient,
      functionName,
      args as Record<string, unknown> | undefined,
      options,
    )
  }
}

/**
 * Clear the RPC result cache, optionally for a specific function name.
 */
export function invalidateRpcCache(functionName?: string): void {
  if (functionName) {
    for (const key of rpcCache.keys()) {
      if (key.startsWith(`${functionName}:`)) {
        rpcCache.delete(key)
      }
    }

    for (const key of inflightRequests.keys()) {
      if (key.startsWith(`${functionName}:`)) {
        inflightRequests.delete(key)
      }
    }
  } else {
    rpcCache.clear()
    inflightRequests.clear()
  }
}

function buildCacheKey(functionName: string, args?: Record<string, unknown>): string {
  return `${functionName}:${args ? JSON.stringify(args) : ""}`
}
