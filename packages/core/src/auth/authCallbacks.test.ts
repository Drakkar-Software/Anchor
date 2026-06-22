import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  parseAuthCallbackUrl,
  hasAuthCallbackParams,
  createSessionFromUrl,
  sendPasswordRecovery,
  verifyRecoveryOTP,
  resolveAuthRedirect,
} from "./authCallbacks.js"

// ─── parseAuthCallbackUrl ─────────────────────────────────────────────────────

describe("parseAuthCallbackUrl", () => {
  it("parses access_token and refresh_token from hash fragment (implicit flow)", () => {
    const url =
      "https://app.example.com/auth-callback#access_token=tok123&refresh_token=ref456&type=recovery&token_type=bearer"
    const result = parseAuthCallbackUrl(url)
    expect(result.accessToken).toBe("tok123")
    expect(result.refreshToken).toBe("ref456")
    expect(result.type).toBe("recovery")
    expect(result.code).toBeNull()
    expect(result.error).toBeNull()
  })

  it("parses code from query params (PKCE flow)", () => {
    const url =
      "https://app.example.com/auth-callback?code=pkce_code_abc&type=signup"
    const result = parseAuthCallbackUrl(url)
    expect(result.code).toBe("pkce_code_abc")
    expect(result.type).toBe("signup")
    expect(result.accessToken).toBeNull()
    expect(result.refreshToken).toBeNull()
    expect(result.error).toBeNull()
  })

  it("parses error and error_description from hash", () => {
    const url =
      "https://app.example.com/auth-callback#error=access_denied&error_description=Link+has+expired"
    const result = parseAuthCallbackUrl(url)
    expect(result.error).toBe("access_denied")
    expect(result.errorDescription).toBe("Link has expired")
    expect(result.accessToken).toBeNull()
  })

  it("parses error from query params", () => {
    const url =
      "https://app.example.com/auth-callback?error=bad_request&error_description=Invalid+token"
    const result = parseAuthCallbackUrl(url)
    expect(result.error).toBe("bad_request")
    expect(result.errorDescription).toBe("Invalid token")
  })

  it("handles root URL with hash (legacy site_url redirect)", () => {
    const url =
      "https://app.example.com/#access_token=tok&refresh_token=ref&type=magiclink"
    const result = parseAuthCallbackUrl(url)
    expect(result.accessToken).toBe("tok")
    expect(result.refreshToken).toBe("ref")
    expect(result.type).toBe("magiclink")
  })

  it("returns all nulls for a URL with no auth params", () => {
    const result = parseAuthCallbackUrl("https://app.example.com/home")
    expect(result.accessToken).toBeNull()
    expect(result.refreshToken).toBeNull()
    expect(result.code).toBeNull()
    expect(result.type).toBeNull()
    expect(result.error).toBeNull()
    expect(result.errorDescription).toBeNull()
  })

  it("handles native deep-link scheme URLs", () => {
    const url =
      "myapp://auth-callback#access_token=nativeTok&refresh_token=nativeRef&type=recovery"
    const result = parseAuthCallbackUrl(url)
    expect(result.accessToken).toBe("nativeTok")
    expect(result.refreshToken).toBe("nativeRef")
    expect(result.type).toBe("recovery")
  })

  it("prefers hash params over query params for type", () => {
    const url =
      "https://app.example.com/auth-callback?type=signup#access_token=tok&refresh_token=ref&type=recovery"
    const result = parseAuthCallbackUrl(url)
    expect(result.type).toBe("recovery") // hash wins
  })
})

// ─── hasAuthCallbackParams ────────────────────────────────────────────────────

describe("hasAuthCallbackParams", () => {
  it("returns true when access_token is present", () => {
    expect(
      hasAuthCallbackParams(
        "https://app.example.com/#access_token=tok&refresh_token=ref",
      ),
    ).toBe(true)
  })

  it("returns true when code is present", () => {
    expect(
      hasAuthCallbackParams("https://app.example.com/auth-callback?code=abc"),
    ).toBe(true)
  })

  it("returns true when error is present", () => {
    expect(
      hasAuthCallbackParams(
        "https://app.example.com/auth-callback#error=access_denied",
      ),
    ).toBe(true)
  })

  it("returns false for a plain URL", () => {
    expect(hasAuthCallbackParams("https://app.example.com/home")).toBe(false)
  })
})

// ─── createSessionFromUrl ─────────────────────────────────────────────────────

function makeSupabase(authOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    auth: {
      setSession: vi.fn().mockResolvedValue({
        data: {
          session: { access_token: "tok", refresh_token: "ref", user: { id: "u1" } },
          user: { id: "u1" },
        },
        error: null,
      }),
      exchangeCodeForSession: vi.fn().mockResolvedValue({
        data: {
          session: { access_token: "tok2", refresh_token: "ref2", user: { id: "u2" } },
          user: { id: "u2" },
        },
        error: null,
      }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
      verifyOtp: vi.fn().mockResolvedValue({
        data: { session: { access_token: "tok3", user: { id: "u3" } } },
        error: null,
      }),
      ...authOverrides,
    },
  } as any
}

describe("createSessionFromUrl", () => {
  it("establishes session via implicit flow (hash tokens)", async () => {
    const supabase = makeSupabase()
    const url =
      "https://app.example.com/auth-callback#access_token=tok&refresh_token=ref&type=recovery"

    const result = await createSessionFromUrl(supabase, url)

    expect(supabase.auth.setSession).toHaveBeenCalledWith({
      access_token: "tok",
      refresh_token: "ref",
    })
    expect(result?.type).toBe("recovery")
    expect(result?.session).toBeDefined()
  })

  it("establishes session via PKCE flow (code param)", async () => {
    const supabase = makeSupabase()
    const url = "https://app.example.com/auth-callback?code=pkce123&type=signup"

    const result = await createSessionFromUrl(supabase, url)

    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith("pkce123")
    expect(result?.type).toBe("signup")
    expect(result?.session).toBeDefined()
  })

  it("defaults type to 'email' when not present", async () => {
    const supabase = makeSupabase()
    const url =
      "https://app.example.com/auth-callback#access_token=tok&refresh_token=ref"

    const result = await createSessionFromUrl(supabase, url)
    expect(result?.type).toBe("email")
  })

  it("returns null when no auth params are present", async () => {
    const supabase = makeSupabase()
    const result = await createSessionFromUrl(supabase, "https://app.example.com/home")
    expect(result).toBeNull()
    expect(supabase.auth.setSession).not.toHaveBeenCalled()
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled()
  })

  it("throws when the URL contains an error", async () => {
    const supabase = makeSupabase()
    const url =
      "https://app.example.com/auth-callback#error=access_denied&error_description=Link+expired"

    await expect(createSessionFromUrl(supabase, url)).rejects.toThrow("Link expired")
  })

  it("throws when setSession returns an error", async () => {
    const supabase = makeSupabase({
      setSession: vi.fn().mockResolvedValue({
        data: { session: null, user: null },
        error: { message: "Invalid token" },
      }),
    })
    const url =
      "https://app.example.com/#access_token=bad&refresh_token=bad&type=recovery"

    await expect(createSessionFromUrl(supabase, url)).rejects.toThrow("Invalid token")
  })

  it("throws when setSession succeeds but session is null", async () => {
    const supabase = makeSupabase({
      setSession: vi.fn().mockResolvedValue({
        data: { session: null, user: null },
        error: null,
      }),
    })
    const url =
      "https://app.example.com/#access_token=tok&refresh_token=ref"

    await expect(createSessionFromUrl(supabase, url)).rejects.toThrow(
      "Session could not be established",
    )
  })

  it("throws when exchangeCodeForSession returns an error", async () => {
    const supabase = makeSupabase({
      exchangeCodeForSession: vi.fn().mockResolvedValue({
        data: { session: null, user: null },
        error: { message: "Code already used" },
      }),
    })
    const url = "https://app.example.com/?code=used_code"

    await expect(createSessionFromUrl(supabase, url)).rejects.toThrow("Code already used")
  })

  it("handles legacy root URL redirect (site_url without /auth-callback)", async () => {
    const supabase = makeSupabase()
    // Supabase redirected to / instead of /auth-callback (old site_url config)
    const url =
      "https://app.example.com/#access_token=tok&refresh_token=ref&type=magiclink"

    const result = await createSessionFromUrl(supabase, url)
    expect(result?.type).toBe("magiclink")
    expect(supabase.auth.setSession).toHaveBeenCalled()
  })
})

// ─── sendPasswordRecovery ─────────────────────────────────────────────────────

describe("sendPasswordRecovery", () => {
  it("calls resetPasswordForEmail with the given email and redirectTo", async () => {
    const supabase = makeSupabase()
    const { error } = await sendPasswordRecovery(supabase, "user@example.com", {
      redirectTo: "https://app.example.com/auth-callback",
    })

    expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      "user@example.com",
      { redirectTo: "https://app.example.com/auth-callback" },
    )
    expect(error).toBeNull()
  })

  it("works without a redirectTo", async () => {
    const supabase = makeSupabase()
    const { error } = await sendPasswordRecovery(supabase, "user@example.com")

    expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      "user@example.com",
      { redirectTo: undefined },
    )
    expect(error).toBeNull()
  })

  it("returns an error when the API call fails", async () => {
    const supabase = makeSupabase({
      resetPasswordForEmail: vi
        .fn()
        .mockResolvedValue({ error: { message: "Email not found" } }),
    })
    const { error } = await sendPasswordRecovery(supabase, "bad@example.com")

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe("Email not found")
  })
})

// ─── verifyRecoveryOTP ────────────────────────────────────────────────────────

describe("verifyRecoveryOTP", () => {
  it("calls verifyOtp with type='recovery'", async () => {
    const supabase = makeSupabase()
    const { session, error } = await verifyRecoveryOTP(supabase, "user@example.com", "123456")

    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({
      email: "user@example.com",
      token: "123456",
      type: "recovery",
    })
    expect(session).toBeDefined()
    expect(error).toBeNull()
  })

  it("returns an error when verification fails", async () => {
    const supabase = makeSupabase({
      verifyOtp: vi
        .fn()
        .mockResolvedValue({ data: { session: null }, error: { message: "OTP expired" } }),
    })
    const { session, error } = await verifyRecoveryOTP(supabase, "user@example.com", "000000")

    expect(session).toBeNull()
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe("OTP expired")
  })
})

// ─── resolveAuthRedirect ──────────────────────────────────────────────────────

describe("resolveAuthRedirect", () => {
  it("returns the type-specific route for recovery", () => {
    expect(
      resolveAuthRedirect("recovery", { recovery: "/settings/security", default: "/home" }),
    ).toBe("/settings/security")
  })

  it("falls back to default when type has no explicit entry", () => {
    expect(
      resolveAuthRedirect("email", { recovery: "/settings/security", default: "/home" }),
    ).toBe("/home")
  })

  it("returns null when type has no entry and no default", () => {
    expect(resolveAuthRedirect("email", { recovery: "/settings/security" })).toBeNull()
  })

  it("returns null when routes is undefined", () => {
    expect(resolveAuthRedirect("recovery", undefined)).toBeNull()
  })

  it("returns null for empty routes map", () => {
    expect(resolveAuthRedirect("recovery", {})).toBeNull()
  })

  it("resolves a custom/unknown type via the index signature", () => {
    expect(
      resolveAuthRedirect("sso", { sso: "/dashboard", default: "/home" }),
    ).toBe("/dashboard")
  })

  it("resolves signup route explicitly", () => {
    expect(
      resolveAuthRedirect("signup", { signup: "/onboarding", default: "/home" }),
    ).toBe("/onboarding")
  })

  it("resolves magiclink to default when no specific entry", () => {
    expect(
      resolveAuthRedirect("magiclink", { recovery: "/settings/security", default: "/home" }),
    ).toBe("/home")
  })
})
