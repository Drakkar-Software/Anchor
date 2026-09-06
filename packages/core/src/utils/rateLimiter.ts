export type RateLimiterOptions = {
  /** Maximum number of requests allowed in the window */
  maxRequests: number

  /** Time window in milliseconds */
  windowMs: number
}

/**
 * Token bucket rate limiter.
 * Queues excess requests and drains them as capacity becomes available.
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter({ maxRequests: 10, windowMs: 1000 })
 *
 * // Will be rate-limited if over 10 calls per second:
 * const result = await limiter.execute(() => fetch('/api/data'))
 * ```
 */
export class RateLimiter {
  private timestamps: number[] = []

  private queue: {
    fn: () => Promise<unknown>
    reject: (reason?: unknown) => void
    resolve: (value: unknown) => void
  }[] = []

  private drainTimer: ReturnType<typeof setTimeout> | null = null

  private readonly maxRequests: number

  private readonly windowMs: number

  constructor(options: RateLimiterOptions) {
    this.maxRequests = options.maxRequests
    this.windowMs = options.windowMs
  }

  private tryExecute(
    fn: () => Promise<unknown>,
    resolve: (value: unknown) => void,
    reject: (reason?: unknown) => void,
  ): void {
    const now = Date.now()


    // Remove expired timestamps
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs)

    if (this.timestamps.length < this.maxRequests) {
      this.timestamps.push(now)
      void fn().catch(reject).then(resolve)
    } else {
      this.queue.push({ fn, reject, resolve })
      this.scheduleDrain()
    }
  }


private scheduleDrain(): void {
    if (this.drainTimer) {return}

    if (this.queue.length === 0) {return}

    // Calculate when the oldest timestamp expires
    const oldest = this.timestamps[0]

    if (oldest == null) {return}

    const delay = Math.max(1, this.windowMs - (Date.now() - oldest))

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      this.drain()
    }, delay)
  }


private drain(): void {
    while (this.queue.length > 0) {
      const now = Date.now()

      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs)

      if (this.timestamps.length >= this.maxRequests) {
        this.scheduleDrain()

        return
      }

      const item = this.queue.shift()!

      this.timestamps.push(now)
      void item.fn().catch(item.reject).then(item.resolve)
    }
  }


/** Number of requests currently queued waiting for capacity. */
get pendingCount(): number {
    return this.queue.length
  }


/** Clear the queue (rejects pending requests). */
destroy(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }

    for (const item of this.queue) {
      item.reject(new Error("RateLimiter destroyed"))
    }

    this.queue = []
    this.timestamps = []
  }


/**
   * Execute a function through the rate limiter.
   * If the rate limit is exceeded, the call is queued and executed when a slot opens.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      this.tryExecute(fn, resolve as (v: unknown) => void, reject)
    })
  }

  

  

  

  
  

  
  
}
