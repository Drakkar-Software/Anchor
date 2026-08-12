/**
 * Example Supabase Database types.
 * In a real project, generate this with: npx supabase gen types typescript
 */
export type Database = {
  public: {
    Tables: {
      todos: {
        Row: {
          id: string
          title: string
          completed: boolean
          priority: number
          created_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          title: string
          completed?: boolean
          priority?: number
          created_at?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          id?: string
          title?: string
          completed?: boolean
          priority?: number
          updated_at?: string
        }
      }
      profiles: {
        Row: {
          id: string
          username: string
          avatar_url: string | null
          created_at: string
        }
        Insert: {
          id?: string
          username: string
          avatar_url?: string | null
        }
        Update: {
          username?: string
          avatar_url?: string | null
        }
      }
    }
    // A generated Database keeps views in their own block, and every column is
    // nullable: Postgres infers no NOT NULL through a view.
    Views: {
      todo_summary: {
        Row: {
          user_id: string | null
          username: string | null
          open_count: number | null
          next_due: string | null
        }
      }
    }
    Functions: {
      get_dashboard_stats: {
        Args: { user_id: string }
        Returns: {
          total_todos: number
          completed_todos: number
          avg_priority: number
        }
      }
      // What the generator writes for a function that takes no arguments.
      current_user_is_admin: { Args: never; Returns: boolean }
    }
    Enums: {}
  }
}
