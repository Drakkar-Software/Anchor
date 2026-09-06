import { beforeEach, describe, expect, it, vi } from "vitest"

import { SyncMetrics } from "./syncMetrics.js"

describe("SyncMetrics", () => {
  let metrics: SyncMetrics

  beforeEach(() => {
    metrics = new SyncMetrics()
  })

  it("fetchSuccess increments count and records latency", () => {
    metrics.fetchSuccess("todos", 5, 120)
    metrics.fetchSuccess("todos", 3, 80)

    const snap = metrics.getMetrics()

    expect(snap.fetchCount).toBe(2)
    expect(snap.fetchLatencyP50).toBe(80)
  })

  it("fetchError increments error count", () => {
    metrics.fetchError("todos", "timeout")
    metrics.fetchError("todos", "network")

    const snap = metrics.getMetrics()

    expect(snap.fetchErrorCount).toBe(2)
  })

  it("mutationSuccess increments count and records latency", () => {
    metrics.mutationSuccess("todos", "INSERT", 50)
    metrics.mutationSuccess("todos", "UPDATE", 30)

    const snap = metrics.getMetrics()

    expect(snap.mutationCount).toBe(2)
    expect(snap.mutationLatencyP50).toBe(30)
  })

  it("mutationError increments error count", () => {
    metrics.mutationError("todos", "INSERT", "conflict")
    metrics.mutationError("todos", "DELETE", "rls")

    const snap = metrics.getMetrics()

    expect(snap.mutationErrorCount).toBe(2)
  })

  it("getMetrics() computes correct percentiles", () => {
    // Add 100 latencies: 1, 2, 3, ..., 100
    for (let i = 1; i <= 100; i++) {
      metrics.fetchSuccess("todos", 1, i)
    }

    const snap = metrics.getMetrics()

    expect(snap.fetchCount).toBe(100)
    expect(snap.fetchLatencyP50).toBe(50)
    expect(snap.fetchLatencyP95).toBe(95)
    expect(snap.fetchLatencyP99).toBe(99)
  })

  it("getMetrics() returns 0 for latencies when no data", () => {
    const snap = metrics.getMetrics()

    expect(snap.fetchLatencyP50).toBe(0)
    expect(snap.fetchLatencyP95).toBe(0)
    expect(snap.fetchLatencyP99).toBe(0)
    expect(snap.mutationLatencyP50).toBe(0)
    expect(snap.mutationLatencyP95).toBe(0)
    expect(snap.mutationLatencyP99).toBe(0)
  })

  it("resetMetrics() zeroes everything", () => {
    metrics.fetchSuccess("todos", 5, 100)
    metrics.fetchError("todos", "err")
    metrics.mutationSuccess("todos", "INSERT", 50)
    metrics.mutationError("todos", "UPDATE", "err")
    metrics.queueFlushSuccess(1, 0)
    metrics.conflict("todos", "1")
    metrics.realtimeEvent("todos", "INSERT")

    metrics.resetMetrics()

    const snap = metrics.getMetrics()

    expect(snap.fetchCount).toBe(0)
    expect(snap.fetchErrorCount).toBe(0)
    expect(snap.fetchLatencyP50).toBe(0)
    expect(snap.mutationCount).toBe(0)
    expect(snap.mutationErrorCount).toBe(0)
    expect(snap.mutationLatencyP50).toBe(0)
    expect(snap.queueFlushCount).toBe(0)
    expect(snap.conflictCount).toBe(0)
    expect(snap.realtimeEventCount).toBe(0)
  })

  it("onMetricsUpdate callback fires on each event", () => {
    const cb = vi.fn()

    metrics.onMetricsUpdate(cb)

    metrics.fetchSuccess("todos", 1, 10)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ fetchCount: 1 }),
    )

    metrics.mutationError("todos", "INSERT", "err")
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenLastCalledWith(
      expect.objectContaining({ mutationErrorCount: 1 }),
    )
  })

  it("multiple subscribers receive updates", () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()

    metrics.onMetricsUpdate(cb1)
    metrics.onMetricsUpdate(cb2)

    metrics.conflict("todos", "42")

    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
    expect(cb1).toHaveBeenCalledWith(
      expect.objectContaining({ conflictCount: 1 }),
    )
  })

  it("unsubscribe stops callbacks", () => {
    const cb = vi.fn()
    const unsub = metrics.onMetricsUpdate(cb)

    metrics.realtimeEvent("todos", "INSERT")
    expect(cb).toHaveBeenCalledTimes(1)

    unsub()
    metrics.realtimeEvent("todos", "UPDATE")
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it("queueFlushSuccess increments flush count", () => {
    metrics.queueFlushSuccess(3, 1)
    metrics.queueFlushSuccess(2, 0)

    const snap = metrics.getMetrics()

    expect(snap.queueFlushCount).toBe(2)
  })

  it("conflict increments conflict count", () => {
    metrics.conflict("todos", 1)
    metrics.conflict("todos", 2)
    metrics.conflict("users", 3)

    const snap = metrics.getMetrics()

    expect(snap.conflictCount).toBe(3)
  })

  it("realtimeEvent increments realtime event count", () => {
    metrics.realtimeEvent("todos", "INSERT")
    metrics.realtimeEvent("todos", "UPDATE")
    metrics.realtimeEvent("todos", "DELETE")

    const snap = metrics.getMetrics()

    expect(snap.realtimeEventCount).toBe(3)
  })

  it("fetchStart does not notify (no state change)", () => {
    const cb = vi.fn()

    metrics.onMetricsUpdate(cb)
    metrics.fetchStart("todos")
    expect(cb).not.toHaveBeenCalled()
  })

  it("mutationStart does not notify (no state change)", () => {
    const cb = vi.fn()

    metrics.onMetricsUpdate(cb)
    metrics.mutationStart("todos", "INSERT")
    expect(cb).not.toHaveBeenCalled()
  })

  it("queueFlushStart does not notify (no state change)", () => {
    const cb = vi.fn()

    metrics.onMetricsUpdate(cb)
    metrics.queueFlushStart(5)
    expect(cb).not.toHaveBeenCalled()
  })
})
