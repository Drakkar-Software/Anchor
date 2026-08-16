import { describe, it, expect, vi } from "vitest"

const createClientSpy = vi.fn(() => ({ from: () => ({}), auth: {}, rpc: () => ({}) }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientSpy(...(args as [])),
}))

const { createAnchorClient } = await import("./createClient.js")

describe("createAnchorClient", () => {
  it("passes the url, the key and the options straight through", async () => {
    // The whole point of the module is that it adds nothing: an app's auth
    // settings — a platform `storage`, `detectSessionInUrl` for one that
    // handles its own callback — are supabase-js's to interpret, and anything
    // this wrapper reshaped would be a second place to keep them correct.
    const options = {
      auth: {
        storage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    }

    createAnchorClient("https://project.supabase.co", "anon-key", options as never)

    expect(createClientSpy).toHaveBeenCalledWith(
      "https://project.supabase.co",
      "anon-key",
      options,
    )
  })

  it("works with no options at all", () => {
    createClientSpy.mockClear()
    createAnchorClient("https://project.supabase.co", "anon-key")

    expect(createClientSpy).toHaveBeenCalledWith(
      "https://project.supabase.co",
      "anon-key",
      undefined,
    )
  })

  it("returns whatever supabase-js returned, unwrapped", () => {
    // Not a facade: the client keeps its own `.from()`/`.auth`/`.rpc`, so a
    // consumer's `Database` generic still reaches per-table row inference.
    const client = createAnchorClient("https://project.supabase.co", "anon-key")

    expect(client).toBe(createClientSpy.mock.results.at(-1)?.value)
    expect(typeof client.from).toBe("function")
  })
})
