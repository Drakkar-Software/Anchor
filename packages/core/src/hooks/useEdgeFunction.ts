"use client"

import type { SupabaseClient } from "@supabase/supabase-js"
import { useCallback,useState } from "react"

import {
  type EdgeFunctionResult,
  invokeEdgeFunction,
  type InvokeOptions,
} from "../functions/edgeFunctions.js"

type UseEdgeFunctionResult<T> = {
  data: T | null
  error: Error | null
  invoke: (options?: InvokeOptions) => Promise<EdgeFunctionResult<T>>
  isLoading: boolean
}

/**
 * React hook for invoking Supabase Edge Functions.
 */
export function useEdgeFunction<T = unknown>(
  supabase: SupabaseClient,
  functionName: string,
): UseEdgeFunctionResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const invoke = useCallback(
    async (options?: InvokeOptions): Promise<EdgeFunctionResult<T>> => {
      setIsLoading(true)
      setError(null)

      try {
        const result = await invokeEdgeFunction<T>(supabase, functionName, options)

        setData(result.data)
        setError(result.error)

        return result
      } catch (error_) {
        const error = error_ instanceof Error ? error_ : new Error(String(error_))

        setError(error)

        return { data: null, error }
      } finally {
        setIsLoading(false)
      }
    },
    [supabase, functionName],
  )

  return { data, error, invoke, isLoading }
}
