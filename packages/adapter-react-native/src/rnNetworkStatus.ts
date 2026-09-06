import type { NetworkStatusAdapter } from "@drakkar.software/anchor"

interface NetInfoModule {
  addEventListener: (
    callback: (state: { isConnected: boolean | null }) => void,
  ) => () => void
}

/**
 * React Native network status adapter using @react-native-community/netinfo.
 *
 * Pass the NetInfo default export as the argument to avoid bundler
 * resolution issues in pnpm virtual store environments.
 *
 * @example
 * import NetInfo from '@react-native-community/netinfo'
 * new RNNetworkStatus(NetInfo)
 */
export class RNNetworkStatus implements NetworkStatusAdapter {
  private readonly netInfo: NetInfoModule

constructor(NetInfo: NetInfoModule) {
    this.netInfo = NetInfo
  }

isOnline(): boolean {
    return this._isOnline
  }

subscribe(callback: (online: boolean) => void): () => void {
    return this.netInfo.addEventListener(
      (state: { isConnected: boolean | null }) => {
        this._isOnline = state.isConnected ?? false
        callback(this._isOnline)
      },
    )
  }

private _isOnline = true
  

  

  

  
}
