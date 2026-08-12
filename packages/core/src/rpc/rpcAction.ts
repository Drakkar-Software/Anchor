import type { SupabaseClient } from "@supabase/supabase-js"
import { withRetry, type RetryOptions } from "../utils/retry.js"
import { fromSupabaseError } from "../errors.js"

export type RpcResult<T> = {
  data: T | null
  error: Error | null
}

export type RpcCacheOptions = {
  /** Cache TTL in milliseconds */
  ttlMs: number
}

export type RpcCallOptions = {
  /** Retry configuration for transient failures */
  retry?: RetryOptions
  /** Cache configuration — results are cached by function name + serialized args */
  cache?: RpcCacheOptions
}

type CacheEntry = {
  data: unknown
  timestamp: number
}

// Module-level cache shared across all callRpc invocations
const rpcCache = new Map<string, CacheEntry>()
const inflightRequests = new Map<string, Promise<RpcResult<unknown>>>()

function buildCacheKey(functionName: string, args?: Record<string, unknown>): string {
  return `${functionName}:${args ? JSON.stringify(args) : ""}`
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
      return inflight as Promise<RpcResult<T>>
    }
  }

  const execute = async (): Promise<RpcResult<T>> => {
    const { data, error } = await supabase.rpc(functionName, args as any)
    if (error) return { data: null, error: fromSupabaseError(error) }
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

  return request
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
  return (args?: Args, options?: RpcCallOptions): Promise<RpcResult<T>> =>
    callRpc<T, Args>(supabase, functionName, args, { ...defaultOptions, ...options })
}
