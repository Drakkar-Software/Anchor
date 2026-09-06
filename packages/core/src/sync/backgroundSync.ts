import type { BackgroundTaskAdapter } from "../types.js"

const TASK_NAME = "anchor:background-sync"

export type BackgroundSyncOptions = {
  /** Custom task name (default: "anchor:background-sync") */
  taskName?: string
}

/**
 * Check if the background sync task is currently registered.
 */
export async function isBackgroundSyncRegistered(
  adapter: BackgroundTaskAdapter,
  taskName = TASK_NAME,
): Promise<boolean> {
  return await adapter.isRegistered(taskName)
}

/**
 * Register a background task that flushes the offline mutation queue.
 * Returns a cleanup function that unregisters the task.
 */
export async function setupBackgroundSync(
  queue: { flush: () => Promise<unknown> },
  adapter: BackgroundTaskAdapter,
  options?: BackgroundSyncOptions,
): Promise<() => Promise<void>> {
  const taskName = options?.taskName ?? TASK_NAME

  await adapter.register(taskName, async () => {
    await queue.flush()
  })

  return async () => {
    await adapter.unregister(taskName)
  }
}
