// @vitest-environment jsdom
/* eslint-disable react/destructuring-assignment, react/no-multi-comp, react/require-optimization, react/sort-comp */

import { Component, type ReactNode, Suspense } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { createTableStore } from "../createTableStore.js"
import { useSuspenseQuery } from "./useSuspenseQuery.js"

type Todo = {
  completed: boolean
  id: number
  title: string
}

// eslint-disable-next-line react-prefer-function-component/react-prefer-function-component -- class boundaries are the supported test pattern
class TestErrorBoundary extends Component<
  { children: ReactNode; fallback?: (error: Error) => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      const body = this.props.fallback?.(this.state.error) ?? this.state.error.message

      return <span data-testid="boundary-error">{body}</span>
    }

    return this.props.children
  }
}

describe("useSuspenseQuery", () => {
  let supabase: ReturnType<typeof createMockSupabase>

  beforeEach(() => {
    supabase = createMockSupabase({
      todos: [
        { completed: false, id: 1, title: "Buy milk" },
        { completed: true, id: 2, title: "Walk dog" },
        { completed: false, id: 3, title: "Read book" },
      ],
    })
  })

  function createStore(overrides: Record<string, unknown> = {}) {
    return createTableStore<any, Todo, Partial<Todo>, Partial<Todo>>({
      supabase,
      table: "todos",
      ...overrides,
    })
  }

  function SuspenseRows({ options, store }: { options?: Record<string, unknown>; store: ReturnType<typeof createStore> }) {
    const data = useSuspenseQuery<any, any, any>(store, options)

    return (
      <ul data-testid="rows">
        {data.map((row) => (
          <li key={String(row.id)}>{row.title}</li>
        ))}
      </ul>
    )
  }

  function mountSuspenseTree(
    store: ReturnType<typeof createStore>,
    options?: Record<string, unknown>,
  ) {
    return render(
      <TestErrorBoundary>
        <Suspense fallback={<span data-testid="suspense-fallback">loading</span>}>
          <SuspenseRows options={options} store={store} />
        </Suspense>
      </TestErrorBoundary>,
    )
  }

  const titles = () =>
    Array.from(screen.getByTestId("rows").children, (li) => li.textContent)

  it("shows the suspense fallback, then the fetched rows", async () => {
    mountSuspenseTree(createStore())

    // eslint-disable-next-line testing-library/prefer-explicit-assert -- no jest-dom in this package
    expect(screen.getByTestId("suspense-fallback")).toBeTruthy()

    await waitFor(() => expect(titles()).toHaveLength(3))
    expect(titles()).toEqual(["Buy milk", "Walk dog", "Read book"])
    expect(screen.queryByTestId("suspense-fallback")).toBeNull()
  })

  it("surfaces a failed Supabase fetch to the error boundary without refetching in a loop", async () => {
    supabase._setError("todos", "select", { code: "42501", message: "permission denied" })

    const store = createStore()

    let fetches = 0

    const realFetch = store.getState().fetch

    store.setState({
      fetch: async (opts?: unknown) => {
        fetches++

        return await realFetch(opts as Parameters<typeof realFetch>[0])
      },
    } as never)

    const { rerender } = mountSuspenseTree(store)

    await waitFor(() =>
      expect(screen.getByTestId("boundary-error").textContent).toBe("permission denied"),
    )

    rerender(
      <TestErrorBoundary>
        <Suspense fallback={<span data-testid="suspense-fallback">loading</span>}>
          <SuspenseRows store={store} />
        </Suspense>
      </TestErrorBoundary>,
    )

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(fetches).toBe(1)
    expect(screen.getByTestId("boundary-error").textContent).toBe("permission denied")
  })

  it("does not leave a rejecting custom fetch unhandled when the cached promise has catch", async () => {
    const store = createStore()

    store.setState({
      fetch: async () => {
        throw new Error("fetch blew up")
      },
    } as never)

    const pending = store.getState().fetch()

    pending.catch(() => {})

    await expect(pending).rejects.toThrow("fetch blew up")
  })
})
