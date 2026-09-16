import { beforeEach } from "vitest"

/**
 * In-memory Web Storage. jsdom 30 has no Storage on opaque origins, and
 * Node 25+ exposes a global `localStorage` getter that is `undefined` without
 * `--localstorage-file`, which shadows any jsdom store.
 */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>()

  return {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(key) {
      return map.get(key) ?? null
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null
    },
    removeItem(key) {
      map.delete(key)
    },
    setItem(key, value) {
      map.set(String(key), String(value))
    },
  }
}

function installLocalStorage(): void {
  const storage = createMemoryStorage()

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    value: storage,
    writable: true,
  })

  if (globalThis.window) {
    Object.defineProperty(globalThis.window, "localStorage", {
      configurable: true,
      enumerable: true,
      value: storage,
      writable: true,
    })
  }
}

installLocalStorage()
beforeEach(() => {
  installLocalStorage()
})
