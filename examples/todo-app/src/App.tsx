/**
 * Example: Complete Todo app using anchor.
 *
 * Demonstrates:
 * - useQuery for data fetching with filters and staleTime
 * - useInfiniteQuery for cursor-based infinite scroll
 * - useLinkedQuery for custom queries linked to store mutations
 * - useMutation for CRUD operations
 * - useAuth for authentication
 * - useRealtime for live updates
 * - useSyncStatus / useQueueStatus for sync monitoring
 * - Optimistic updates (isPending helper)
 * - Offline support (queue status)
 * - Cache strategy (merge mode + clearAndFetch)
 * - React Suspense integration
 */
import React, { Suspense, useState } from "react"
import {
  useQuery,
  useMutation,
  useAuth,
  useRealtime,
  useSuspenseQuery,
  useSyncStatus,
  useQueueStatus,
  createTableHook,
  eq,
  query,
  isPending,
} from "@drakkar.software/anchor"
import { useInfiniteQuery, useLinkedQuery } from "@drakkar.software/anchor/hooks"
import { stores, todosStore } from "./stores"

// ─── Auth ────────────────────────────────────────────────────────────

function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, isLoading, signIn, signOut, user } = useAuth(stores.auth)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  if (isLoading) return <div>Loading auth...</div>

  if (!session) {
    return (
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          await signIn({ email, password })
        }}
      >
        <h2>Sign In</h2>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
        />
        <button type="submit">Sign In</button>
      </form>
    )
  }

  return (
    <div>
      <header>
        <span>Signed in as {(user as any)?.email}</span>
        <button onClick={signOut}>Sign Out</button>
      </header>
      {children}
    </div>
  )
}

// ─── Sync Status Bar ────────────────────────────────────────────────

function SyncStatusBar() {
  const { status, pendingCount, isSyncing } = useSyncStatus([
    stores.todos,
    stores.profiles,
  ])
  const { queueSize } = useQueueStatus(stores.todos)

  return (
    <div>
      <span>
        Sync: {status}
        {isSyncing && " (syncing...)"}
      </span>
      {pendingCount > 0 && <span> | {pendingCount} pending</span>}
      {queueSize > 0 && <span> | {queueSize} queued offline</span>}
    </div>
  )
}

// ─── Todo List with useQuery ─────────────────────────────────────────

function TodoList() {
  const [filter, setFilter] = useState<"all" | "active" | "completed">("all")

  // Build filters based on current filter
  const filterDescriptors =
    filter === "active"
      ? [eq<any, "completed">("completed", false)]
      : filter === "completed"
        ? [eq<any, "completed">("completed", true)]
        : []

  // `data` is scoped to THESE filters, and `isLoading`/`error`/`count` belong
  // to this query rather than to the table — so a second component reading
  // `stores.todos` with different filters does not change what renders here.
  // No `deps: [filter]` needed: the filters are part of the query's identity,
  // so changing them refetches on their own.
  const { data, isLoading, error, count, refetch } = useQuery(stores.todos, {
    filters: filterDescriptors,
    count: "exact", // total matching rows, independent of any limit
    staleTime: 5000, // skip refetch if THIS query was fetched within 5s
  })

  const { insert, remove, isLoading: isMutating } = useMutation(stores.todos)
  const { status: realtimeStatus } = useRealtime(stores.todos)
  const [newTitle, setNewTitle] = useState("")

  if (error) return <div>Error: {error.message}</div>

  return (
    <div>
      <h1>Todos</h1>

      {/* Status indicators */}
      <div>
        <span>Realtime: {realtimeStatus}</span>
        {count != null && <span> · {count} matching</span>}
      </div>

      {/* Filter tabs */}
      <div>
        {(["all", "active", "completed"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{ fontWeight: filter === f ? "bold" : "normal" }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Add todo */}
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!newTitle.trim()) return
          await insert({ title: newTitle.trim() })
          setNewTitle("")
        }}
      >
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="What needs to be done?"
          disabled={isMutating}
        />
        <button type="submit" disabled={isMutating}>
          Add
        </button>
      </form>

      {/* Todo list */}
      {isLoading ? (
        <div>Loading...</div>
      ) : (
        <ul>
          {data.map((todo) => (
            <TodoItem key={todo.id} todo={todo} onDelete={remove} />
          ))}
        </ul>
      )}

      {/* Invalidate cache (useful with merge cacheStrategy) */}
      <button onClick={refetch}>Refresh</button>
      <button onClick={() => stores.todos.getState().clearAndFetch()}>
        Clear Cache & Refresh
      </button>
    </div>
  )
}

// ─── Todo Item ───────────────────────────────────────────────────────

const useTodos = createTableHook(todosStore)

function TodoItem({
  todo,
  onDelete,
}: {
  todo: any
  onDelete: (id: string) => Promise<void>
}) {
  const toggleComplete = useTodos((s) => s.toggleComplete)
  const pending = isPending(todo)

  return (
    <li style={{ opacity: pending ? 0.6 : 1 }}>
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={() => toggleComplete(todo.id)}
      />
      <span
        style={{
          textDecoration: todo.completed ? "line-through" : "none",
        }}
      >
        {todo.title}
      </span>
      {pending && <span> (saving...)</span>}
      <button onClick={() => onDelete(todo.id)}>X</button>
    </li>
  )
}

// ─── Infinite Scroll Example ─────────────────────────────────────────

function InfiniteTodoList() {
  const { data, hasNextPage, fetchNextPage, isLoading } = useInfiniteQuery(
    stores.todos,
    {
      cursorColumn: "created_at",
      pageSize: 20,
      sort: [{ column: "created_at", ascending: false }],
    },
  )

  return (
    <div>
      <h2>All Todos (Infinite Scroll)</h2>
      {isLoading ? (
        <div>Loading...</div>
      ) : (
        <>
          <ul>
            {data.map((t) => (
              <li key={t.id}>{t.title}</li>
            ))}
          </ul>
          {hasNextPage && (
            <button onClick={fetchNextPage}>Load more</button>
          )}
        </>
      )}
    </div>
  )
}

// ─── Linked Query Example ────────────────────────────────────────────
// Custom query that auto-refetches when linked stores mutate.
// Useful for joins or complex selects that can't use useQuery directly.

function TodoSummary() {
  const { data, isLoading } = useLinkedQuery(
    async () => {
      const { data } = await stores.todos.getState().fetch()
      if (!data) return { total: 0, completed: 0 }
      return {
        total: data.length,
        completed: data.filter((t: any) => t.completed).length,
      }
    },
    {
      stores: [stores.todos], // refetch when todos store mutates
      deps: [],
    },
  )

  if (isLoading || !data) return null
  return (
    <div>
      {data.completed}/{data.total} completed
    </div>
  )
}

// ─── Suspense Example ────────────────────────────────────────────────

function SuspenseTodoList() {
  const data = useSuspenseQuery(stores.todos)

  return (
    <div>
      <h2>Todos (Suspense)</h2>
      <ul>
        {data.map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
    </div>
  )
}

// ─── Fluent Query Builder Example ────────────────────────────────────

function HighPriorityTodos() {
  const { data } = useQuery(
    stores.todos,
    query<any>()
      .where("completed").eq(false)
      .where("priority").gte(3)
      .orderBy("priority", "desc")
      .limit(5)
      .build(),
  )

  return (
    <div>
      <h2>High Priority</h2>
      <ul>
        {data.map((t) => (
          <li key={t.id}>
            [{t.priority}] {t.title}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── App ─────────────────────────────────────────────────────────────

export default function App() {
  return (
    <AuthGate>
      <SyncStatusBar />
      <TodoList />
      <TodoSummary />
      <HighPriorityTodos />
      <InfiniteTodoList />
      <Suspense fallback={<div>Loading with Suspense...</div>}>
        <SuspenseTodoList />
      </Suspense>
    </AuthGate>
  )
}
