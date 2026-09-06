import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect,it } from "vitest"

import tsupConfig from "../../tsup.config.js"

/**
 * Every entry tsup builds must be reachable through an `exports` subpath.
 *
 * Eight of the 26 were not, and three of those eight were *documented*:
 * README's "Tree-Shakeable Imports" section advertised
 * `@drakkar.software/anchor/query/queryBuilder`, `.../server/prefetch` and
 * `.../storage/storageActions`, and `server/prefetch.ts`'s own docstring told
 * readers to import from `.../server`. All four threw
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` — `exports` is an allowlist, so a path absent
 * from it is unreachable no matter what sits in `dist/`.
 *
 * Nothing caught it because the build succeeds either way: tsup writes the file
 * and `package.json` simply declines to point at it.
 */

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as {
  exports: Record<string, { import: string; require: string; types: string; }>
}

const entries = (tsupConfig as { entry: Record<string, string> }).entry

/** `./dist/query/filters.mjs` → `query/filters` */
function entryNameOf(importPath: string): string {
  return importPath.replace(/^\.\/dist\//v, "").replace(/\.mjs$/v, "")
}

describe("package exports cover every build entry", () => {
  const exported = new Set(Object.values(pkg.exports).map((e) => entryNameOf(e.import)))

  it.each(Object.keys(entries))("%s is reachable through an exports subpath", (entryName) => {
    expect(exported).toContain(entryName)
  })

  it("points every subpath at a file tsup actually builds", () => {
    // The other direction: an `exports` entry naming a path no entry produces is
    // a 404 at install time rather than a missing feature, and is just as
    // invisible to the build.
    const built = new Set(Object.keys(entries))

    for (const [subpath, target] of Object.entries(pkg.exports)) {
      expect(built, `${subpath} points at ${target.import}`).toContain(entryNameOf(target.import))
    }
  })

  it("keeps types, import and require on the same entry", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const base = entryNameOf(target.import)

      expect(target.types, subpath).toBe(`./dist/${base}.d.ts`)
      expect(target.require, subpath).toBe(`./dist/${base}.js`)
    }
  })

  it("exposes the specifiers the README and the prefetch docstring name", () => {
    // These four are the ones that were documented and did not resolve.
    for (const subpath of [
      "./query/queryBuilder",
      "./server",
      "./server/prefetch",
      "./storage/storageActions",
    ]) {
      expect(Object.keys(pkg.exports)).toContain(subpath)
    }
  })
})
