import { describe, it, expect, vi } from "vitest"
import {
  getSession,
  getUser,
  signUpWithPassword,
  signInWithPassword,
  updateUser,
  resendOtp,
} from "./authActions.js"
import { AnchorError } from "../errors.js"

const SESSION = { access_token: "tok", user: { id: "u1", email: "user@example.com" } }

function makeSupabase(authOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: SESSION }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user: SESSION.user }, error: null }),
      signUp: vi
        .fn()
        .mockResolvedValue({ data: { session: SESSION, user: SESSION.user }, error: null }),
      signInWithPassword: vi
        .fn()
        .mockResolvedValue({ data: { session: SESSION, user: SESSION.user }, error: null }),
      updateUser: vi.fn().mockResolvedValue({ data: { user: SESSION.user }, error: null }),
      resend: vi.fn().mockResolvedValue({ error: null }),
      ...authOverrides,
    },
  } as any
}

describe("getSession", () => {
  it("returns the stored session", async () => {
    const supabase = makeSupabase()
    const { session, error } = await getSession(supabase)

    expect(session).toEqual(SESSION)
    expect(error).toBeNull()
  })

  it("reports a signed-out client as a null session, not an error", async () => {
    const supabase = makeSupabase({
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    })
    const { session, error } = await getSession(supabase)

    expect(session).toBeNull()
    expect(error).toBeNull()
  })

  it("wraps a failure as an AnchorError that keeps its code", async () => {
    const supabase = makeSupabase({
      getSession: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: "bad jwt", code: "PGRST301" } }),
    })
    const { session, error } = await getSession(supabase)

    expect(session).toBeNull()
    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).code).toBe("PGRST301")
  })
})

describe("getUser", () => {
  it("returns the user the auth server confirms", async () => {
    const supabase = makeSupabase()
    const { user, error } = await getUser(supabase)

    expect(user).toEqual(SESSION.user)
    expect(error).toBeNull()
  })

  it("returns null rather than a stale user when the session was revoked", async () => {
    const supabase = makeSupabase({
      getUser: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: "Invalid claim", status: 401 } }),
    })
    const { user, error } = await getUser(supabase)

    expect(user).toBeNull()
    expect((error as AnchorError).status).toBe(401)
  })
})

describe("signUpWithPassword", () => {
  it("forwards the credentials and the options", async () => {
    const supabase = makeSupabase()
    await signUpWithPassword(supabase, {
      email: "user@example.com",
      password: "hunter2",
      options: { emailRedirectTo: "https://app.example.com/auth-callback" },
    })

    expect(supabase.auth.signUp).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "hunter2",
      options: { emailRedirectTo: "https://app.example.com/auth-callback" },
    })
  })

  it("returns a user with no session when the project requires confirmation", async () => {
    // Not an error, and the one success case that legitimately has no session:
    // the account exists and the code is in the inbox.
    const supabase = makeSupabase({
      signUp: vi
        .fn()
        .mockResolvedValue({ data: { session: null, user: SESSION.user }, error: null }),
    })
    const { session, user, error } = await signUpWithPassword(supabase, {
      email: "user@example.com",
      password: "hunter2",
    })

    expect(session).toBeNull()
    expect(user).toEqual(SESSION.user)
    expect(error).toBeNull()
  })

  it("does not report a refusal as a confirmation-pending sign-up", async () => {
    // supabase-js still populates `data` with a null pair on failure, so reading
    // it before `error` makes a rejected sign-up indistinguishable from the case
    // above — which the caller is expected to treat as success.
    const supabase = makeSupabase({
      signUp: vi.fn().mockResolvedValue({
        data: { session: null, user: null },
        error: { message: "User already registered", code: "user_already_exists" },
      }),
    })
    const { session, user, error } = await signUpWithPassword(supabase, {
      email: "user@example.com",
      password: "hunter2",
    })

    expect(session).toBeNull()
    expect(user).toBeNull()
    expect((error as AnchorError).code).toBe("user_already_exists")
  })
})

describe("signInWithPassword", () => {
  it("returns the session and the user", async () => {
    const supabase = makeSupabase()
    const { session, user, error } = await signInWithPassword(supabase, {
      email: "user@example.com",
      password: "hunter2",
    })

    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "hunter2",
    })
    expect(session).toEqual(SESSION)
    expect(user).toEqual(SESSION.user)
    expect(error).toBeNull()
  })

  it("reports a wrong password as an error with its code", async () => {
    const supabase = makeSupabase({
      signInWithPassword: vi.fn().mockResolvedValue({
        data: { session: null, user: null },
        error: { message: "Invalid login credentials", code: "invalid_credentials" },
      }),
    })
    const { session, error } = await signInWithPassword(supabase, {
      email: "user@example.com",
      password: "wrong",
    })

    expect(session).toBeNull()
    expect((error as AnchorError).code).toBe("invalid_credentials")
  })
})

describe("updateUser", () => {
  it("forwards the attributes untouched", async () => {
    const supabase = makeSupabase()
    const { user, error } = await updateUser(supabase, { password: "new-password" })

    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: "new-password" })
    expect(user).toEqual(SESSION.user)
    expect(error).toBeNull()
  })

  it("surfaces the refusal when the new password is rejected", async () => {
    const supabase = makeSupabase({
      updateUser: vi.fn().mockResolvedValue({
        data: { user: null },
        error: { message: "Password should be at least 8 characters", code: "weak_password" },
      }),
    })
    const { user, error } = await updateUser(supabase, { password: "short" })

    expect(user).toBeNull()
    expect((error as AnchorError).code).toBe("weak_password")
  })
})

describe("resendOtp", () => {
  it("forwards a sign-up resend", async () => {
    const supabase = makeSupabase()
    const { error } = await resendOtp(supabase, {
      type: "signup",
      email: "user@example.com",
    })

    expect(supabase.auth.resend).toHaveBeenCalledWith({
      type: "signup",
      email: "user@example.com",
    })
    expect(error).toBeNull()
  })

  it("forwards a phone resend on the phone identifier", async () => {
    const supabase = makeSupabase()
    await resendOtp(supabase, { type: "sms", phone: "+33600000000" })

    expect(supabase.auth.resend).toHaveBeenCalledWith({
      type: "sms",
      phone: "+33600000000",
    })
  })

  it("returns the rate limit as an error rather than throwing", async () => {
    const supabase = makeSupabase({
      resend: vi.fn().mockResolvedValue({
        error: { message: "For security purposes, you can only request this after 43 seconds", status: 429 },
      }),
    })
    const { error } = await resendOtp(supabase, { type: "signup", email: "user@example.com" })

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).status).toBe(429)
  })
})
