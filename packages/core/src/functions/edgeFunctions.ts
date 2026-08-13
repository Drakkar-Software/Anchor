import type { SupabaseClient } from "@supabase/supabase-js"
import { withRetry, type RetryOptions } from "../utils/retry.js"
import { AnchorError } from "../errors.js"

export type EdgeFunctionResult<T> = {
  data: T | null
  error: Error | null
}

export type InvokeOptions = {
  headers?: Record<string, string>
  body?: unknown
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Retry configuration for transient failures */
  retry?: RetryOptions
}

/**
 * Invoke a Supabase Edge Function.
 */
export async function invokeEdgeFunction<T = unknown>(
  supabase: SupabaseClient,
  functionName: string,
  options?: InvokeOptions,
): Promise<EdgeFunctionResult<T>> {
  const execute = async (): Promise<EdgeFunctionResult<T>> => {
    const { data, error } = await supabase.functions.invoke(functionName, {
      body: options?.body as Record<string, unknown> | undefined,
      headers: options?.headers,
      method: options?.method,
    })

    if (error) {
      throw await toAnchorError(error)
    }
    return { data: data as T, error: null }
  }

  try {
    if (options?.retry) {
      return await withRetry(execute, options.retry)
    }
    return await execute()
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}

/**
 * Keep what functions-js put on the error instead of collapsing it to a string.
 *
 * `new Error(error.message)` threw away two things that are the whole diagnosis.
 * The **class** distinguishes a function that ran and returned non-2xx
 * (`FunctionsHttpError`) from one that was never reached (`FunctionsFetchError`,
 * a dead network) and from a relay that could not route to it
 * (`FunctionsRelayError`) — the same distinction the mutation path already makes
 * with `isTransportError`, and the one that decides whether retrying is
 * sensible. And `FunctionsHttpError.context` is the `Response`, carrying the
 * real HTTP status and the body the function itself wrote — which is where the
 * actual message lives, since `error.message` is only ever the generic
 * "Edge Function returned a non-2xx status code".
 */
async function toAnchorError(error: {
  name?: string
  message: string
  context?: unknown
}): Promise<AnchorError> {
  const context = error.context
  const isResponse =
    typeof context === "object" &&
    context !== null &&
    typeof (context as Response).status === "number" &&
    typeof (context as Response).clone === "function"

  let details: string | undefined
  let status: number | undefined

  if (isResponse) {
    const response = context as Response
    status = response.status
    try {
      // `clone()` so a caller reaching for the raw response still finds its body
      // unread.
      details = await response.clone().text()
    } catch {
      // A body that cannot be read is not worth failing the error path over —
      // the status and the class survive either way.
      details = undefined
    }
  }

  return new AnchorError(error.message, {
    code: error.name ?? "FunctionsError",
    details,
    status,
  })
}

/**
 * Creates a reusable typed Edge Function action.
 *
 * @example
 * ```typescript
 * const sendEmail = createEdgeFunctionAction<{ success: boolean }>(supabase, 'send-email')
 * const result = await sendEmail({ body: { to: 'user@example.com', subject: 'Hello' } })
 * ```
 */
export function createEdgeFunctionAction<T = unknown>(
  supabase: SupabaseClient,
  functionName: string,
) {
  return (options?: InvokeOptions): Promise<EdgeFunctionResult<T>> =>
    invokeEdgeFunction<T>(supabase, functionName, options)
}
