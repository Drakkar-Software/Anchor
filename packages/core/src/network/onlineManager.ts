import type { NetworkStatusAdapter } from "../types.js"

/**
 * Manual-only network status adapter.
 * Use platform-specific adapters (WebNetworkStatus, RNNetworkStatus) for auto-detection.
 */
export class ManualNetworkStatus implements NetworkStatusAdapter {
  private readonly listeners = new Set<(online: boolean) => void>()

isOnline(): boolean {
    return this._online
  }

setOnline(online: boolean): void {
    if (this._online === online) {return}

    this._online = online

    for (const listener of this.listeners) {
      listener(online)
    }
  }

subscribe(callback: (online: boolean) => void): () => void {
    this.listeners.add(callback)

    return () => {
      this.listeners.delete(callback)
    }
  }

private _online = true
  

  

  

  
}
