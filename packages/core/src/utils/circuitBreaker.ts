export type CircuitBreakerOptions = {
  /** Time in ms before allowing a probe request when open (default: 30000) */
  cooldownMs?: number

  /** Number of consecutive failures to trip the circuit (default: 5) */
  failureThreshold?: number

  /** Callback when state changes */
  onStateChange?: (state: CircuitBreakerState) => void
}

export type CircuitBreakerState = "closed" | "open" | "half-open"

/**
 * Circuit breaker that prevents hammering failing endpoints.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Requests are rejected immediately
 * - HALF-OPEN: After cooldown, allows one probe request to test recovery
 *
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 10000 })
 *
 * try {
 *   const result = await breaker.execute(() => fetch('/api/data'))
 * } catch (err) {
 *   // Could be CircuitOpenError or the original error
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = "closed"

  private failureCount = 0

  private lastFailureTime = 0

  private readonly failureThreshold: number

  private readonly cooldownMs: number

  private readonly onStateChange?: (state: CircuitBreakerState) => void

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5
    this.cooldownMs = options.cooldownMs ?? 30_000
    this.onStateChange = options.onStateChange
  }

  private onSuccess(): void {
    this.failureCount = 0

    if (this.state !== "closed") {
      this.transition("closed")
    }
  }


private onFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.state === "half-open" || this.failureCount >= this.failureThreshold) {
      this.transition("open")
    }
  }


private transition(newState: CircuitBreakerState): void {
    if (this.state !== newState) {
      this.state = newState
      this.onStateChange?.(newState)
    }
  }


/** Reset the circuit breaker to closed state. */
reset(): void {
    this.failureCount = 0
    this.lastFailureTime = 0
    this.transition("closed")
  }


/** Get current circuit state. */
getState(): CircuitBreakerState {
    return this.state
  }


/**
   * Execute a function through the circuit breaker.
   * Throws CircuitOpenError if the circuit is open and cooldown hasn't elapsed.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.cooldownMs) {
        this.transition("half-open")
      } else {
        throw new CircuitOpenError(
          `Circuit breaker is open. Retry after ${this.cooldownMs}ms cooldown.`,
        )
      }
    }

    try {
      const result = await fn()

      this.onSuccess()

      return result
    } catch (error) {
      this.onFailure()

      throw error
    }
  }

  

  

  

  
  

  
  
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CircuitOpenError"
  }
}
