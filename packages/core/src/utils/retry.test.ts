import { describe, expect, it, vi } from "vitest"

import { withRetry } from "./retry.js"

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok")
    const result = await withRetry(fn)

    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries on failure and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok")

    const result = await withRetry(fn, { baseDelay: 1, jitter: false, maxAttempts: 3 })

    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it("throws after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"))

    await expect(withRetry(fn, { baseDelay: 1, jitter: false, maxAttempts: 2 }))
      .rejects.toThrow("always fails")
    expect(fn).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it("skips retry when isRetryable returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("not retryable"))

    await expect(
      withRetry(fn, {
        baseDelay: 1,
        isRetryable: () => false,
        maxAttempts: 3,
      }),
    ).rejects.toThrow("not retryable")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("works with zero retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"))

    await expect(withRetry(fn, { maxAttempts: 0 })).rejects.toThrow("fail")
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
