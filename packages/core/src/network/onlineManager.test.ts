import { describe, expect, it, vi } from "vitest"

import { ManualNetworkStatus } from "./onlineManager.js"

describe("ManualNetworkStatus", () => {
  it("defaults to online", () => {
    const ns = new ManualNetworkStatus()

    expect(ns.isOnline()).toBe(true)
  })

  it("setOnline changes state", () => {
    const ns = new ManualNetworkStatus()

    ns.setOnline(false)
    expect(ns.isOnline()).toBe(false)
    ns.setOnline(true)
    expect(ns.isOnline()).toBe(true)
  })

  it("notifies subscribers on change", () => {
    const ns = new ManualNetworkStatus()
    const callback = vi.fn()

    ns.subscribe(callback)

    ns.setOnline(false)
    expect(callback).toHaveBeenCalledWith(false)

    ns.setOnline(true)
    expect(callback).toHaveBeenCalledWith(true)
  })

  it("does not fire when value unchanged", () => {
    const ns = new ManualNetworkStatus()
    const callback = vi.fn()

    ns.subscribe(callback)

    ns.setOnline(true) // Already true
    expect(callback).not.toHaveBeenCalled()
  })

  it("unsubscribe stops notifications", () => {
    const ns = new ManualNetworkStatus()
    const callback = vi.fn()
    const unsub = ns.subscribe(callback)

    unsub()
    ns.setOnline(false)
    expect(callback).not.toHaveBeenCalled()
  })

  it("supports multiple subscribers", () => {
    const ns = new ManualNetworkStatus()
    const cb1 = vi.fn()
    const cb2 = vi.fn()

    ns.subscribe(cb1)
    ns.subscribe(cb2)

    ns.setOnline(false)
    expect(cb1).toHaveBeenCalledWith(false)
    expect(cb2).toHaveBeenCalledWith(false)
  })
})
