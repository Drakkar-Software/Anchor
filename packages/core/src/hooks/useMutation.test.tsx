// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { createMockSupabase } from "../__tests__/mockSupabase.js"
import { createTableStore } from "../createTableStore.js"
import { eq } from "../query/filters.js"
import { useMutation } from "./useMutation.js"

type Todo = {
  completed: boolean
  id: number
  title: string
}

function createStore() {
  const supabase = createMockSupabase({
    todos: [
      { completed: false, id: 1, title: "Buy milk" },
      { completed: true, id: 2, title: "Walk dog" },
    ],
  })

  return createTableStore<any, Todo, Partial<Todo>, Partial<Todo>>({
    supabase,
    table: "todos",
  })
}

describe("useMutation", () => {
  it("reports isLoading while a write is in flight and clears it once it settles", async () => {
    const store = createStore()
    const realInsert = store.getState().insert

    let release!: () => void

    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    store.setState({
      insert: async (row: Partial<Todo>) => {
        await gate

        return await realInsert(row)
      },
    } as any)

    const { result } = renderHook(() => useMutation(store))

    expect(result.current.isLoading).toBe(false)

    let pending!: Promise<unknown>

    act(() => {
      pending = result.current.insert({ completed: false, title: "Read book" })
    })

    await waitFor(() => expect(result.current.isLoading).toBe(true))

    await act(async () => {
      release()
      await pending
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("sets error and rejects the promise when the store write fails", async () => {
    const store = createStore()
    const failure = new Error("store write failed")

    store.setState({
      insert: async () => {
        throw failure
      },
    } as any)

    const { result } = renderHook(() => useMutation(store))

    let caught: unknown

    await act(async () => {
      try {
        await result.current.insert({ completed: false, title: "Broken" })
      } catch (error: unknown) {
        caught = error
      }
    })

    expect(caught).toBe(failure)
    expect(result.current.error).toBe(failure)
    expect(result.current.isLoading).toBe(false)
  })

  it("wraps a non-Error rejection so error is always an Error", async () => {
    const store = createStore()
    const nonError: unknown = "plain string failure"

    store.setState({
      insert: async () => {
        throw nonError
      },
    } as any)

    const { result } = renderHook(() => useMutation(store))

    let caught: unknown

    await act(async () => {
      try {
        await result.current.insert({ completed: false, title: "Broken" })
      } catch (error: unknown) {
        caught = error
      }
    })

    expect(caught).toBeInstanceOf(Error)
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe("plain string failure")
  })

  it("clears the error once the next write succeeds", async () => {
    const store = createStore()
    const realInsert = store.getState().insert

    let shouldFail = true

    store.setState({
      insert: async (row: Partial<Todo>) => {
        if (shouldFail) {
          shouldFail = false

          throw new Error("transient failure")
        }

        return await realInsert(row)
      },
    } as any)

    const { result } = renderHook(() => useMutation(store))

    await act(async () => {
      await result.current.insert({ completed: false, title: "First" }).catch(() => undefined)
    })
    expect(result.current.error?.message).toBe("transient failure")

    let inserted: { title?: string } | undefined

    await act(async () => {
      inserted = await result.current.insert({ completed: false, title: "Second" })
    })

    expect(inserted?.title).toBe("Second")
    expect(result.current.error).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it("routes each mutator to the matching store method", async () => {
    const store = createStore()
    const original = store.getState()

    const spies = {
      insert: vi.fn(original.insert),
      insertMany: vi.fn(original.insertMany),
      remove: vi.fn(original.remove),
      removeWhere: vi.fn(original.removeWhere),
      update: vi.fn(original.update),
      upsert: vi.fn(original.upsert),
    }

    store.setState(spies as any)

    const { result } = renderHook(() => useMutation(store))

    await act(async () => {
      await result.current.insert({ completed: false, title: "Inserted" })
      await result.current.insertMany([{ completed: false, title: "Batch" }])
      await result.current.update(1, { completed: true })
      await result.current.upsert({ completed: false, id: 3, title: "Upserted" })
      await result.current.remove(3)
      await result.current.removeWhere([eq<Todo, "completed">("completed", true)])
    })

    expect(spies.insert).toHaveBeenCalledTimes(1)
    expect(spies.insert.mock.calls[0]?.[0]).toEqual({ completed: false, title: "Inserted" })

    expect(spies.insertMany).toHaveBeenCalledTimes(1)
    expect(spies.insertMany.mock.calls[0]?.[0]).toEqual([{ completed: false, title: "Batch" }])

    expect(spies.update).toHaveBeenCalledTimes(1)
    expect(spies.update.mock.calls[0]?.slice(0, 2)).toEqual([1, { completed: true }])

    expect(spies.upsert).toHaveBeenCalledTimes(1)
    expect(spies.upsert.mock.calls[0]?.[0]).toEqual({ completed: false, id: 3, title: "Upserted" })

    expect(spies.remove).toHaveBeenCalledTimes(1)
    expect(spies.remove.mock.calls[0]?.[0]).toBe(3)

    expect(spies.removeWhere).toHaveBeenCalledTimes(1)
    expect(spies.removeWhere.mock.calls[0]?.[0]).toEqual([eq<Todo, "completed">("completed", true)])
  })
})
