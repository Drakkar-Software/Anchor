import { vi } from "vitest"

type MockRow = Record<string, unknown>

/**
 * Creates a mock Supabase client for testing.
 * Simulates an in-memory database with basic CRUD.
 */
export function createMockSupabase(initialData: Record<string, MockRow[]> = {}) {
  const tables: Record<string, MockRow[]> = {}
  for (const [name, rows] of Object.entries(initialData)) {
    tables[name] = [...rows]
  }

  let nextId = 1000

  function getTable(name: string): MockRow[] {
    if (!tables[name]) tables[name] = []
    return tables[name]!
  }

  // Build chainable query builder
  function createBuilder(tableName: string) {
    let selectColumns = "*"
    let filters: Array<{ column: string; op: string; value: unknown }> = []
    let limitVal: number | null = null
    let rangeStart: number | null = null
    let rangeEnd: number | null = null
    let sortRules: Array<{ column: string; ascending: boolean }> = []
    let singleMode = false
    let maybeSingleMode = false
    let countMode: string | null = null

    function applyFilters(rows: MockRow[]): MockRow[] {
      let result = rows
      for (const f of filters) {
        result = result.filter((row) => {
          const val = row[f.column]
          switch (f.op) {
            case "eq": return val === f.value
            case "neq": return val !== f.value
            case "gt": return (val as number) > (f.value as number)
            case "gte": return (val as number) >= (f.value as number)
            case "lt": return (val as number) < (f.value as number)
            case "lte": return (val as number) <= (f.value as number)
            case "like": return typeof val === "string" && new RegExp(String(f.value).replace(/%/g, ".*")).test(val)
            case "ilike": return typeof val === "string" && new RegExp(String(f.value).replace(/%/g, ".*"), "i").test(val)
            case "in": return Array.isArray(f.value) && (f.value as unknown[]).includes(val)
            case "is": return val === f.value
            default: return true
          }
        })
      }
      return result
    }

    function applySort(rows: MockRow[]): MockRow[] {
      if (sortRules.length === 0) return rows
      return [...rows].sort((a, b) => {
        for (const rule of sortRules) {
          const aVal = a[rule.column] as any
          const bVal = b[rule.column] as any
          if (aVal < bVal) return rule.ascending ? -1 : 1
          if (aVal > bVal) return rule.ascending ? 1 : -1
        }
        return 0
      })
    }

    const builder: any = {
      select(cols?: string, opts?: { count?: string }) {
        if (cols) selectColumns = cols
        if (opts?.count) countMode = opts.count
        return builder
      },
      eq(column: string, value: unknown) {
        filters.push({ column, op: "eq", value })
        return builder
      },
      neq(column: string, value: unknown) {
        filters.push({ column, op: "neq", value })
        return builder
      },
      gt(column: string, value: unknown) {
        filters.push({ column, op: "gt", value })
        return builder
      },
      gte(column: string, value: unknown) {
        filters.push({ column, op: "gte", value })
        return builder
      },
      lt(column: string, value: unknown) {
        filters.push({ column, op: "lt", value })
        return builder
      },
      lte(column: string, value: unknown) {
        filters.push({ column, op: "lte", value })
        return builder
      },
      like(column: string, value: unknown) {
        filters.push({ column, op: "like", value })
        return builder
      },
      ilike(column: string, value: unknown) {
        filters.push({ column, op: "ilike", value })
        return builder
      },
      in(column: string, value: unknown) {
        filters.push({ column, op: "in", value })
        return builder
      },
      is(column: string, value: unknown) {
        filters.push({ column, op: "is", value })
        return builder
      },
      contains(column: string, value: unknown) {
        filters.push({ column, op: "contains", value })
        return builder
      },
      containedBy(column: string, value: unknown) {
        filters.push({ column, op: "containedBy", value })
        return builder
      },
      overlaps(column: string, value: unknown) {
        filters.push({ column, op: "overlaps", value })
        return builder
      },
      textSearch(column: string, query: string, opts?: any) {
        filters.push({ column, op: "textSearch", value: query })
        return builder
      },
      not(column: string, op: string, value: unknown) {
        // Simplified
        return builder
      },
      or(filterString: string) {
        return builder
      },
      filter(column: string, op: string, value: unknown) {
        return builder
      },
      order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
        sortRules.push({ column, ascending: opts?.ascending ?? true })
        return builder
      },
      limit(n: number) {
        limitVal = n
        return builder
      },
      range(from: number, to: number) {
        rangeStart = from
        rangeEnd = to
        return builder
      },
      single() {
        singleMode = true
        return builder
      },
      maybeSingle() {
        maybeSingleMode = true
        return builder
      },

      // Terminal - resolves the query
      then(resolve: (value: any) => void, reject?: (reason?: any) => void) {
        try {
          let rows = applyFilters(getTable(tableName))
          rows = applySort(rows)

          if (rangeStart != null && rangeEnd != null) {
            rows = rows.slice(rangeStart, rangeEnd + 1)
          } else if (limitVal != null) {
            rows = rows.slice(0, limitVal)
          }

          if (singleMode) {
            if (rows.length === 0) {
              resolve({ data: null, error: { message: "No rows found", code: "PGRST116" }, count: null })
            } else {
              resolve({ data: rows[0], error: null, count: countMode ? rows.length : null })
            }
          } else if (maybeSingleMode) {
            resolve({ data: rows[0] ?? null, error: null, count: countMode ? rows.length : null })
          } else {
            resolve({ data: rows, error: null, count: countMode ? rows.length : null })
          }
        } catch (err) {
          if (reject) reject(err)
          else resolve({ data: null, error: { message: String(err) }, count: null })
        }
      },

      // Insert operation
      insert(row: MockRow | MockRow[]) {
        const rows = Array.isArray(row) ? row : [row]
        const table = getTable(tableName)
        const inserted: MockRow[] = []
        for (const r of rows) {
          const newRow = { ...r }
          if (!newRow.id) {
            newRow.id = nextId++
          }
          if (!newRow.created_at) {
            newRow.created_at = new Date().toISOString()
          }
          if (!newRow.updated_at) {
            newRow.updated_at = new Date().toISOString()
          }
          table.push(newRow)
          inserted.push(newRow)
        }
        // Return a builder that resolves to the inserted rows
        return createInsertedBuilder(tableName, inserted)
      },

      // Update operation
      update(changes: MockRow) {
        return createUpdateBuilder(tableName, changes, filters)
      },

      // Upsert operation
      upsert(row: MockRow | MockRow[]) {
        const rows = Array.isArray(row) ? row : [row]
        const table = getTable(tableName)
        const upserted: MockRow[] = []
        for (const r of rows) {
          const existing = table.findIndex((t) => t.id === r.id)
          const newRow = { ...r, updated_at: new Date().toISOString() }
          if (existing >= 0) {
            table[existing] = { ...table[existing], ...newRow }
            upserted.push(table[existing]!)
          } else {
            if (!newRow.id) newRow.id = nextId++
            if (!newRow.created_at) newRow.created_at = new Date().toISOString()
            table.push(newRow)
            upserted.push(newRow)
          }
        }
        return createInsertedBuilder(tableName, upserted)
      },

      // Delete operation
      delete() {
        return createDeleteBuilder(tableName, filters)
      },
    }

    return builder
  }

  function createInsertedBuilder(tableName: string, inserted: MockRow[]) {
    let selectCols = "*"
    let singleMode = false

    const builder: any = {
      select(cols?: string) {
        if (cols) selectCols = cols
        return builder
      },
      single() {
        singleMode = true
        return builder
      },
      then(resolve: (value: any) => void) {
        if (singleMode) {
          resolve({ data: inserted[0] ?? null, error: null })
        } else {
          resolve({ data: inserted, error: null })
        }
      },
    }
    return builder
  }

  function createUpdateBuilder(
    tableName: string,
    changes: MockRow,
    existingFilters: Array<{ column: string; op: string; value: unknown }>,
  ) {
    const filters = [...existingFilters]

    const builder: any = {
      eq(column: string, value: unknown) {
        filters.push({ column, op: "eq", value })
        return builder
      },
      select(cols?: string) {
        return builder
      },
      single() {
        const table = getTable(tableName)
        const idx = table.findIndex((row) =>
          filters.every((f) => {
            if (f.op === "eq") return row[f.column] === f.value
            return true
          }),
        )

        return {
          then(resolve: (value: any) => void) {
            if (idx >= 0) {
              table[idx] = { ...table[idx], ...changes, updated_at: new Date().toISOString() }
              resolve({ data: table[idx], error: null })
            } else {
              resolve({ data: null, error: { message: "Row not found" } })
            }
          },
        }
      },
      then(resolve: (value: any) => void) {
        const table = getTable(tableName)
        const updated: MockRow[] = []
        for (let i = 0; i < table.length; i++) {
          const row = table[i]!
          const match = filters.every((f) => {
            if (f.op === "eq") return row[f.column] === f.value
            return true
          })
          if (match) {
            table[i] = { ...row, ...changes, updated_at: new Date().toISOString() }
            updated.push(table[i]!)
          }
        }
        resolve({ data: updated, error: null })
      },
    }
    return builder
  }

  function createDeleteBuilder(
    tableName: string,
    existingFilters: Array<{ column: string; op: string; value: unknown }>,
  ) {
    const filters = [...existingFilters]

    const builder: any = {
      eq(column: string, value: unknown) {
        filters.push({ column, op: "eq", value })
        return builder
      },
      then(resolve: (value: any) => void) {
        const table = getTable(tableName)
        const remaining = table.filter(
          (row) =>
            !filters.every((f) => {
              if (f.op === "eq") return row[f.column] === f.value
              return true
            }),
        )
        tables[tableName] = remaining
        resolve({ data: null, error: null })
      },
    }
    return builder
  }

  // Auth mock
  const authListeners: Array<(event: string, session: any) => void> = []
  let currentSession: any = null

  const client = {
    from(table: string) {
      return createBuilder(table)
    },
    auth: {
      async getSession() {
        return { data: { session: currentSession }, error: null }
      },
      async getUser() {
        return { data: { user: currentSession?.user ?? null }, error: null }
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const session = { access_token: "mock-token", user: { id: "user-1", email } }
        currentSession = session
        for (const listener of authListeners) listener("SIGNED_IN", session)
        return { data: { session, user: session.user }, error: null }
      },
      async signUp({ email, password }: { email: string; password: string }) {
        const session = { access_token: "mock-token", user: { id: "user-1", email } }
        currentSession = session
        for (const listener of authListeners) listener("SIGNED_IN", session)
        return { data: { session, user: session.user }, error: null }
      },
      async signOut() {
        currentSession = null
        for (const listener of authListeners) listener("SIGNED_OUT", null)
        return { error: null }
      },
      async signInWithOAuth({ provider }: { provider: string; options?: any }) {
        return { error: null }
      },
      async refreshSession() {
        return { data: { session: currentSession, user: currentSession?.user ?? null }, error: null }
      },
      onAuthStateChange(callback: (event: string, session: any) => void) {
        authListeners.push(callback)
        // Fire initial event
        callback("INITIAL_SESSION", currentSession)
        return {
          data: {
            subscription: {
              unsubscribe() {
                const idx = authListeners.indexOf(callback)
                if (idx >= 0) authListeners.splice(idx, 1)
              },
            },
          },
        }
      },
    },
    channel(name: string) {
      return {
        on(event: string, filter: any, callback: any) {
          return this
        },
        subscribe(statusCallback?: (status: string) => void) {
          if (statusCallback) statusCallback("SUBSCRIBED")
          return this
        },
      }
    },
    removeChannel(channel: any) {},
    realtime: {
      async setAuth(_token: string | null) {},
    },

    // Test helpers
    _tables: tables,
    _setSession(session: any) {
      currentSession = session
    },
  }

  return client as any
}
