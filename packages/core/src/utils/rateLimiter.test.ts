import { describe, expect, it, vi } from "vitest"

import { RateLimiter } from "./rateLimiter.js"

describe("RateLimiter", () => {
  it("executes immediately when under limit", async () => {
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 })
    const fn = vi.fn().mockResolvedValue("ok")

    const result = await limiter.execute(fn)

    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
    limiter.destroy()
  })

  it("queues requests that exceed the limit", async () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 100 })
    const results: number[] = []

    const p1 = limiter.execute(async () => { results.push(1);

 return 1; })
    const p2 = limiter.execute(async () => { results.push(2);

 return 2; })
    const p3 = limiter.execute(async () => { results.push(3);

 return 3; })

    // First 2 should execute immediately
    await Promise.all([p1, p2])
    expect(results).toEqual([1, 2])

    // Third should be queued and execute after window
    await p3
    expect(results).toEqual([1, 2, 3])
    limiter.destroy()
  })

  it("reports pending count", async () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 100 })

    limiter.execute(async () => await Promise.resolve(1))
    limiter.execute(async () => await Promise.resolve(2))

    expect(limiter.pendingCount).toBe(1)

    // Wait for drain
    await new Promise((r) => setTimeout(r, 150))
    expect(limiter.pendingCount).toBe(0)
    limiter.destroy()
  })

  it("destroy rejects pending requests", async () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 5000 })

    limiter.execute(async () => await Promise.resolve(1))

    const p2 = limiter.execute(async () => await Promise.resolve(2))

    limiter.destroy()

    await expect(p2).rejects.toThrow("RateLimiter destroyed")
  })

  it("propagates errors from the function", async () => {
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 })

    await expect(
      limiter.execute(async () => await Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom")
    limiter.destroy()
  })
})
