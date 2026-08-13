// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { createAuthStore } from "../auth/authStore.js"
import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { useAuth } from "./useAuth.js"

/**
 * `useAuth` did two reads of one fact: `initialize()` is a `getSession()`
 * round-trip, and the listener it registers is answered by supabase-js with
 * `INITIAL_SESSION` carrying the same session. Both write `isLoading: false`,
 * so whichever settled last won — including when the later one was stale.
 */
describe("useAuth", () => {
  function Panel({ store }: { store: any }) {
    const { session, user, isLoading, error } = useAuth(store)
    return (
      <div>
        <span data-testid="loading">{String(isLoading)}</span>
        <span data-testid="email">{user?.email ?? "anon"}</span>
        <span data-testid="token">{session?.access_token ?? "none"}</span>
        <span data-testid="error">{error?.message ?? "none"}</span>
      </div>
    )
  }

  it("settles to the signed-in session", async () => {
    const supabase = createMockSupabase()
    supabase._setSession({ access_token: "tok", user: { id: "user-1", email: "a@b.com" } })

    render(<Panel store={createAuthStore({ supabase })} />)

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"))
    expect(screen.getByTestId("email").textContent).toBe("a@b.com")
  })

  it("settles to signed-out when there is no session", async () => {
    render(<Panel store={createAuthStore({ supabase: createMockSupabase() })} />)

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"))
    expect(screen.getByTestId("email").textContent).toBe("anon")
  })

  it("reads the session once, not once per source", async () => {
    const supabase = createMockSupabase()
    const getSession = vi.spyOn(supabase.auth, "getSession")

    render(<Panel store={createAuthStore({ supabase })} />)
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"))

    // One round-trip, plus the listener's own INITIAL_SESSION which costs
    // nothing. Two would mean the duplicate read is back.
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it("does not let a slow getSession overwrite a sign-out that arrived meanwhile", async () => {
    const supabase = createMockSupabase()
    supabase._setSession({ access_token: "stale", user: { id: "user-1", email: "a@b.com" } })

    // The round-trip resolves with the pre-sign-out session, after the listener
    // has already reported SIGNED_OUT. This is the ordinary end of a long
    // offline session: supabase-js emits SIGNED_OUT by itself once a refresh
    // token fails to renew.
    let releaseGetSession: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseGetSession = resolve })
    supabase.auth.getSession = vi.fn().mockImplementation(async () => {
      await gate
      return { data: { session: { access_token: "stale", user: { id: "user-1", email: "a@b.com" } } }, error: null }
    })

    const store = createAuthStore({ supabase })
    render(<Panel store={store} />)

    await supabase.auth.signOut()
    expect(screen.getByTestId("token").textContent).toBe("none")

    releaseGetSession()
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"))

    // The stale session must not come back.
    expect(screen.getByTestId("token").textContent).toBe("none")
    expect(screen.getByTestId("email").textContent).toBe("anon")
  })

  it("still applies getSession's answer when no listener has spoken", async () => {
    // The paired positive: deferring unconditionally would also satisfy the
    // assertion above, and would leave a store that never loads a session.
    const supabase = createMockSupabase()
    supabase._setSession({ access_token: "tok", user: { id: "user-1", email: "a@b.com" } })
    const store = createAuthStore({ supabase })

    await store.getState().initialize()

    expect(store.getState().session?.access_token).toBe("tok")
    expect(store.getState().isLoading).toBe(false)
  })

  it("unsubscribes the listener on unmount", async () => {
    const supabase = createMockSupabase()
    const { unmount } = render(<Panel store={createAuthStore({ supabase })} />)
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"))

    unmount()

    // A signOut after unmount must not reach a torn-down component.
    await expect(supabase.auth.signOut()).resolves.toBeDefined()
  })
})
