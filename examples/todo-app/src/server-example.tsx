/**
 * Example: React Server Components with anchor.
 *
 * Shows server-side prefetching and client-side hydration.
 * This pattern works with Next.js App Router.
 */

// ─── Server Component (page.tsx) ─────────────────────────────────────
// This runs on the server. No hooks, no state.

import { createClient } from "@supabase/supabase-js"
import { prefetch } from "@drakkar.software/anchor"
import type { Database } from "./database.types"

type TodoRow = Database["public"]["Tables"]["todos"]["Row"]

// Server-side Supabase client (uses service role or cookies).
// SUPABASE_PUBLISHABLE_KEY: sb_publishable_... (new format) or the legacy anon key
const serverSupabase = createClient<Database>(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_PUBLISHABLE_KEY!,
)

export default async function TodosPage() {
  // Prefetch data on the server — no Zustand store needed
  const { data, error } = await prefetch<TodoRow>(serverSupabase, "todos", {
    sort: [{ column: "created_at", ascending: false }],
    limit: 50,
  })

  if (error) {
    return <div>Error loading todos: {error.message}</div>
  }

  // Pass to client component for interactive features
  return <TodoListClient initialData={data} />
}

// ─── Client Component (TodoListClient.tsx) ───────────────────────────
// This runs on the client. Uses hooks and state.

// "use client" would go at the top of a separate file

function TodoListClient({ initialData }: { initialData: TodoRow[] }) {
  // In a real app, you'd hydrate a Zustand store with initialData:
  //
  // useEffect(() => {
  //   todosStore.getState().mergeRecords(initialData)
  // }, [])
  //
  // Then use useQuery(todosStore) for live updates

  return (
    <div>
      <h1>Todos ({initialData.length})</h1>
      <ul>
        {initialData.map((todo) => (
          <li key={todo.id}>
            <input type="checkbox" checked={todo.completed} readOnly />
            {todo.title}
          </li>
        ))}
      </ul>
    </div>
  )
}
