/** Which builder an injected error belongs to. */
type MockOperation =
  | "select"
  | "insert"
  | "update"
  | "upsert"
  | "delete"
  | "rpc"

/** A recorded filter. `or` carries its alternatives in `value`. */
type Filter = {
  column: string
  negate?: boolean
  op: string
  value: unknown
}

type InjectedError = {
  error: { code?: string; details?: string; hint?: string; message: string; }
  once: boolean
  status: number
}

type MockRow = Record<string, unknown>

/**
 * Creates a mock Supabase client for testing.
 * Simulates an in-memory database with basic CRUD.
 */
export function createMockSupabase(initialData: Record<string, MockRow[]> = {}) {
  const tables: Record<string, MockRow[]> = {}

  for (const [name, rows] of Object.entries(initialData)) {
    tables[name] = Array.from(rows)
  }

  let nextId = 1000

  const rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {}
  const injectedErrors = new Map<string, InjectedError>()

  function getTable(name: string): MockRow[] {
    tables[name] ||= []

    return tables[name]
  }

  /**
   * An error queued by `_setError`, consumed if it was registered `once`.
   *
   * Without this the mock had no failure path at all on the read side — every
   * non-`single` read resolved `error: null` — so every error-handling test had
   * to bring its own stub, and none of them exercised the same code the passing
   * tests did.
   */
  function takeError(tableName: string, op: MockOperation): InjectedError | null {
    const key = `${tableName}:${op}`
    const hit = injectedErrors.get(key)

    if (!hit) {return null}

    if (hit.once) {injectedErrors.delete(key)}

    return hit
  }

  function errorResponse(hit: InjectedError, count: number | null = null) {
    return {
      count,
      data: null,
      error: hit.error,
      status: hit.status,
      statusText: hit.status === 0 ? "" : "Error",
    }
  }

  /** Split on commas that are not inside embed parentheses. */
  function splitTopLevel(spec: string): string[] {
    const out: string[] = []

    let depth = 0
    let current = ""

    for (const ch of spec) {
      if (ch === "(") {depth++}

      if (ch === ")") {depth--}

      if (ch === "," && depth === 0) {
        out.push(current.trim())
        current = ""

        continue
      }

      current += ch
    }

    if (current.trim()) {out.push(current.trim())}

    return out
  }

  /**
   * Project rows through a `select` string.
   *
   * `select` used to be recorded and never read, so every test saw whole rows
   * regardless of what it asked for — a store built with a narrow
   * `defaultSelect` looked identical to one selecting `*`, and no test could
   * catch a column the real PostgREST would not have returned.
   *
   * This lives at factory scope, not inside `createBuilder`, because there are
   * four builders (read, insert/upsert, update, delete) and each one accepts
   * `select`. Projecting in only the read builder leaves every WRITE
   * unobservable, which is the half that matters: a store mutation issues
   * `.insert(...).select(defaultSelect ?? '*')`, so the write path is where a
   * narrow select is most likely to be wrong.
   *
   * Handles the shapes the store layer emits: a bare column list, `*`,
   * aliases, and embeds (`'*, stages(*)'`). An embedded name resolves against
   * the in-memory tables by matching `<table>_id` back to the parent's `id`,
   * which is enough to exercise a store's handling of nested arrays.
   */
  function project(rows: MockRow[], spec: string, tableName: string): MockRow[] {
    const trimmed = spec.trim()

    if (trimmed === "*" || trimmed === "") {return rows}

    const plain: string[] = []
    const embeds: string[] = []

    let star = false

    for (const part of splitTopLevel(trimmed)) {
      const embed = /^(\w+)\s*\((.*)\)$/sv.exec(part)

      if (embed) {embeds.push(embed[1]!)}
      else if (part === "*") {star = true}
      else {plain.push(part.split(":").pop()!.trim())}
    }

    return rows.map((row) => {
      const out: MockRow = star ? { ...row } : {}

      for (const col of plain) {
        if (col in row) {out[col] = row[col]}
      }

      for (const name of embeds) {
        const fk = `${tableName.replace(/s$/v, "")}_id`

        out[name] = (tables[name] ?? []).filter((c) => c[fk] === row.id)
      }

      return out
    })
  }

  // ─── Filtering ──────────────────────────────────────────────────────
  //
  // One predicate, shared by select, update and delete. They used to disagree:
  // `select` honoured ten operators and `update`/`delete` honoured only `eq`,
  // silently treating every other filter as "match" — so a delete carrying a
  // `gt` emptied the table and the test that asserted one row went away passed.

  /**
   * `%` is any run, `_` is one character, and the pattern is anchored — SQL
   * `LIKE`, not a regex. The old translation was unanchored, so `like('abc')`
   * matched `xabcx`; a store that dropped the anchors could not be caught.
   */
  function likeToRegExp(pattern: unknown, insensitive: boolean): RegExp {
    const escaped = String(pattern).replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
    const source = `^${escaped.replaceAll("%", ".*").replaceAll("_", ".")}$`

    return new RegExp(source, insensitive ? "i" : "")
  }

  function compare(a: unknown, b: unknown): number {
    if (a === null || a === undefined) {return -1}

    if (b === null || b === undefined) {return 1}

    if (typeof a === "number" && typeof b === "number") {return a - b}

    const as = String(a)
    const bs = String(b)

    return as < bs ? -1 : as > bs ? 1 : 0
  }

  /**
   * Postgres' own text search is not reproducible here, but "matches anything"
   * is the answer that cannot fail a test. Tokenised containment is wrong at
   * the edges (no stemming, no ranking) and right often enough that a dropped
   * `textSearch` filter changes the result set.
   */
  function textSearchMatch(actual: unknown, spec: unknown): boolean {
    if (typeof actual !== "string") {return false}

    const { query, type } = spec as { query: string; type?: string }
    const haystack = actual.toLowerCase()

    if (type === "phrase") {
      return haystack.includes(query.trim().toLowerCase())
    }

    const terms = query
      .split(/[\s&|!()]+/u)
      .map((t) => t.replaceAll(/^'|'$/gv, "").trim().toLowerCase())
      .filter(Boolean)

    return terms.every((t) => new RegExp(`\\b${t.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}`).test(haystack))
  }

  function asArray(value: unknown): unknown[] | null {
    return Array.isArray(value) ? value : null
  }

  function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  /**
   * PostgREST spells its operators differently in `.filter()`/`.or()` strings
   * than the builder methods do. Normalising here means a hand-written
   * `.or('tags.cs.{a}')` and a `.contains()` land on the same implementation.
   */
  const OP_ALIASES: Record<string, string> = {
    cd: "containedBy",
    cs: "contains",
    fts: "textSearch",
    ov: "overlaps",
    phfts: "textSearch",
    plfts: "textSearch",
    wfts: "textSearch",
  }

  function matchOne(row: MockRow, f: Filter): boolean {
    if (f.op === "or") {
      return (f.value as Filter[]).some((clause) => matchOne(row, clause))
    }

    const op = OP_ALIASES[f.op] ?? f.op
    const val = row[f.column]

    let result: boolean

    switch (op) {
      case "containedBy": {
        const actual = asArray(val)
        const wanted = asArray(f.value)

        if (actual && wanted) {result = actual.every((v) => wanted.includes(v))}
        else if (isPlainObject(val) && isPlainObject(f.value)) {
          result = Object.keys(val).every((k) => val[k] === (f.value as MockRow)[k])
        } else {result = false}

        break
      }
      case "contains": {
        const actual = asArray(val)
        const wanted = asArray(f.value)

        if (actual && wanted) {result = wanted.every((v) => actual.includes(v))}
        else if (isPlainObject(val) && isPlainObject(f.value)) {
          result = Object.entries(f.value).every(([k, v]) => val[k] === v)
        } else {result = false}

        break
      }
      case "eq": {
        result = val === f.value

        break
      }
      case "gt": {
        result = compare(val, f.value) > 0

        break
      }
      case "gte": {
        result = compare(val, f.value) >= 0

        break
      }
      case "ilike": {
        result = typeof val === "string" && likeToRegExp(f.value, true).test(val)

        break
      }
      case "in": {
        result = Array.isArray(f.value) && (f.value as unknown[]).includes(val)

        break
      }
      case "is": {
        // PostgREST's `is` is identity against null/true/false, not equality.
        result = val === f.value

        break
      }
      case "like": {
        result = typeof val === "string" && likeToRegExp(f.value, false).test(val)

        break
      }
      case "lt": {
        result = compare(val, f.value) < 0

        break
      }
      case "lte": {
        result = compare(val, f.value) <= 0

        break
      }
      case "neq": {
        result = val !== f.value

        break
      }
      case "overlaps": {
        const actual = asArray(val)
        const wanted = asArray(f.value)

        result = actual != null && wanted != null && actual.some((v) => wanted.includes(v))

        break
      }
      case "textSearch": {
        result = textSearchMatch(val, f.value)

        break
      }

      default: {
        // An operator this mock does not implement must not pass silently. The
        // old `default: return true` is why `contains`, `containedBy`,
        // `overlaps` and `textSearch` were accepted, ignored, and asserted on
        // by tests that could not fail.
        throw new Error(
          `mockSupabase: unimplemented filter operator "${f.op}". ` +
            "Implement it in matchOne() rather than letting it match every row.",
        )
      }
    }

    return f.negate ? !result : result
  }

  function matchesFilters(row: MockRow, filters: Filter[]): boolean {
    return filters.every((f) => matchOne(row, f))
  }

  /** `null` / `true` / `false` / `12` / `(1,2)` / `"quoted"`, as PostgREST writes them. */
  function coerceLiteral(raw: string): unknown {
    const t = raw.trim()

    if (t === "null") {return null}

    if (t === "true") {return true}

    if (t === "false") {return false}

    if (t.startsWith("(") && t.endsWith(")")) {
      return splitTopLevel(t.slice(1, -1)).map(coerceLiteral)
    }

    if (t.startsWith("{") && t.endsWith("}")) {
      return t.slice(1, -1).split(",").map(coerceLiteral)
    }

    if (t !== "" && !Number.isNaN(Number(t))) {return Number(t)}

    return t.replaceAll(/^"|"$/gv, "")
  }

  /**
   * Parse one PostgREST filter clause: `column.op.value`, optionally
   * `column.not.op.value`. Nested `and(...)`/`or(...)` groups throw rather than
   * being dropped — a silently ignored clause is the bug this file is fixing.
   */
  function parseClause(clause: string): Filter {
    const trimmed = clause.trim()

    if (/^(and|or)\(/iv.test(trimmed)) {
      throw new Error(
        `mockSupabase: nested "${trimmed.slice(0, 3)}(...)" groups are not supported in or()/filter(). ` +
          "Express the query with separate filters, or implement nesting here.",
      )
    }

    const first = trimmed.indexOf(".")

    if (first === -1) {throw new Error(`mockSupabase: malformed filter clause "${clause}"`)}

    const column = trimmed.slice(0, first)

    let rest = trimmed.slice(first + 1)
    let negate = false

    if (rest.startsWith("not.")) {
      negate = true
      rest = rest.slice(4)
    }

    const second = rest.indexOf(".")

    if (second === -1) {throw new Error(`mockSupabase: malformed filter clause "${clause}"`)}

    const op = rest.slice(0, second)
    const raw = rest.slice(second + 1)
    const value = op === "textSearch" || OP_ALIASES[op] === "textSearch"
      ? { query: String(coerceLiteral(raw)) }
      : coerceLiteral(raw)

    return { column, negate, op, value }
  }

  // Build chainable query builder
  function createBuilder(tableName: string) {
    let selectColumns = "*"

    const filters: Filter[] = []

    let limitVal: number | null = null
    let rangeStart: number | null = null
    let rangeEnd: number | null = null

    const sortRules: { ascending: boolean; column: string; }[] = []

    let singleMode = false
    let maybeSingleMode = false
    let countMode: string | null = null
    let headMode = false

    function applyFilters(rows: MockRow[]): MockRow[] {
      return rows.filter((row) => matchesFilters(row, filters))
    }

    function applySort(rows: MockRow[]): MockRow[] {
      if (sortRules.length === 0) {return rows}

      return Array.from(rows).sort((a, b) => {
        for (const rule of sortRules) {
          const aVal = a[rule.column] as any
          const bVal = b[rule.column] as any

          if (aVal < bVal) {return rule.ascending ? -1 : 1}

          if (aVal > bVal) {return rule.ascending ? 1 : -1}
        }

        return 0
      })
    }

    const push = (column: string, op: string, value: unknown) => {
      filters.push({ column, op, value })

      return builder
    }

    const builder: any = {
      containedBy: (c: string, v: unknown) => push(c, "containedBy", v),
      contains: (c: string, v: unknown) => push(c, "contains", v),


      // Delete operation
      delete() {
        const injected = takeError(tableName, "delete")

        if (injected) {return createFailedBuilder(injected)}

        return createDeleteBuilder(tableName, filters)
      },

      eq: (c: string, v: unknown) => push(c, "eq", v),

      filter(column: string, op: string, value: unknown) {
        const negate = op.startsWith("not.")

        filters.push({ column, negate, op: negate ? op.slice(4) : op, value })

        return builder
      },

      gt: (c: string, v: unknown) => push(c, "gt", v),
      gte: (c: string, v: unknown) => push(c, "gte", v),
      ilike: (c: string, v: unknown) => push(c, "ilike", v),
      in: (c: string, v: unknown) => push(c, "in", v),


      // Insert operation
      insert(row: MockRow | MockRow[]) {
        const injected = takeError(tableName, "insert")

        if (injected) {return createFailedBuilder(injected)}

        const rows = Array.isArray(row) ? row : [row]
        const table = getTable(tableName)
        const inserted: MockRow[] = []

        for (const r of rows) {
          const newRow = { ...r }

          newRow.id ||= nextId++;
          newRow.created_at ||= new Date().toISOString();
          newRow.updated_at ||= new Date().toISOString();
          table.push(newRow)
          inserted.push(newRow)
        }


        // Return a builder that resolves to the inserted rows
        return createWroteBuilder(tableName, inserted, 201)
      },

      is: (c: string, v: unknown) => push(c, "is", v),
      like: (c: string, v: unknown) => push(c, "like", v),

      limit(n: number) {
        limitVal = n

        return builder
      },

      lt: (c: string, v: unknown) => push(c, "lt", v),
      lte: (c: string, v: unknown) => push(c, "lte", v),


      /** `.match({a: 1, b: 2})` is sugar for two `eq`s — same as PostgREST. */
      match(query: Record<string, unknown>) {
        for (const [column, value] of Object.entries(query)) {
          filters.push({ column, op: "eq", value })
        }

        return builder
      },

      maybeSingle() {
        maybeSingleMode = true

        return builder
      },

      neq: (c: string, v: unknown) => push(c, "neq", v),

      not(column: string, op: string, value: unknown) {
        filters.push({ column, negate: true, op, value })

        return builder
      },

      or(filterString: string) {
        filters.push({
          column: "",
          op: "or",
          value: splitTopLevel(filterString).map(parseClause),
        })

        return builder
      },

      order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
        sortRules.push({ ascending: opts?.ascending ?? true, column })

        return builder
      },

      overlaps: (c: string, v: unknown) => push(c, "overlaps", v),

      range(from: number, to: number) {
        rangeStart = from
        rangeEnd = to

        return builder
      },

      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        if (cols) {selectColumns = cols}

        if (opts?.count) {countMode = opts.count}

        if (opts?.head) {headMode = true}

        return builder
      },

      single() {
        singleMode = true

        return builder
      },

      textSearch(column: string, query: string, opts?: { config?: string; type?: string; }) {
        return push(column, "textSearch", { config: opts?.config, query, type: opts?.type })
      },

      // Terminal - resolves the query
      then(resolve: (value: any) => void, reject?: (reason?: any) => void) {
        try {
          const injected = takeError(tableName, "select")

          if (injected) {
            resolve(errorResponse(injected))

            return
          }

          let rows = applyFilters(getTable(tableName))

          rows = applySort(rows)

          // PostgREST counts the rows MATCHING the filters, not the rows it
          // returns: `range`/`limit` narrow `data` and leave `count` alone.
          // Counting after the slice made `data.length < count` unreachable, so
          // createTableStore's truncation warning could never fire in a test —
          // and any assertion about a total would have passed vacuously.
          const total = rows.length

          if (rangeStart != null && rangeEnd != null) {
            rows = rows.slice(rangeStart, rangeEnd + 1)
          } else if (limitVal != null) {
            rows = rows.slice(0, limitVal)
          }

          // `head: true` asks for the count and no body.
          if (headMode) {
            resolve({ count: total, data: null, error: null, status: 200, statusText: "OK" })

            return
          }

          const projected = project(rows, selectColumns, tableName)
          const ok = { count: countMode ? total : null, error: null, status: 200, statusText: "OK" }

          if (singleMode) {
            if (projected.length === 0) {
              resolve({
                count: null,
                data: null,
                error: { code: "PGRST116", message: "No rows found" },
                status: 406,
                statusText: "Not Acceptable",
              })
            } else {
              resolve({ data: projected[0], ...ok })
            }
          } else if (maybeSingleMode) {
            resolve({ data: projected[0] ?? null, ...ok })
          } else {
            resolve({ data: projected, ...ok })
          }
        } catch (error) {
          if (reject) {reject(error)}
          else {resolve({ count: null, data: null, error: { message: String(error) }, status: 500 })}
        }
      },

      // Update operation
      update(changes: MockRow) {
        const injected = takeError(tableName, "update")

        if (injected) {return createFailedBuilder(injected)}

        return createUpdateBuilder(tableName, changes, filters)
      },

      // Upsert operation
      //
      // The conflict target used to be hardcoded to `id`, which made every
      // assertion about `onConflict` pass whatever the option did — the same
      // shape as the `count`-after-range bug: a mock that agrees with correct
      // behaviour and with a dropped option equally cannot fail. It now matches
      // on the named columns, so a store that stops forwarding the option
      // inserts a duplicate here exactly as Postgres would raise `23505`.
      upsert(row: MockRow | MockRow[], options?: { ignoreDuplicates?: boolean; onConflict?: string; }) {
        const injected = takeError(tableName, "upsert")

        if (injected) {return createFailedBuilder(injected)}

        const rows: MockRow[] = Array.isArray(row) ? row : [row]
        const table = getTable(tableName)
        const conflictColumns = options?.onConflict
          ? options.onConflict.split(",").map((c) => c.trim())
          : ["id"]
        const upserted: MockRow[] = []

        for (const r of rows) {
          // NULLS DISTINCT, which is Postgres' default: two nulls do not
          // conflict, so a statement whose conflict column is null — or absent
          // from the payload — cannot match and inserts instead. Treating them
          // as equal would let a test assert replace-not-duplicate on a
          // nullable column, pass here, and fail against the real database.
          const matchable = conflictColumns.every((c) => r[c] != null)
          const existing = matchable
            ? table.findIndex((t) =>
                conflictColumns.every((c) => t[c] != null && t[c] === r[c]),
              )
            : -1
          const newRow: MockRow = { ...r, updated_at: new Date().toISOString() }

          if (existing >= 0) {
            // `ignoreDuplicates` is ON CONFLICT DO NOTHING: the row stays as it
            // was and no representation comes back for it.
            if (options?.ignoreDuplicates) {continue}

            table[existing] = { ...table[existing], ...newRow }
            upserted.push(table[existing])
          } else {
            newRow.id ||= nextId++
            newRow.created_at ||= new Date().toISOString()
            table.push(newRow)
            upserted.push(newRow)
          }
        }

        return createWroteBuilder(tableName, upserted, 201)
      },
    }

    return builder
  }

  /**
   * A builder whose every terminal resolves to the injected failure.
   *
   * It has to accept the *whole* chainable surface, not the handful a first
   * test happened to use: a method it lacks throws `TypeError: builder.gt is
   * not a function` and the caller sees that instead of the error under test.
   * That is the same failure this file exists to prevent — the mock answering
   * something other than what was asked.
   */
  function createFailedBuilder(injected: InjectedError) {
    const builder: any = {
      then(resolve: (value: any) => void) {
        resolve(errorResponse(injected))
      },
    }

    for (const method of [
      "select", "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in",
      "is", "contains", "containedBy", "overlaps", "textSearch", "match", "not",
      "or", "filter", "order", "limit", "range", "single", "maybeSingle",
    ]) {
      builder[method] = () => builder
    }

    return builder
  }

  /**
   * The result of a write. Named for what it is rather than for `insert`,
   * because `upsert` returns one too.
   */
  function createWroteBuilder(tableName: string, wrote: MockRow[], status: number) {
    let selectCols = "*"
    let singleMode = false
    let maybeSingleMode = false

    const builder: any = {
      maybeSingle() {
        maybeSingleMode = true

        return builder
      },

      select(cols?: string) {
        if (cols) {selectCols = cols}

        return builder
      },

      single() {
        singleMode = true

        return builder
      },

      then(resolve: (value: any) => void) {
        // A store mutation always appends `.select(defaultSelect ?? '*')`, so
        // this is the path a narrow select is most likely to be wrong on.
        const projected = project(wrote, selectCols, tableName)
        const ok = { error: null, status, statusText: "Created" }

        if (singleMode) {
          // Real PostgREST raises PGRST116 when `.single()` gets nothing back —
          // which is exactly what an `ignoreDuplicates` upsert that conflicted
          // produces. Resolving `{data: null, error: null}` here let the store
          // treat "wrote nothing" as "wrote successfully".
          if (projected.length === 0) {
            resolve({
              data: null,
              error: { code: "PGRST116", message: "No rows found" },
              status: 406,
              statusText: "Not Acceptable",
            })

            return
          }

          resolve({ data: projected[0], ...ok })
        } else if (maybeSingleMode) {
          resolve({ data: projected[0] ?? null, ...ok })
        } else {
          resolve({ data: projected, ...ok })
        }
      },
    }

    return builder
  }

  function createUpdateBuilder(tableName: string, changes: MockRow, existingFilters: Filter[]) {
    const filters = Array.from(existingFilters)

    let selectCols = "*"

    function applyToMatches(): MockRow[] {
      const table = getTable(tableName)
      const updated: MockRow[] = []

      for (let i = 0; i < table.length; i++) {
        if (!matchesFilters(table[i]!, filters)) {continue}

        table[i] = { ...table[i], ...changes, updated_at: new Date().toISOString() }
        updated.push(table[i]!)
      }

      return updated
    }

    const push = (column: string, op: string, value: unknown) => {
      filters.push({ column, op, value })

      return builder
    }

    const builder: any = {
      containedBy: (c: string, v: unknown) => push(c, "containedBy", v),
      contains: (c: string, v: unknown) => push(c, "contains", v),
      eq: (c: string, v: unknown) => push(c, "eq", v),
      gt: (c: string, v: unknown) => push(c, "gt", v),
      gte: (c: string, v: unknown) => push(c, "gte", v),
      ilike: (c: string, v: unknown) => push(c, "ilike", v),
      in: (c: string, v: unknown) => push(c, "in", v),
      is: (c: string, v: unknown) => push(c, "is", v),
      like: (c: string, v: unknown) => push(c, "like", v),
      lt: (c: string, v: unknown) => push(c, "lt", v),
      lte: (c: string, v: unknown) => push(c, "lte", v),

      maybeSingle() {
        return {
          then(resolve: (value: any) => void) {
            const updated = applyToMatches()

            resolve({
              data: updated.length > 0 ? project([updated[0]!], selectCols, tableName)[0] : null,
              error: null,
              status: 200,
              statusText: "OK",
            })
          },
        }
      },

      neq: (c: string, v: unknown) => push(c, "neq", v),
      overlaps: (c: string, v: unknown) => push(c, "overlaps", v),

      select(cols?: string) {
        if (cols) {selectCols = cols}

        return builder
      },

      single() {
        return {
          then(resolve: (value: any) => void) {
            const updated = applyToMatches()

            if (updated.length === 0) {
              resolve({
                data: null,
                error: { code: "PGRST116", message: "No rows found" },
                status: 406,
                statusText: "Not Acceptable",
              })

              return
            }

            resolve({
              data: project([updated[0]!], selectCols, tableName)[0],
              error: null,
              status: 200,
              statusText: "OK",
            })
          },
        }
      },

      then(resolve: (value: any) => void) {
        const updated = applyToMatches()

        resolve({
          data: project(updated, selectCols, tableName),
          error: null,
          status: 200,
          statusText: "OK",
        })
      },
    }

    return builder
  }

  function createDeleteBuilder(tableName: string, existingFilters: Filter[]) {
    const filters = Array.from(existingFilters)

    let selectCols: string | null = null

    function removeMatches(): MockRow[] {
      const table = getTable(tableName)
      const removed = table.filter((row) => matchesFilters(row, filters))

      tables[tableName] = table.filter((row) => !matchesFilters(row, filters))

      return removed
    }

    const push = (column: string, op: string, value: unknown) => {
      filters.push({ column, op, value })

      return builder
    }

    const builder: any = {
      eq: (c: string, v: unknown) => push(c, "eq", v),
      gt: (c: string, v: unknown) => push(c, "gt", v),
      gte: (c: string, v: unknown) => push(c, "gte", v),
      ilike: (c: string, v: unknown) => push(c, "ilike", v),
      in: (c: string, v: unknown) => push(c, "in", v),
      is: (c: string, v: unknown) => push(c, "is", v),
      like: (c: string, v: unknown) => push(c, "like", v),
      lt: (c: string, v: unknown) => push(c, "lt", v),
      lte: (c: string, v: unknown) => push(c, "lte", v),
      neq: (c: string, v: unknown) => push(c, "neq", v),

      select(cols?: string) {
        selectCols = cols ?? "*"

        return builder
      },

      single() {
        return {
          then(resolve: (value: any) => void) {
            const removed = removeMatches()

            if (removed.length === 0) {
              resolve({
                data: null,
                error: { code: "PGRST116", message: "No rows found" },
                status: 406,
                statusText: "Not Acceptable",
              })

              return
            }

            resolve({
              data: project([removed[0]!], selectCols ?? "*", tableName)[0],
              error: null,
              status: 200,
              statusText: "OK",
            })
          },
        }
      },

      then(resolve: (value: any) => void) {
        const removed = removeMatches()


        // Without a `.select()` PostgREST returns no representation, which is
        // what the store's `remove()` expects.
        resolve({
          data: selectCols == null ? null : project(removed, selectCols, tableName),
          error: null,
          status: 200,
          statusText: "OK",
        })
      },
    }

    return builder
  }

  // Auth mock
  const authListeners: ((event: string, session: any) => void)[] = []

  let currentSession: any = null

  /** Live channels, so a test can assert what was subscribed and torn down. */
  const channels: any[] = []

  const client = {
    _channels: channels,

    _clearErrors() {
      injectedErrors.clear()
    },


    /**
     * Make the next (or every) call on `table` fail.
     *
     * `status` matters: `errors.ts`'s `isTransportError` only classifies a
     * failure as never-reached-Postgres when the response carries `status: 0`,
     * so a queue-on-transport-failure test must inject that explicitly rather
     * than relying on a missing field.
     */
    _setError(
      table: string,
      op: MockOperation,
      error: { code?: string; details?: string; hint?: string; message: string; },
      opts?: { once?: boolean; status?: number; },
    ) {
      injectedErrors.set(`${table}:${op}`, {
        error,
        once: opts?.once ?? false,
        status: opts?.status ?? 400,
      })
    },

    _setRpc(name: string, handler: (args: Record<string, unknown>) => unknown) {
      rpcHandlers[name] = handler
    },

    _setSession(session: any) {
      currentSession = session
    },


    // Test helpers
    _tables: tables,

    auth: {
      async getSession() {
        return { data: { session: currentSession }, error: null }
      },

      async getUser() {
        return { data: { user: currentSession?.user ?? null }, error: null }
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

                if (idx !== -1) {authListeners.splice(idx, 1)}
              },
            },
          },
        }
      },

      async refreshSession() {
        return { data: { session: currentSession, user: currentSession?.user ?? null }, error: null }
      },

      async signInWithOAuth(_credentials: { options?: any; provider: string; }) {
        return { error: null }
      },

      async signInWithPassword({ email }: { email: string; password: string }) {
        const session = { access_token: "mock-token", user: { email, id: "user-1" } }

        currentSession = session

        for (const listener of authListeners) {listener("SIGNED_IN", session)}

        return { data: { session, user: session.user }, error: null }
      },

      async signOut() {
        currentSession = null

        for (const listener of authListeners) {listener("SIGNED_OUT", null)}

        return { error: null }
      },

      async signUp({ email }: { email: string; password: string }) {
        const session = { access_token: "mock-token", user: { email, id: "user-1" } }

        currentSession = session

        for (const listener of authListeners) {listener("SIGNED_IN", session)}

        return { data: { session, user: session.user }, error: null }
      },
    },

    channel(name: string) {
      return createMockChannel(name)
    },

    from(table: string) {
      return createBuilder(table)
    },

    getChannels() {
      return Array.from(channels)
    },

    realtime: {
      async setAuth(_token: string | null) {},
    },

    removeAllChannels() {
      channels.length = 0
    },

    removeChannel(channel: any) {
      const idx = channels.indexOf(channel)

      if (idx !== -1) {channels.splice(idx, 1)}

      // A removed channel delivers nothing. Dropping it from the list but
      // leaving its bindings live would let `_fireEvent` keep reaching a store
      // that had unsubscribed — the mock agreeing with an unsubscribe that
      // works and one that does not.
      if (channel) {channel._removed = true}
    },


    /**
     * Postgres functions. Register one with `_setRpc(name, handler)`; an
     * unregistered name resolves to the shape PostgREST returns for a missing
     * function rather than throwing, so a test asserting the failure path does
     * not need a try/catch.
     *
     * Thenable rather than async, matching the query builder, because callers
     * both `await` it and pass it straight to `queryFn`.
     */
    rpc(name: string, args?: Record<string, unknown>) {
      return {
        then(resolve: (value: any) => void) {
          const injected = takeError(name, "rpc")

          if (injected) {
            resolve(errorResponse(injected))

            return
          }

          const handler = rpcHandlers[name]

          if (!handler) {
            resolve({
              count: null,
              data: null,

              error: {
                code: "PGRST202",
                message: `Could not find the function public.${name}`,
              },

              status: 404,
              statusText: "Not Found",
            })

            return
          }

          const result = handler(args ?? {})

          resolve({
            count: Array.isArray(result) ? result.length : null,
            data: result,
            error: null,
            status: 200,
            statusText: "OK",
          })
        },
      }
    },


    /**
     * Non-public schemas. `fromTable()` in `query/queryExecutor.ts` routes every
     * schema-scoped store through `.schema(name).from(table)`, and this method
     * did not exist — so every one of those paths threw `TypeError` and no
     * multi-schema behaviour, `createSchemaRpc` included, could be tested.
     *
     * Tables live under a `schema.table` key, so seed them as
     * `createMockSupabase({ "app.things": [...] })`.
     */
    schema(name: string) {
      const prefix = name === "public" ? "" : `${name}.`

      return {
        from: (table: string) => createBuilder(`${prefix}${table}`),
        rpc: (fn: string, args?: Record<string, unknown>) => client.rpc(`${prefix}${fn}`, args),
      }
    },
  }

  // ─── Realtime ───────────────────────────────────────────────────────
  //
  // `channel()` used to return an object that discarded every callback, so no
  // event could be delivered and `realtimeManager.test.ts` and
  // `realtimeBindings.test.ts` each had to define their own channel mock. This
  // one records bindings and lets a test drive them.

  function createMockChannel(topic: string) {
    const bindings: { callback: (payload: any) => void; filter: any; type: string; }[] = []
    const statusCallbacks: ((status: string, err?: Error) => void)[] = []
    const presence: Record<string, unknown[]> = {}
    const sent: { event: string; payload?: any; type: string; }[] = []

    const channel: any = {
      // Test drivers
      _bindings: bindings,


      /** Deliver a payload to every binding whose type and event match. */
      _fireEvent(type: string, payload: any, event?: string) {
        if (channel._removed) {return}

        for (const b of bindings) {
          if (b.type !== type) {continue}

          const want = event ?? payload?.eventType
          const bound = b.filter?.event

          if (bound && bound !== "*" && want && bound !== want) {continue}

          b.callback(payload)
        }
      },

      _fireStatus(status: string, err?: Error) {
        for (const cb of statusCallbacks) {cb(status, err)}
      },

      _removed: false,
      _sent: sent,

      on(type: string, filter: any, callback: (payload: any) => void) {
        bindings.push({ callback, filter, type })

        return channel
      },

      presenceState() {
        return { ...presence }
      },

      async send(args: { event: string; payload?: any; type: string; }) {
        sent.push(args)

        return "ok"
      },

      subscribe(statusCallback?: (status: string, err?: Error) => void) {
        if (statusCallback) {
          statusCallbacks.push(statusCallback)
          statusCallback("SUBSCRIBED")
        }

        return channel
      },

      topic,

      async track(payload: Record<string, unknown>) {
        presence[topic] = [{ presence_ref: "ref-1", ...payload }]

        return "ok"
      },

      async unsubscribe() {
        return "ok"
      },

      async untrack() {
        delete presence[topic]

        return "ok"
      },
    }

    channels.push(channel)

    return channel
  }

  return client as any
}
