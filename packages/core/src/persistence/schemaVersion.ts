import type { PersistenceAdapter } from "../types.js"

const SCHEMA_VERSION_KEY = "anchor:__schema_version"

export type SchemaVersionResult = {
  previousVersion: number | null
  versionChanged: boolean
}

/**
 * Check if the stored schema version matches the current version.
 * If mismatch: clears all `anchor:` prefixed cache keys and updates stored version.
 * After cache clear, normal fetch() repopulates from Supabase.
 */
export async function checkSchemaVersion(
  adapter: PersistenceAdapter,
  currentVersion: number,
): Promise<SchemaVersionResult> {
  const stored = await adapter.getItem<number>(SCHEMA_VERSION_KEY)

  if (stored === currentVersion) {
    return { previousVersion: stored, versionChanged: false }
  }

  // Version mismatch — clear all zs: prefixed keys
  if (adapter.keys && adapter.clear) {
    const allKeys = await adapter.keys("anchor:")
    const removals: Promise<void>[] = []

    for (const key of allKeys) {
      if (key === SCHEMA_VERSION_KEY) {continue}

      removals.push(adapter.removeItem(key))
    }

    await Promise.all(removals)
  } else if (adapter.clear) {
    await adapter.clear()
  }

  // Store the new version
  await adapter.setItem(SCHEMA_VERSION_KEY, currentVersion)

  return { previousVersion: stored, versionChanged: true }
}

/**
 * Read the currently stored schema version.
 */
export async function getSchemaVersion(
  adapter: PersistenceAdapter,
): Promise<number | null> {
  return await adapter.getItem<number>(SCHEMA_VERSION_KEY)
}

/**
 * Manually set the schema version without clearing cache.
 */
export async function setSchemaVersion(
  adapter: PersistenceAdapter,
  version: number,
): Promise<void> {
  await adapter.setItem(SCHEMA_VERSION_KEY, version)
}
