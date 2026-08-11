import type { SupabaseClient } from "@supabase/supabase-js"

export type ExpoOAuthOptions = {
  /** Custom URL scheme for deep links (e.g., "myapp") */
  redirectScheme?: string
  /** Path for the auth callback (default: "auth/callback") */
  redirectPath?: string
}

export type ExpoOAuthHandler = {
  /** Initiate OAuth sign-in with the given provider */
  signInWithProvider(provider: string): Promise<{ url: string | null }>
  /** Handle the redirect URL after OAuth callback */
  handleRedirect(url: string): Promise<void>
  /** Get the configured redirect URL */
  getRedirectUrl(): string
}

type LinkingModule = {
  createURL: (path: string) => string
  parse: (url: string) => { queryParams?: Record<string, string | undefined> }
}

/**
 * Create an OAuth handler for Expo/React Native apps.
 * Uses expo-linking to construct deep link URLs for OAuth callbacks.
 *
 * Pass the expo-linking module to avoid bundler resolution issues in
 * pnpm virtual store environments.
 *
 * @example
 * import * as Linking from 'expo-linking'
 * createExpoOAuthHandler(supabase, Linking)
 */
export function createExpoOAuthHandler(
  supabase: SupabaseClient,
  Linking: LinkingModule,
  options?: ExpoOAuthOptions,
): ExpoOAuthHandler {
  const redirectPath = options?.redirectPath ?? "auth/callback"
  const redirectUrl = options?.redirectScheme
    ? `${options.redirectScheme}://${redirectPath}`
    : Linking.createURL(redirectPath)

  return {
    async signInWithProvider(provider: string) {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: provider as any,
        options: { redirectTo: redirectUrl },
      })

      if (error) throw error
      return { url: data?.url ?? null }
    },

    async handleRedirect(url: string) {
      // Parse the URL to extract auth parameters
      const parsed = Linking.parse(url)
      const params = parsed.queryParams ?? {}

      // Handle PKCE flow (code exchange). `sb_flow_id` (present only when the
      // client set `appendPkceFlowIdToRedirects: true`) is forwarded so
      // overlapping flows don't fight over the same verifier slot -- this is
      // the one place that matters most, since `window.location` doesn't
      // exist here for supabase-js to read it automatically.
      if (params.code) {
        const { error } = await supabase.auth.exchangeCodeForSession(
          params.code as string,
          params.sb_flow_id ? { flowId: params.sb_flow_id as string } : undefined,
        )
        if (error) throw error
        return
      }

      // Handle implicit flow (access_token in hash/fragment)
      if (params.access_token && params.refresh_token) {
        const { error } = await supabase.auth.setSession({
          access_token: params.access_token as string,
          refresh_token: params.refresh_token as string,
        })
        if (error) throw error
        return
      }

      // Handle error response
      if (params.error) {
        throw new Error(
          `OAuth error: ${params.error_description ?? params.error}`,
        )
      }

      throw new Error(
        "OAuth redirect did not contain code, access_token, or error parameters",
      )
    },

    getRedirectUrl() {
      return redirectUrl
    },
  }
}
