// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react"
import type { SupabaseClient } from "@supabase/supabase-js"
import { describe, expect, it, vi } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { createAuthStore } from "../auth/authStore.js"
import { useAuthCallback } from "./useAuthCallback.js"

const RECOVERY_A = "https://app.test/callback#access_token=tok-a&refresh_token=ref-a&type=recovery"
const RECOVERY_B = "https://app.test/callback#access_token=tok-b&refresh_token=ref-b&type=recovery"
const NO_AUTH_PARAMS = "https://app.test/settings"
const ERROR_URL = "https://app.test/callback#error=access_denied&error_description=link+expired"

type SetSessionArgs = { access_token: string; refresh_token: string }

function makeSupabase(gate?: Promise<void>) {
  const supabase = createMockSupabase()

  let gated = gate

  const setSession = vi.fn(async ({ access_token }: SetSessionArgs) => {
    const wait = gated

    gated = undefined

    if (wait) {await wait}

    return {
      data: { session: { access_token, user: { email: `${access_token}@example.com`, id: access_token } } },
      error: null,
    }
  })

  Object.assign(supabase.auth, { setSession })

  return { setSession, supabase: supabase as unknown as SupabaseClient }
}

function flush() {
  return act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

describe("useAuthCallback", () => {
  it("processes the first auth URL: session set, onSuccess, route redirect", async () => {
    const { supabase } = makeSupabase()
    const store = createAuthStore({ supabase })
    const onSuccess = vi.fn()
    const redirect = vi.fn()

    render(
      <Harness
        supabase={supabase}
        store={store}
        url={RECOVERY_A}
        onSuccess={onSuccess}
        redirect={redirect}
      />,
    )

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(onSuccess.mock.calls[0]?.[0].session.access_token).toBe("tok-a")
    expect(store.getState().session?.access_token).toBe("tok-a")
    expect(redirect).toHaveBeenCalledWith("/home")
  })

  it("processes a distinct second auth URL once after the first", async () => {
    const { supabase, setSession } = makeSupabase()
    const store = createAuthStore({ supabase })
    const onSuccess = vi.fn()

    const { rerender } = render(
      <Harness supabase={supabase} store={store} url={RECOVERY_A} onSuccess={onSuccess} />,
    )

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))

    rerender(<Harness supabase={supabase} store={store} url={RECOVERY_B} onSuccess={onSuccess} />)

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(2))
    expect(onSuccess.mock.calls[1]?.[0].session.access_token).toBe("tok-b")
    expect(store.getState().session?.access_token).toBe("tok-b")
    expect(setSession).toHaveBeenCalledTimes(2)
  })

  it("does not run the callback again when re-rendered with the same URL", async () => {
    const { supabase, setSession } = makeSupabase()
    const store = createAuthStore({ supabase })
    const onSuccess = vi.fn()

    const { rerender } = render(
      <Harness supabase={supabase} store={store} url={RECOVERY_A} onSuccess={onSuccess} />,
    )

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))

    rerender(<Harness supabase={supabase} store={store} url={RECOVERY_A} onSuccess={onSuccess} />)
    await flush()

    expect(setSession).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it("does not let a URL with no auth params use up the slot", async () => {
    const { supabase } = makeSupabase()
    const store = createAuthStore({ supabase })
    const onSuccess = vi.fn()

    const { rerender } = render(
      <Harness supabase={supabase} store={store} url={NO_AUTH_PARAMS} onSuccess={onSuccess} />,
    )

    await flush()
    expect(onSuccess).not.toHaveBeenCalled()

    rerender(<Harness supabase={supabase} store={store} url={RECOVERY_A} onSuccess={onSuccess} />)

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(onSuccess.mock.calls[0]?.[0].session.access_token).toBe("tok-a")
  })

  it("reports an error carried by a later auth URL through onError", async () => {
    const { supabase } = makeSupabase()
    const store = createAuthStore({ supabase })
    const onSuccess = vi.fn()
    const onError = vi.fn()

    const { rerender } = render(
      <Harness supabase={supabase} store={store} url={RECOVERY_A} onSuccess={onSuccess} onError={onError} />,
    )

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))

    rerender(
      <Harness supabase={supabase} store={store} url={ERROR_URL} onSuccess={onSuccess} onError={onError} />,
    )

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError.mock.calls[0]?.[0].message).toBe("link expired")
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it("drops the result of a superseded in-flight URL", async () => {
    let releaseA: () => void = () => {}

    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const { supabase } = makeSupabase(gateA)
    const store = createAuthStore({ supabase })
    const onSuccess = vi.fn()

    const { rerender } = render(
      <Harness supabase={supabase} store={store} url={RECOVERY_A} onSuccess={onSuccess} />,
    )

    rerender(<Harness supabase={supabase} store={store} url={RECOVERY_B} onSuccess={onSuccess} />)
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(onSuccess.mock.calls[0]?.[0].session.access_token).toBe("tok-b")

    releaseA()
    await flush()

    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(store.getState().session?.access_token).toBe("tok-b")
  })

  it("waits while getUrl returns nothing, then processes the URL that arrives", async () => {
    const { supabase } = makeSupabase()
    const store = createAuthStore({ supabase })
    const onSuccess = vi.fn()

    const { rerender } = render(
      <Harness supabase={supabase} store={store} url={null} onSuccess={onSuccess} />,
    )

    await flush()
    expect(onSuccess).not.toHaveBeenCalled()

    rerender(<Harness supabase={supabase} store={store} url={RECOVERY_A} onSuccess={onSuccess} />)

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
  })
})

function Harness({
  supabase,
  store,
  url,
  onSuccess,
  onError,
  redirect,
}: {
  onError?: (error: Error) => void
  onSuccess: (result: { session: { access_token: string } }) => void
  redirect?: (path: string) => void
  store: ReturnType<typeof createAuthStore>
  supabase: SupabaseClient
  url: string | null
}) {
  const { error } = useAuthCallback(supabase, store, {
    getUrl: () => url,
    onError,
    onSuccess,
    redirect: redirect ?? (() => {}),
    routes: { default: "/home" },
  })

  return <span data-testid="error">{error?.message ?? "none"}</span>
}
