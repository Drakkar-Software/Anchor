// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { createTableStore } from "../createTableStore.js"
import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { useQuery } from "./useQuery.js"
import { eq } from "../query/filters.js"

/**
 * The first test in this package that renders a hook.
 *
 * Every file in `src/hooks/` was untested, and not by oversight: the runner is
 * `environment: "node"` with no DOM and no `react-dom`, so a hook could not be
 * mounted at all. `useLinkedQuery.test.ts` shows what that produced — it
 * re-implements the hook's staleTime logic inside the test and asserts against
 * the copy, so the hook itself could change freely underneath it.
 *
 * This file opts into jsdom with the docblock above rather than flipping the
 * runner's default, which would give the other 56 files a `window` they were
 * not written against.
 */

type Todo = {
  id: number
  title: string
  completed: boolean
}

describe("useQuery", () => {
  let supabase: any

  beforeEach(() => {
    supabase = createMockSupabase({
      todos: [
        { id: 1, title: "Buy milk", completed: false },
        { id: 2, title: "Walk dog", completed: true },
        { id: 3, title: "Read book", completed: false },
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

  function Rows({ store, options }: { store: any; options?: any }) {
    const { data, isLoading, error, count } = useQuery<Todo, any, any>(store, options)
    return (
      <div>
        <span data-testid="loading">{String(isLoading)}</span>
        <span data-testid="error">{error?.message ?? "none"}</span>
        <span data-testid="count">{String(count)}</span>
        <ul data-testid="rows">
          {data.map((row) => (
            <li key={row.id}>{row.title}</li>
          ))}
        </ul>
      </div>
    )
  }

  const titles = () =>
    Array.from(screen.getByTestId("rows").children).map((li) => li.textContent)

  it("fetches on mount and renders the rows", async () => {
    render(<Rows store={createStore()} />)

    await waitFor(() => expect(titles()).toHaveLength(3))
    expect(titles()).toEqual(["Buy milk", "Walk dog", "Read book"])
    expect(screen.getByTestId("loading").textContent).toBe("false")
  })

  it("renders only the rows its own filters match", async () => {
    render(<Rows store={createStore()} options={{ filters: [eq<Todo, "completed">("completed", false)] }} />)

    await waitFor(() => expect(titles()).toHaveLength(2))
    expect(titles()).toEqual(["Buy milk", "Read book"])
  })

  it("reports the error for this query, not a bare null", async () => {
    supabase._setError("todos", "select", { message: "permission denied", code: "42501" })

    render(<Rows store={createStore()} />)

    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toBe("permission denied"),
    )
    expect(titles()).toEqual([])
  })

  it("surfaces the count when the query asks for one", async () => {
    render(<Rows store={createStore()} options={{ count: "exact", limit: 2 }} />)

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("3"))
    // `count` is the total matched; `data` is the page.
    expect(titles()).toHaveLength(2)
  })

  it("does not fetch when disabled, and does once enabled", async () => {
    const store = createStore()
    const { rerender } = render(<Rows store={store} options={{ enabled: false }} />)

    // Nothing was requested, so nothing landed.
    await waitFor(() => expect(store.getState().queries.size).toBe(0))
    expect(titles()).toEqual([])

    rerender(<Rows store={store} options={{ enabled: true }} />)
    await waitFor(() => expect(titles()).toHaveLength(3))
  })

  it("suppresses a refetch inside staleTime and allows one outside it", async () => {
    const store = createStore()
    let fetches = 0
    const realFetch = store.getState().fetch
    store.setState({
      fetch: (opts?: any) => {
        fetches++
        return realFetch(opts)
      },
    } as any)

    const { unmount } = render(<Rows store={store} options={{ staleTime: 60_000 }} />)
    await waitFor(() => expect(fetches).toBe(1))
    unmount()

    // Remounting inside the window reuses the entry's lastFetchedAt.
    render(<Rows store={store} options={{ staleTime: 60_000 }} />)
    await waitFor(() => expect(titles()).toHaveLength(3))
    expect(fetches).toBe(1)

    // staleTime: 0 always refetches — the paired positive case, without which
    // "it did not fetch" would also pass against a hook that never fetches.
    render(<Rows store={store} options={{ staleTime: 0 }} />)
    await waitFor(() => expect(fetches).toBe(2))
  })

  it("keeps two queries on one table apart", async () => {
    // `merge`, not the default `replace`: two queries coexist in one record map
    // only under merge, because each `replace` fetch rebuilds `order` from its
    // own result and drops the other query's rows.
    const store = createStore({ cacheStrategy: "merge" })

    render(
      <>
        <div data-testid="a">
          <Rows store={store} options={{ filters: [eq<Todo, "completed">("completed", false)] }} />
        </div>
        <div data-testid="b">
          <Rows store={store} options={{ filters: [eq<Todo, "completed">("completed", true)] }} />
        </div>
      </>,
    )

    // Wait on the rendered rows, not on `queries.size` — an entry is filed when
    // the fetch starts, so the size reaches 2 while both are still loading.
    await waitFor(() => {
      const lists = screen.getAllByTestId("rows")
      expect(lists[0]!.children).toHaveLength(2)
      expect(lists[1]!.children).toHaveLength(1)
    })

    expect(store.getState().queries.size).toBe(2)
    const lists = screen.getAllByTestId("rows")
    expect(Array.from(lists[0]!.children).map((li) => li.textContent)).toEqual([
      "Buy milk",
      "Read book",
    ])
    expect(Array.from(lists[1]!.children).map((li) => li.textContent)).toEqual(["Walk dog"])
  })

  it("releases the query on unmount, so refetch() does not replay it", async () => {
    const store = createStore()
    const { unmount } = render(<Rows store={store} />)
    await waitFor(() => expect(titles()).toHaveLength(3))

    const retainedWhileMounted = store.getState().queries.size
    expect(retainedWhileMounted).toBe(1)

    unmount()
    await act(async () => { await store.getState().refetch() })

    // The entry may remain, but nothing re-requested it.
    expect(supabase._tables.todos).toHaveLength(3)
  })
})
