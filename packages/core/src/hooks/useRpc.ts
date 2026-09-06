"use client"

import type { SupabaseClient } from "@supabase/supabase-js"
import { useCallback, useEffect, useRef,useState } from "react"

import { callRpc } from "../rpc/rpcAction.js"

type UseRpcOptions = {
  deps?: unknown[]
  enabled?: boolean
}

type UseRpcResult<T> = {
  data: T | null
  error: Error | null
  isLoading: boolean
  refetch: () => Promise<void>
}

/**
 * React hook for calling Supabase RPC functions.
 *
 * @example
 * ```typescript
 * const { data, isLoading } = useRpc<Stats>(supabase, 'get_stats', { user_id: '123' })
 * ```
 */
export function useRpc<
  T = unknown,
  Args extends Record<string, unknown> = Record<string, unknown>,
>(
  supabase: SupabaseClient,
  functionName: string,
  args?: Args,
  options?: UseRpcOptions,
): UseRpcResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const enabled = options?.enabled ?? true
  const deps = options?.deps ?? []
  const argsRef = useRef(args)

  useEffect(() => {
    argsRef.current = args
  }, [args])

  const fetch = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await callRpc<T, Args>(
        supabase,
        functionName,
        argsRef.current,
      )

      setData(result.data)
      setError(result.error)
    } catch (error_) {
      setError(error_ instanceof Error ? error_ : new Error(String(error_)))
    } finally {
      setIsLoading(false)
    }
  }, [supabase, functionName])

  useEffect(() => {
    if (!enabled) {return}

    void fetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fetch, ...deps])

  return { data, error, isLoading, refetch: fetch }
}
