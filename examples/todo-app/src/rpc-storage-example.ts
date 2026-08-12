/**
 * Example: RPC, Storage, Edge Functions, and utility features.
 *
 * Demonstrates standalone features that don't require React components:
 * - RPC with retry and caching
 * - Edge Functions
 * - Storage operations
 * - Incremental & selective sync
 * - Cache TTL / stale-while-revalidate
 * - Circuit breaker & rate limiter
 * - Client-side aggregation
 * - Data encryption at rest
 * - Schema versioning
 * - Sync health metrics
 */
import { createClient } from "@supabase/supabase-js"
import {
  createSchemaRpc,
  createEdgeFunctionAction,
  createStorageActions,
  incrementalSync,
  fetchWithSwr,
  setupAutoRevalidation,
  withRetry,
  CircuitBreaker,
  RateLimiter,
  aggregateLocal,
  SyncMetrics,
} from "@drakkar.software/anchor"
import { selectiveSync } from "@drakkar.software/anchor/sync/selective"
import { EncryptedAdapter, createWebCryptoEncryption } from "@drakkar.software/anchor/persistence/encrypted"
import { checkSchemaVersion } from "@drakkar.software/anchor/persistence/schemaVersion"
import { LocalStorageAdapter } from "@drakkar.software/anchor-adapter-web"
import { stores, syncMetrics } from "./stores"
import { eq } from "@drakkar.software/anchor"
import type { Database } from "./database.types"

// Typed client, so `createSchemaRpc` below can read the function names, their
// arguments and their return types out of the generated Database.
const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)

// ─── RPC: Call Postgres Functions ────────────────────────────────────

const rpc = createSchemaRpc<Database>(supabase)

async function showDashboard() {
  // withRetry wraps any async call with exponential backoff + jitter.
  // No type argument and no hand-written args type: the name is checked against
  // the schema, `{ user_id }` is required because the function declares it, and
  // `data` comes back as the function's own return type.
  const { data, error } = await withRetry(
    () => rpc("get_dashboard_stats", { user_id: "123" }),
    { maxRetries: 3, baseDelay: 1000 },
  )
  if (error) {
    console.error("RPC error:", error.message)
    return
  }
  console.log("Dashboard:", data?.completed_todos, "of", data?.total_todos)

  // A function the generator wrote as `Args: never` takes no argument object.
  const { data: isAdmin } = await rpc("current_user_is_admin")
  console.log("Admin:", isAdmin)
}

// ─── Edge Functions ──────────────────────────────────────────────────

type EmailResult = { success: boolean; messageId: string }

const sendNotification = createEdgeFunctionAction<EmailResult>(
  supabase,
  "send-notification",
)

async function notifyUser() {
  const { data, error } = await sendNotification({
    body: {
      to: "user@example.com",
      subject: "Todo completed!",
      body: "Your todo has been completed.",
    },
    method: "POST",
  })

  if (error) {
    console.error("Edge function error:", error.message)
    return
  }
  console.log("Notification sent:", data?.messageId)
}

// ─── Storage: File Uploads ───────────────────────────────────────────

const avatars = createStorageActions(supabase, "avatars")

async function uploadAvatar(userId: string, file: File) {
  const path = `${userId}/${file.name}`

  const result = await avatars.upload(path, file, {
    cacheControl: "3600",
    upsert: true,
  })

  if (result.error) {
    console.error("Upload error:", result.error.message)
    return null
  }

  const url = avatars.getPublicUrl(path)
  console.log("Avatar URL:", url)
  return url
}

async function listUserAvatars(userId: string) {
  const result = await avatars.list(userId)
  if (result.error) {
    console.error("List error:", result.error.message)
    return []
  }
  return result.data
}

// ─── Incremental Sync ────────────────────────────────────────────────

async function syncTodos() {
  const { fetchedCount, mergedCount } = await incrementalSync(
    supabase,
    "todos",
    "id",
    stores.todos,
    { timestampColumn: "updated_at" },
  )
  console.log(`Synced: ${fetchedCount} fetched, ${mergedCount} merged`)
}

// ─── Selective Sync ──────────────────────────────────────────────────
// Sync only a subset of data (e.g., active todos only)

async function syncActiveTodos() {
  await selectiveSync(supabase, "todos", "id", stores.todos, {
    filters: [eq("status", "active")],
    timestampColumn: "updated_at",
  })
}

// ─── Cache TTL: Stale-While-Revalidate ───────────────────────────────

async function setupCaching() {
  // Serve stale data while refetching in background
  await fetchWithSwr(stores.todos, {
    staleTTL: 5 * 60 * 1000,  // 5 minutes
    cacheTTL: 30 * 60 * 1000, // 30 minutes
  })

  // Auto-revalidate every minute
  const cleanup = setupAutoRevalidation(stores.todos, {
    staleTTL: 5 * 60 * 1000,
    checkInterval: 60 * 1000,
  })

  return cleanup
}

// ─── Circuit Breaker ─────────────────────────────────────────────────
// Protects against cascading failures from repeatedly calling failing endpoints

const apiBreaker = new CircuitBreaker({
  failureThreshold: 5,  // open after 5 failures
  resetTimeout: 30000,  // try again after 30s (half-open)
})

async function fetchWithBreaker(url: string) {
  return apiBreaker.execute(() => fetch(url))
  // After 5 failures: throws immediately without calling fetch
  // After 30s: allows one probe request (half-open state)
}

// ─── Rate Limiter ────────────────────────────────────────────────────
// Token bucket algorithm to throttle requests

const limiter = new RateLimiter({
  maxTokens: 10,   // 10 burst
  refillRate: 2,   // 2 tokens/sec refill
})

async function rateLimitedFetch(url: string) {
  if (limiter.tryConsume()) {
    return fetch(url)
  }
  throw new Error("Rate limited — try again later")
}

// ─── Client-Side Aggregation ─────────────────────────────────────────

function getTodoStats() {
  return aggregateLocal(stores.todos, {
    total: "count",
    avgPriority: { op: "avg", column: "priority" },
    maxPriority: { op: "max", column: "priority" },
  })
}

// ─── Data Encryption at Rest ─────────────────────────────────────────

async function createEncryptedAdapter() {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  )
  return new EncryptedAdapter(
    new LocalStorageAdapter(),
    createWebCryptoEncryption(key),
  )
}

// ─── Schema Versioning ───────────────────────────────────────────────
// Automatically clear stale cache when schema changes

async function ensureSchemaVersion(adapter: any) {
  const { versionChanged } = await checkSchemaVersion(adapter, 2)
  if (versionChanged) {
    console.log("Schema changed — cache cleared, will re-fetch from Supabase")
  }
}

// ─── Sync Health Metrics ─────────────────────────────────────────────

function logSyncHealth() {
  const snap = syncMetrics.getMetrics()
  console.log("Sync health:", {
    fetchLatencyP95: snap.fetchLatencyP95,
    mutationErrorCount: snap.mutationErrorCount,
    conflictCount: snap.conflictCount,
  })
}
