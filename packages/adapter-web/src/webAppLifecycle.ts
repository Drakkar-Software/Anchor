import type { AppLifecycleAdapter } from "@drakkar.software/anchor"

/**
 * Web implementation of AppLifecycleAdapter using the Page Visibility API.
 * Maps `document.visibilityState === "visible"` to foreground.
 * SSR-safe: returns no-op cleanup when `document` is unavailable.
 */
export class WebAppLifecycle implements AppLifecycleAdapter {
  onForeground(callback: () => void): () => void {
    if (typeof document === "undefined") {return () => {}}

    const handler = () => {
      if (document.visibilityState === "visible") {callback()}
    }

    document.addEventListener("visibilitychange", handler)

    return () => { document.removeEventListener("visibilitychange", handler); }
  }

  onBackground(callback: () => void): () => void {
    if (typeof document === "undefined") {return () => {}}

    const handler = () => {
      if (document.visibilityState === "hidden") {callback()}
    }

    document.addEventListener("visibilitychange", handler)

    return () => { document.removeEventListener("visibilitychange", handler); }
  }
}
