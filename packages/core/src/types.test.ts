import { describe, it, expect, afterEach, vi } from "vitest"
import { isPending, getPendingStatus, randomId, createTempId, isTempId } from "./types"

describe("randomId", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/

  it("returns a uuid where WebCrypto exists", () => {
    expect(randomId()).toMatch(UUID)
  })

  it("returns one where it does not", () => {
    // Hermes ships no WebCrypto, so a React Native app without a polyfill has
    // no `crypto` global at all — and `crypto.randomUUID` is equally absent
    // from plain HTTP in a browser. `createTempId` guarded for that from the
    // start; the mutation ids in `update`/`upsert`, the queued mutation's own
    // id and `batchOperations` all called it bare, which is the whole write
    // path throwing `crypto.randomUUID is not a function` on a device.
    vi.stubGlobal("crypto", undefined)
    expect(randomId()).toMatch(UUID)
  })

  it("keeps minting temp ids without it too", () => {
    vi.stubGlobal("crypto", { getRandomValues: () => new Uint8Array(0) })
    const id = createTempId()
    expect(isTempId(id)).toBe(true)
    expect(id.slice("_temp:".length)).toMatch(UUID)
  })
})

describe("isPending", () => {
  it("returns false for a row with no pending mutation", () => {
    expect(isPending({ id: 1, name: "test" })).toBe(false)
  })

  it("returns false when _anchor_pending is undefined", () => {
    expect(isPending({ id: 1, _anchor_pending: undefined })).toBe(false)
  })

  it("returns true for insert", () => {
    expect(isPending({ id: 1, _anchor_pending: "insert" })).toBe(true)
  })

  it("returns true for update", () => {
    expect(isPending({ id: 1, _anchor_pending: "update" })).toBe(true)
  })

  it("returns true for delete", () => {
    expect(isPending({ id: 1, _anchor_pending: "delete" })).toBe(true)
  })
})

describe("getPendingStatus", () => {
  it("returns null for a row with no pending mutation", () => {
    expect(getPendingStatus({ id: 1, name: "test" })).toBeNull()
  })

  it("returns the pending status string", () => {
    expect(getPendingStatus({ id: 1, _anchor_pending: "insert" })).toBe("insert")
    expect(getPendingStatus({ id: 1, _anchor_pending: "update" })).toBe("update")
    expect(getPendingStatus({ id: 1, _anchor_pending: "delete" })).toBe("delete")
  })
})
