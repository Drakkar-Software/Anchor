import { describe, expect, it, vi } from "vitest"

import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js"

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const breaker = new CircuitBreaker()

    expect(breaker.getState()).toBe("closed")
  })

  it("passes through successful calls", async () => {
    const breaker = new CircuitBreaker()
    const result = await breaker.execute(async () => await Promise.resolve(42))

    expect(result).toBe(42)
    expect(breaker.getState()).toBe("closed")
  })

  it("opens after reaching failure threshold", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 })

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => await Promise.reject(new Error("fail")))).rejects.toThrow("fail")
    }

    expect(breaker.getState()).toBe("open")
  })

  it("rejects immediately when open", async () => {
    const breaker = new CircuitBreaker({ cooldownMs: 60_000, failureThreshold: 1 })

    await expect(breaker.execute(async () => await Promise.reject(new Error("fail")))).rejects.toThrow("fail")
    expect(breaker.getState()).toBe("open")

    await expect(breaker.execute(async () => await Promise.resolve("ok"))).rejects.toThrow(CircuitOpenError)
  })

  it("transitions to half-open after cooldown", async () => {
    const breaker = new CircuitBreaker({ cooldownMs: 10, failureThreshold: 1 })

    await expect(breaker.execute(async () => await Promise.reject(new Error("fail")))).rejects.toThrow()
    expect(breaker.getState()).toBe("open")

    await new Promise((r) => setTimeout(r, 15))

    const result = await breaker.execute(async () => await Promise.resolve("recovered"))

    expect(result).toBe("recovered")
    expect(breaker.getState()).toBe("closed")
  })

  it("re-opens if probe fails in half-open", async () => {
    const breaker = new CircuitBreaker({ cooldownMs: 10, failureThreshold: 1 })

    await expect(breaker.execute(async () => await Promise.reject(new Error("fail")))).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 15))

    await expect(breaker.execute(async () => await Promise.reject(new Error("still failing")))).rejects.toThrow()
    expect(breaker.getState()).toBe("open")
  })

  it("resets to closed", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 })

    await expect(breaker.execute(async () => await Promise.reject(new Error("fail")))).rejects.toThrow()
    expect(breaker.getState()).toBe("open")

    breaker.reset()
    expect(breaker.getState()).toBe("closed")
  })

  it("fires onStateChange callback", async () => {
    const onStateChange = vi.fn()
    const breaker = new CircuitBreaker({ cooldownMs: 10, failureThreshold: 1, onStateChange })

    await expect(breaker.execute(async () => await Promise.reject(new Error("fail")))).rejects.toThrow()
    expect(onStateChange).toHaveBeenCalledWith("open")

    await new Promise((r) => setTimeout(r, 15))

    await breaker.execute(async () => await Promise.resolve("ok"))
    expect(onStateChange).toHaveBeenCalledWith("half-open")
    expect(onStateChange).toHaveBeenCalledWith("closed")
  })

  it("closes after a success resets failure count", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 })

    // 2 failures
    await expect(breaker.execute(async () => await Promise.reject(new Error("fail")))).rejects.toThrow()
    await expect(breaker.execute(async () => await Promise.reject(new Error("fail")))).rejects.toThrow()

    // 1 success resets count
    await breaker.execute(async () => await Promise.resolve("ok"))
    expect(breaker.getState()).toBe("closed")

    // 2 more failures - should NOT trip since count was reset
    await expect(breaker.execute(async () => await Promise.reject(new Error("fail")))).rejects.toThrow()
    await expect(breaker.execute(async () => await Promise.reject(new Error("fail")))).rejects.toThrow()
    expect(breaker.getState()).toBe("closed")
  })
})
