import type { AppLifecycleAdapter } from "@drakkar.software/anchor"

interface AppStateModule {
  addEventListener: (
    event: string,
    handler: (state: string) => void,
  ) => { remove: () => void }
  currentState: string
}

/**
 * React Native implementation of AppLifecycleAdapter using AppState.
 * Maps AppState "active" to foreground, "background"/"inactive" to background.
 *
 * Pass AppState from react-native to avoid bundler resolution issues
 * in pnpm virtual store environments.
 *
 * @example
 * import { AppState } from 'react-native'
 * new RNAppLifecycle(AppState)
 */
export class RNAppLifecycle implements AppLifecycleAdapter {
  private readonly AppState: AppStateModule

  constructor(AppState: AppStateModule) {
    this.AppState = AppState
  }

  onForeground(callback: () => void): () => void {
    let previousState = this.AppState.currentState

    const subscription = this.AppState.addEventListener(
      "change",
      (nextState: string) => {
        if (previousState !== "active" && nextState === "active") {
          callback()
        }

        previousState = nextState
      },
    )

    return () => { subscription.remove(); }
  }

  onBackground(callback: () => void): () => void {
    let previousState = this.AppState.currentState

    const subscription = this.AppState.addEventListener(
      "change",
      (nextState: string) => {
        if (previousState === "active" && nextState !== "active") {
          callback()
        }

        previousState = nextState
      },
    )

    return () => { subscription.remove(); }
  }
}
