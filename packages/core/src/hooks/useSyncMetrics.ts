"use client"

import { useEffect,useState } from "react"

import type { MetricsSnapshot,SyncMetrics } from "../sync/syncMetrics.js"

/**
 * React hook that subscribes to SyncMetrics and returns a reactive snapshot.
 */
export function useSyncMetrics(metrics: SyncMetrics): MetricsSnapshot {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot>(() => metrics.getMetrics())

  useEffect(() => metrics.onMetricsUpdate(setSnapshot), [metrics])

  return snapshot
}
