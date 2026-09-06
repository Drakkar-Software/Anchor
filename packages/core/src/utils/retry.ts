export type RetryOptions = {
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelay?: number

  /** Predicate to decide if the error is retryable (default: all errors) */
  isRetryable?: (error: unknown) => boolean

  /** Whether to add random jitter to backoff (default: true) */
  jitter?: boolean

  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number
}

/**
 * Wrap an async function with exponential backoff retry logic.
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => callRpc(supabase, 'my_function'),
 *   { maxAttempts: 3, baseDelay: 500 },
 * )
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const {
    baseDelay = 1000,
    isRetryable = () => true,
    jitter = true,
    maxAttempts = 3,
  } = options ?? {}

  let lastError: unknown

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error
      }

      const exponential = baseDelay * 2**attempt
      const delay = jitter
        ? exponential + Math.random() * baseDelay
        : exponential

      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError
}
