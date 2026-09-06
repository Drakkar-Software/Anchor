import type { NetworkStatusAdapter } from "@drakkar.software/anchor"

/**
 * Web network status adapter using navigator.onLine and online/offline events.
 */
export class WebNetworkStatus implements NetworkStatusAdapter {
  isOnline(): boolean {
    return typeof navigator === "undefined" ? true : navigator.onLine
  }

  subscribe(callback: (online: boolean) => void): () => void {
    if (typeof globalThis === "undefined") {return () => {}}

    const onOnline = () => { callback(true); }
    const onOffline = () => { callback(false); }

    globalThis.addEventListener("online", onOnline)
    globalThis.addEventListener("offline", onOffline)

    return () => {
      globalThis.removeEventListener("online", onOnline)
      globalThis.removeEventListener("offline", onOffline)
    }
  }
}
