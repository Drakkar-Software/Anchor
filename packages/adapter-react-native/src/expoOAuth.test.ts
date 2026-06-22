import { describe, it, expect, beforeEach, vi } from "vitest"
import { createExpoOAuthHandler } from "./expoOAuth.js"

const mockLinking = {
  createURL: (path: string) => `myapp://${path}`,
  parse: (url: string) => {
    const urlObj = new URL(url)
    const queryParams: Record<string, string> = {}
    urlObj.searchParams.forEach((value, key) => {
      queryParams[key] = value
    })
    return { queryParams }
  },
}

function createMockSupabase() {
  return {
    auth: {
      signInWithOAuth: vi.fn().mockResolvedValue({
        data: { url: "https://accounts.google.com/o/oauth2/auth?..." },
        error: null,
      }),
      exchangeCodeForSession: vi.fn().mockResolvedValue({
        data: { session: {} },
        error: null,
      }),
      setSession: vi.fn().mockResolvedValue({
        data: { session: {} },
        error: null,
      }),
    },
  } as any
}

describe("createExpoOAuthHandler", () => {
  let supabase: ReturnType<typeof createMockSupabase>

  beforeEach(() => {
    supabase = createMockSupabase()
  })

  describe("getRedirectUrl", () => {
    it("uses expo-linking createURL by default", () => {
      const handler = createExpoOAuthHandler(supabase, mockLinking)
      expect(handler.getRedirectUrl()).toBe("myapp://auth/callback")
    })

    it("uses custom scheme when provided", () => {
      const handler = createExpoOAuthHandler(supabase, mockLinking, {
        redirectScheme: "customapp",
      })
      expect(handler.getRedirectUrl()).toBe("customapp://auth/callback")
    })

    it("uses custom path when provided", () => {
      const handler = createExpoOAuthHandler(supabase, mockLinking, {
        redirectPath: "oauth/redirect",
      })
      expect(handler.getRedirectUrl()).toBe("myapp://oauth/redirect")
    })
  })

  describe("signInWithProvider", () => {
    it("calls supabase signInWithOAuth with correct provider and redirectTo", async () => {
      const handler = createExpoOAuthHandler(supabase, mockLinking)
      const result = await handler.signInWithProvider("google")

      expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: { redirectTo: "myapp://auth/callback" },
      })
      expect(result.url).toBe("https://accounts.google.com/o/oauth2/auth?...")
    })

    it("throws on auth error", async () => {
      supabase.auth.signInWithOAuth.mockResolvedValueOnce({
        data: null,
        error: new Error("OAuth not configured"),
      })

      const handler = createExpoOAuthHandler(supabase, mockLinking)
      await expect(handler.signInWithProvider("google")).rejects.toThrow(
        "OAuth not configured",
      )
    })
  })

  describe("handleRedirect", () => {
    it("exchanges code for session in PKCE flow", async () => {
      const handler = createExpoOAuthHandler(supabase, mockLinking)
      await handler.handleRedirect("myapp://auth/callback?code=abc123")

      expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith(
        "abc123",
      )
    })

    it("sets session for implicit flow", async () => {
      const handler = createExpoOAuthHandler(supabase, mockLinking)
      await handler.handleRedirect(
        "myapp://auth/callback?access_token=at123&refresh_token=rt456",
      )

      expect(supabase.auth.setSession).toHaveBeenCalledWith({
        access_token: "at123",
        refresh_token: "rt456",
      })
    })

    it("throws on error response", async () => {
      const handler = createExpoOAuthHandler(supabase, mockLinking)
      await expect(
        handler.handleRedirect(
          "myapp://auth/callback?error=access_denied&error_description=User+denied",
        ),
      ).rejects.toThrow("OAuth error: User denied")
    })

    it("throws on code exchange failure", async () => {
      supabase.auth.exchangeCodeForSession.mockResolvedValueOnce({
        data: null,
        error: new Error("Invalid code"),
      })

      const handler = createExpoOAuthHandler(supabase, mockLinking)
      await expect(
        handler.handleRedirect("myapp://auth/callback?code=bad"),
      ).rejects.toThrow("Invalid code")
    })
  })
})
