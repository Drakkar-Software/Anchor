import type { PersistenceAdapter } from "../types.js"

export type EncryptionFunctions = {
  decrypt: (ciphertext: string) => Promise<string>
  encrypt: (plaintext: string) => Promise<string>
}

/**
 * Wraps any PersistenceAdapter to transparently encrypt/decrypt stored values.
 * Keys are stored in plaintext; only values are encrypted.
 */
export class EncryptedAdapter implements PersistenceAdapter {
  constructor(
    private readonly inner: PersistenceAdapter,
    private readonly crypto: EncryptionFunctions,
  ) {}

  async getItem<T>(key: string): Promise<T | null> {
    const encrypted = await this.inner.getItem<string>(key)

    if (encrypted === null) {return null}

    const json = await this.crypto.decrypt(encrypted)

    return JSON.parse(json) as T
  }

  async setItem<T>(key: string, value: T): Promise<void> {
    const json = JSON.stringify(value)
    const encrypted = await this.crypto.encrypt(json)

    await this.inner.setItem(key, encrypted)
  }

  async removeItem(key: string): Promise<void> {
    await this.inner.removeItem(key)
  }

  async multiSet(entries: [string, unknown][]): Promise<void> {
    const encrypted: [string, unknown][] = await Promise.all(
      entries.map(async ([key, value]) => {
        const json = JSON.stringify(value)
        const enc = await this.crypto.encrypt(json)

        return [key, enc] as [string, unknown]
      }),
    )

    await (this.inner.multiSet ? this.inner.multiSet(encrypted) : Promise.all(
        encrypted.map(async ([key, value]) => { await this.inner.setItem(key, value); }),
      ));
  }

  async keys(prefix?: string): Promise<string[]> {
    if (!this.inner.keys) {
      throw new Error("EncryptedAdapter: inner adapter does not support keys()")
    }

    return await this.inner.keys(prefix)
  }

  async clear(): Promise<void> {
    if (!this.inner.clear) {
      throw new Error("EncryptedAdapter: inner adapter does not support clear()")
    }

    await this.inner.clear();
  }
}

/**
 * Create encryption functions using Web Crypto API (AES-GCM).
 * Works in browsers and Node.js 20+. Throws if crypto.subtle is unavailable.
 */
export function createWebCryptoEncryption(key: CryptoKey): EncryptionFunctions {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "createWebCryptoEncryption requires the Web Crypto API (crypto.subtle). " +
      "Available in browsers and Node.js 20+.",
    )
  }

  return {
    async decrypt(ciphertext: string): Promise<string> {
      const combined = Uint8Array.from(atob(ciphertext), (c) =>
        c.charCodeAt(0),
      )
      const iv = combined.slice(0, 12)
      const data = combined.slice(12)
      const decrypted = await crypto.subtle.decrypt(
        { iv, name: "AES-GCM" },
        key,
        data,
      )

      return new TextDecoder().decode(decrypted)
    },

    async encrypt(plaintext: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encoded = new TextEncoder().encode(plaintext)
      const ciphertext = await crypto.subtle.encrypt(
        { iv, name: "AES-GCM" },
        key,
        encoded,
      )

      // Combine IV + ciphertext and base64-encode
      const combined = new Uint8Array(iv.length + ciphertext.byteLength)

      combined.set(iv, 0)
      combined.set(new Uint8Array(ciphertext), iv.length)

      return btoa(String.fromCharCode(...combined))
    },
  }
}
