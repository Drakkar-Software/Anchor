/// <reference lib="dom" />
import type { StoreApi } from "zustand"

type CrossTabPayload = {
  order: (string | number)[]
  records: [string | number, unknown][]
  sessionId?: string
}

type SyncableState = {
  isHydrated: boolean
  isRestoring: boolean
  order: (string | number)[]
  records: Map<string | number, unknown>
}

/**
 * The next store snapshot for one incoming payload, or null when it must be ignored.
 *
 * BroadcastChannel and the localStorage fallback both used to paste this merge.
 * They have to stay identical: a pending row is local-only until its write lands,
 * so whichever transport delivers the other tab's snapshot has to put that row
 * back, and put its id back on `order` when the sender never had it.
 */
function mergedCrossTabState(
  store: StoreApi<SyncableState>,
  payload: CrossTabPayload,
  sessionId?: string,
): Pick<SyncableState, "isRestoring" | "order" | "records"> | null {
  if (sessionId && payload.sessionId && payload.sessionId !== sessionId) {return null}

  const current = store.getState()

  // Don't apply cross-tab data during hydration. It would overwrite a partial load.
  if (!current.isHydrated) {return null}

  const records = new Map(payload.records)
  const order = Array.from(payload.order)
  const orderSet = new Set<string | number>(order)

  for (const [id, row] of current.records) {
    if (!(row as any)?._anchor_pending) {continue}

    records.set(id, row)

    if (!orderSet.has(id)) {
      order.push(id)
      orderSet.add(id)
    }
  }

  return { isRestoring: false, order, records }
}

/**
 * Sets up cross-tab synchronization using the BroadcastChannel API.
 * State changes in one tab are automatically reflected in others.
 *
 * @param sessionId - Optional session ID to prevent data leaking across auth sessions.
 */
export function setupBroadcastSync(
  store: StoreApi<SyncableState>,
  name: string,
  sessionId?: string,
): () => void {
  const channel = new BroadcastChannel(`anchor:${name}`)

  let receiving = false

  channel.onmessage = (event: MessageEvent<CrossTabPayload>) => {
    const next = mergedCrossTabState(store, event.data, sessionId)

    if (!next) {return}

    receiving = true

    try {
      store.setState(next)
    } finally {
      receiving = false
    }
  }

  const unsub = store.subscribe((state, prev) => {
    // Don't echo back received data
    if (receiving) {return}

    // Don't broadcast during restore
    if (state.isRestoring) {return}

    // Only broadcast if records or order changed
    if (state.records === prev.records && state.order === prev.order) {return}

    try {
      channel.postMessage({
        order: state.order,
        records: Array.from(state.records.entries()),
        sessionId,
      } satisfies CrossTabPayload)
    } catch (error) {
      console.warn(`[anchor:crossTab:${name}] Failed to broadcast:`, error)
    }
  })

  return () => {
    unsub()
    channel.close()
  }
}

/**
 * Sets up cross-tab synchronization using the best available method.
 * Uses BroadcastChannel when available, falls back to localStorage events.
 *
 * @param sessionId - Optional session ID to prevent data leaking across auth sessions.
 */
export function setupCrossTabSync(
  store: StoreApi<SyncableState>,
  name: string,
  sessionId?: string,
): () => void {
  if (typeof BroadcastChannel !== "undefined") {
    return setupBroadcastSync(store, name, sessionId)
  }

  if (
    typeof globalThis !== "undefined" &&
    typeof localStorage !== "undefined"
  ) {
    return setupStorageFallback(store, name, sessionId)
  }

  return () => {}
}

/**
 * Sets up cross-tab synchronization using localStorage events.
 * Fallback for environments without BroadcastChannel support.
 *
 * @param sessionId - Optional session ID to prevent data leaking across auth sessions.
 */
export function setupStorageFallback(
  store: StoreApi<SyncableState>,
  name: string,
  sessionId?: string,
): () => void {
  const key = `anchor:broadcast:${name}`

  let receiving = false

  const onStorage = (event: StorageEvent) => {
    if (event.key !== key || !event.newValue) {return}

    try {
      const payload = JSON.parse(event.newValue) as CrossTabPayload
      const next = mergedCrossTabState(store, payload, sessionId)

      if (!next) {return}

      receiving = true

      try {
        store.setState(next)
      } finally {
        receiving = false
      }
    } catch (error) {
      console.warn(`[anchor:crossTab:${name}] Failed to parse cross-tab data:`, error)
    }
  }

  if (typeof globalThis !== "undefined") {
    globalThis.addEventListener("storage", onStorage)
  }

  const unsub = store.subscribe((state, prev) => {
    if (receiving) {return}

    if (state.isRestoring) {return}

    if (state.records === prev.records && state.order === prev.order) {return}

    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          order: state.order,
          records: Array.from(state.records.entries()),
          sessionId,
        } satisfies CrossTabPayload),
      )
    } catch (error) {
      console.warn(`[anchor:crossTab:${name}] Failed to persist cross-tab data:`, error)
    }
  })

  return () => {
    unsub()

    if (typeof globalThis !== "undefined") {
      globalThis.removeEventListener("storage", onStorage)
    }
  }
}
