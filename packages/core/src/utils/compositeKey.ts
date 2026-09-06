/**
 * Apply primary key equality filters to a Supabase builder.
 */
export function applyPkFilters(
  builder: any,
  primaryKey: string | string[],
  id: string | number,
): any {
  if (typeof primaryKey === "string") {
    return builder.eq(primaryKey, id)
  }

  let values: unknown[]

  try {
    values = JSON.parse(String(id)) as unknown[]
  } catch {
    throw new Error(
      `Failed to decode composite primary key from "${String(id)}". Expected JSON-encoded array for key [${primaryKey.join(", ")}].`,
    )
  }

  let q = builder

  for (const [i, element] of primaryKey.entries()) {
    q = q.eq(element, values[i])
  }

  return q
}

/**
 * Build a filter object for a primary key (used in Supabase .eq() chains).
 */
export function buildPkFilter(
  primaryKey: string | string[],
  id: string | number,
): Record<string, unknown> {
  if (typeof primaryKey === "string") {
    return { [primaryKey]: id }
  }


  // Decode JSON-encoded composite key
  let values: unknown[]

  try {
    values = JSON.parse(String(id)) as unknown[]
  } catch {
    throw new Error(
      `Failed to decode composite primary key from "${String(id)}". Expected JSON-encoded array for key [${primaryKey.join(", ")}].`,
    )
  }

  const filter: Record<string, unknown> = {}

  for (const [i, element] of primaryKey.entries()) {
    filter[element] = values[i]
  }

  return filter
}

/**
 * Encode a composite primary key into a single string for Map storage.
 * For single keys, returns the value as-is. For composite, uses JSON to
 * preserve types and avoid separator ambiguity.
 */
export function encodeKey(
  row: Record<string, unknown>,
  primaryKey: string | string[],
): string | number {
  if (typeof primaryKey === "string") {
    return row[primaryKey] as string | number
  }

  return JSON.stringify(primaryKey.map((k) => row[k]))
}

/**
 * Get the primary key column name(s) as a normalized string[].
 */
export function normalizePk(primaryKey: string | string[]): string[] {
  return typeof primaryKey === "string" ? [primaryKey] : primaryKey
}
