import { describe, it, expect, vi } from "vitest"
import {
  uploadFile,
  downloadFile,
  getPublicUrl,
  createSignedUrl,
  listFiles,
  removeFiles,
  createStorageActions,
} from "./storageActions.js"

function mockStorage(overrides: Record<string, any> = {}) {
  return {
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue(
          overrides.upload ?? { data: { path: "test/file.png" }, error: null },
        ),
        download: vi.fn().mockResolvedValue(
          overrides.download ?? { data: new Blob(["test"]), error: null },
        ),
        getPublicUrl: vi.fn().mockReturnValue(
          overrides.getPublicUrl ?? { data: { publicUrl: "https://example.com/file.png" } },
        ),
        createSignedUrl: vi.fn().mockResolvedValue(
          overrides.createSignedUrl ?? { data: { signedUrl: "https://example.com/signed" }, error: null },
        ),
        list: vi.fn().mockResolvedValue(
          overrides.list ?? { data: [{ name: "file.png", id: "1", metadata: {} }], error: null },
        ),
        remove: vi.fn().mockResolvedValue(
          overrides.remove ?? { error: null },
        ),
      }),
    },
  } as any
}

describe("uploadFile", () => {
  it("uploads a file and returns path", async () => {
    const supabase = mockStorage()
    const result = await uploadFile(supabase, "avatars", "user/pic.png", "data")
    expect(result.data).toEqual({ path: "test/file.png" })
    expect(result.error).toBeNull()
  })

  it("returns error on failure", async () => {
    const supabase = mockStorage({ upload: { data: null, error: { message: "Too large" } } })
    const result = await uploadFile(supabase, "avatars", "pic.png", "data")
    expect(result.data).toBeNull()
    expect(result.error!.message).toBe("Too large")
  })
})

describe("downloadFile", () => {
  it("downloads a file as blob", async () => {
    const supabase = mockStorage()
    const result = await downloadFile(supabase, "avatars", "pic.png")
    expect(result.data).toBeInstanceOf(Blob)
    expect(result.error).toBeNull()
  })
})

describe("getPublicUrl", () => {
  it("returns public URL", () => {
    const supabase = mockStorage()
    const url = getPublicUrl(supabase, "avatars", "pic.png")
    expect(url).toBe("https://example.com/file.png")
  })

  it("does not throw, because its five siblings return {data, error} and callers do not catch it", () => {
    // This used to assert a throw on `{data: null}`. storage-js cannot produce
    // that — `getPublicUrl` builds a URL string from the project URL, bucket and
    // path, makes no request, and its own signature has no error channel. So
    // the guard was error handling for an impossible scenario, and a real
    // hazard: `hooks/useStorage.ts`'s `getUrl` does not catch, so the throw
    // escaped into render.
    const supabase = mockStorage()
    expect(() => getPublicUrl(supabase, "avatars", "pic.png")).not.toThrow()
  })

  it("returns a URL for a bucket that does not exist, which 404s when fetched", () => {
    // The same thing the raw API does. Refusing here would be Anchor inventing
    // a failure mode Supabase does not have.
    const supabase = mockStorage()
    expect(getPublicUrl(supabase, "no-such-bucket", "pic.png")).toBe(
      "https://example.com/file.png",
    )
  })
})

describe("createSignedUrl", () => {
  it("creates a signed URL", async () => {
    const supabase = mockStorage()
    const result = await createSignedUrl(supabase, "avatars", "pic.png", { expiresIn: 3600 })
    expect(result.data!.signedUrl).toBe("https://example.com/signed")
  })
})

describe("listFiles", () => {
  it("lists files in a path", async () => {
    const supabase = mockStorage()
    const result = await listFiles(supabase, "avatars", "uploads/")
    expect(result.data).toHaveLength(1)
    expect(result.data![0]!.name).toBe("file.png")
  })
})

describe("removeFiles", () => {
  it("removes files", async () => {
    const supabase = mockStorage()
    const result = await removeFiles(supabase, "avatars", ["old.png"])
    expect(result.error).toBeNull()
  })

  it("returns error on failure", async () => {
    const supabase = mockStorage({ remove: { error: { message: "Not found" } } })
    const result = await removeFiles(supabase, "avatars", ["missing.png"])
    expect(result.error!.message).toBe("Not found")
  })
})

describe("createStorageActions", () => {
  it("creates a bound storage helper", async () => {
    const supabase = mockStorage()
    const storage = createStorageActions(supabase, "avatars")

    const uploadResult = await storage.upload("path", "data")
    expect(uploadResult.data).toBeDefined()

    const url = storage.getPublicUrl("path")
    expect(url).toBe("https://example.com/file.png")
  })
})
