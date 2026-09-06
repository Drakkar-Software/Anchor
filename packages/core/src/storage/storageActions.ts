import type { SupabaseClient } from "@supabase/supabase-js"

import { fromSupabaseError } from "../errors.js"
import { type RetryOptions,withRetry } from "../utils/retry.js"

export type ListOptions = {
  limit?: number
  offset?: number
  search?: string
  sortBy?: { column: string; order: "asc" | "desc" }
}

export type SignedUrlOptions = {
  download?: boolean | string
  expiresIn: number
}

export type StorageResult<T> = {
  data: T | null
  error: Error | null
}

export type UploadOptions = {
  cacheControl?: string
  contentType?: string

  /** Retry configuration for transient failures */
  retry?: RetryOptions
  upsert?: boolean
}

/**
 * Create a signed URL for private file access.
 */
export async function createSignedUrl(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  options: SignedUrlOptions,
): Promise<StorageResult<{ signedUrl: string }>> {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, options.expiresIn, {
        download: options.download,
      })

    if (error) {return { data: null, error: fromSupabaseError(error) }}

    return { data: { signedUrl: data.signedUrl }, error: null }
  } catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/**
 * Creates a typed storage helper bound to a specific bucket.
 */
export function createStorageActions(supabase: SupabaseClient, bucket: string) {
  return {
    createSignedUrl: async (path: string, options: SignedUrlOptions) =>
      await createSignedUrl(supabase, bucket, path, options),

    download: async (path: string) => await downloadFile(supabase, bucket, path),
    getPublicUrl: (path: string) => getPublicUrl(supabase, bucket, path),

    list: async (path?: string, options?: ListOptions) =>
      await listFiles(supabase, bucket, path, options),

    remove: async (paths: string[]) => await removeFiles(supabase, bucket, paths),

    upload: async (path: string, file: File | Blob | ArrayBuffer | string, options?: UploadOptions) =>
      await uploadFile(supabase, bucket, path, file, options),
  }
}

/**
 * Download a file from Supabase Storage.
 */
export async function downloadFile(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
): Promise<StorageResult<Blob>> {
  try {
    const { data, error } = await supabase.storage.from(bucket).download(path)

    if (error) {return { data: null, error: fromSupabaseError(error) }}

    return { data, error: null }
  } catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/**
 * Get the public URL for a file.
 *
 * Synchronous and infallible, which is why it alone among the six returns a
 * bare string rather than `{data, error}`: storage-js builds the URL from the
 * project URL, the bucket and the path — it makes no request, and its own
 * signature has no error channel.
 *
 * It used to throw when `data.publicUrl` came back empty. Nothing can produce
 * that, so the guard was error handling for an impossible scenario — but it was
 * a real hazard anyway, because `hooks/useStorage.ts`'s `getUrl` does not catch,
 * so any throw here escaped into render or an event handler. A caller passing a
 * bucket that does not exist still gets a URL; it 404s when something fetches
 * it, which is what the real API does too.
 */
export function getPublicUrl(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
): string {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path)

  return data.publicUrl
}

/**
 * List files in a bucket/folder.
 */
export async function listFiles(
  supabase: SupabaseClient,
  bucket: string,
  path?: string,
  options?: ListOptions,
): Promise<StorageResult<{ id: string | null; metadata: Record<string, unknown> | null; name: string; }[]>> {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(path, {
        limit: options?.limit,
        offset: options?.offset,
        search: options?.search,
        sortBy: options?.sortBy,
      })

    if (error) {return { data: null, error: fromSupabaseError(error) }}

    return {
      data: (data ?? []).map((f) => ({
        id: f.id ?? null,
        metadata: (f.metadata as Record<string, unknown>) ?? null,
        name: f.name,
      })),

      error: null,
    }
  } catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/**
 * Remove files from a bucket.
 */
export async function removeFiles(
  supabase: SupabaseClient,
  bucket: string,
  paths: string[],
): Promise<StorageResult<void>> {
  try {
    const { error } = await supabase.storage.from(bucket).remove(paths)

    if (error) {return { data: null, error: fromSupabaseError(error) }}

    return { data: undefined as unknown as void, error: null }
  } catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/**
 * Upload a file to Supabase Storage.
 */
export async function uploadFile(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  file: File | Blob | ArrayBuffer | string,
  options?: UploadOptions,
): Promise<StorageResult<{ path: string }>> {
  const execute = async (): Promise<StorageResult<{ path: string }>> => {
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(path, file, {
        cacheControl: options?.cacheControl,
        contentType: options?.contentType,
        upsert: options?.upsert,
      })

    if (error) {throw fromSupabaseError(error)}

    return { data: { path: data.path }, error: null }
  }

  try {
    if (options?.retry) {
      return await withRetry(execute, options.retry)
    }

    return await execute()
  } catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}
