"use client"

import type { SupabaseClient } from "@supabase/supabase-js"
import { useCallback,useState } from "react"

import {
  createSignedUrl,
  downloadFile,
  getPublicUrl,
  listFiles,
  type ListOptions,
  removeFiles,
  type SignedUrlOptions,
  uploadFile,
  type UploadOptions,
} from "../storage/storageActions.js"

type UseStorageResult = {
  createSignedUrl: (path: string, options: SignedUrlOptions) => Promise<string | null>
  download: (path: string) => Promise<Blob | null>
  error: Error | null
  getPublicUrl: (path: string) => string
  isLoading: boolean
  list: (path?: string, options?: ListOptions) => Promise<{ name: string }[] | null>
  remove: (paths: string[]) => Promise<boolean>
  upload: (path: string, file: File | Blob | ArrayBuffer | string, options?: UploadOptions) => Promise<{ path: string } | null>
}

/**
 * React hook for Supabase Storage operations on a specific bucket.
 */
export function useStorage(
  supabase: SupabaseClient,
  bucket: string,
): UseStorageResult {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const upload = useCallback(
    async (path: string, file: File | Blob | ArrayBuffer | string, options?: UploadOptions) => {
      setIsLoading(true)
      setError(null)

      try {
        const result = await uploadFile(supabase, bucket, path, file, options)

        setError(result.error)

        return result.data
      } catch (error_) {
        const e = error_ instanceof Error ? error_ : new Error(String(error_))

        setError(e)

        return null
      } finally {
        setIsLoading(false)
      }
    },
    [supabase, bucket],
  )

  const download = useCallback(
    async (path: string) => {
      setIsLoading(true)
      setError(null)

      try {
        const result = await downloadFile(supabase, bucket, path)

        setError(result.error)

        return result.data
      } catch (error_) {
        const e = error_ instanceof Error ? error_ : new Error(String(error_))

        setError(e)

        return null
      } finally {
        setIsLoading(false)
      }
    },
    [supabase, bucket],
  )

  const getUrl = useCallback(
    (path: string) => getPublicUrl(supabase, bucket, path),
    [supabase, bucket],
  )

  const signUrl = useCallback(
    async (path: string, options: SignedUrlOptions) => {
      setIsLoading(true)
      setError(null)

      try {
        const result = await createSignedUrl(supabase, bucket, path, options)

        setError(result.error)

        return result.data?.signedUrl ?? null
      } catch (error_) {
        const e = error_ instanceof Error ? error_ : new Error(String(error_))

        setError(e)

        return null
      } finally {
        setIsLoading(false)
      }
    },
    [supabase, bucket],
  )

  const listAction = useCallback(
    async (path?: string, options?: ListOptions) => {
      setIsLoading(true)
      setError(null)

      try {
        const result = await listFiles(supabase, bucket, path, options)

        setError(result.error)

        return result.data
      } catch (error_) {
        const e = error_ instanceof Error ? error_ : new Error(String(error_))

        setError(e)

        return null
      } finally {
        setIsLoading(false)
      }
    },
    [supabase, bucket],
  )

  const removeAction = useCallback(
    async (paths: string[]) => {
      setIsLoading(true)
      setError(null)

      try {
        const result = await removeFiles(supabase, bucket, paths)

        setError(result.error)

        return !result.error
      } catch (error_) {
        const e = error_ instanceof Error ? error_ : new Error(String(error_))

        setError(e)

        return false
      } finally {
        setIsLoading(false)
      }
    },
    [supabase, bucket],
  )

  return {
    createSignedUrl: signUrl,
    download,
    error,
    getPublicUrl: getUrl,
    isLoading,
    list: listAction,
    remove: removeAction,
    upload,
  }
}
