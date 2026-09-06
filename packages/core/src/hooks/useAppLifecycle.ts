"use client"

import { useEffect } from "react"

import { type AppLifecycleOptions , setupAppLifecycle } from "../lifecycle/appLifecycle.js"

/**
 * React hook that wires app lifecycle events to store operations.
 * Flushes queue, refreshes auth, and revalidates stale data on foreground.
 *
 * Options are captured at mount time. If stores/queue/authStore change,
 * remount the component or pass a new `adapter` instance to force re-setup.
 */
export function useAppLifecycle(options: AppLifecycleOptions): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setupAppLifecycle(options), [options.adapter])
}
