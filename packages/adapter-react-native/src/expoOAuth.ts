import type { SupabaseClient } from "@supabase/supabase-js"

export interface ExpoOAuthHandler {
  /** Get the configured redirect URL */
  getRedirectUrl: () => string

  /** Handle the redirect URL after OAuth callback */
  handleRedirect: (url: string) => Promise<void>

  /** Initiate OAuth sign-in with the given provider */
  signInWithProvider: (provider: string) => Promise<{ url: string | null }>
}

export interface ExpoOAuthOptions {
  /** Path for the auth callback (default: "auth/callback") */
  redirectPath?: string

  /** Custom URL scheme for deep links (e.g., "myapp") */
  redirectScheme?: string
}

interface LinkingModule {
  createURL: (path: string) => string
  parse: (url: string) => { queryParams?: { [key: string]: string | undefined } }
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
    getRedirectUrl() {
      return redirectUrl
    },

    async handleRedirect(url: string) {
      // Parse the URL to extract auth parameters
      const parsed = Linking.parse(url)
      const parameters = parsed.queryParams ?? {}

      // Handle PKCE flow (code exchange). `sb_flow_id` (present only when the
      // client set `appendPkceFlowIdToRedirects: true`) is forwarded so
      // overlapping flows don't fight over the same verifier slot -- this is
      // the one place that matters most, since `window.location` doesn't
      // exist here for supabase-js to read it automatically.
      if (parameters.code) {
        const { error } = await supabase.auth.exchangeCodeForSession(
          parameters.code,
          parameters.sb_flow_id ? { flowId: parameters.sb_flow_id } : undefined,
        )

        if (error) {throw error}

        return
      }

      // Handle implicit flow (access_token in hash/fragment)
      if (parameters.access_token && parameters.refresh_token) {
        const { error } = await supabase.auth.setSession({
          access_token: parameters.access_token,
          refresh_token: parameters.refresh_token,
        })

        if (error) {throw error}

        return
      }

      // Handle error response
      if (parameters.error) {
        throw new Error(
          `OAuth error: ${parameters.error_description ?? parameters.error}`,
        )
      }

      throw new Error(
        "OAuth redirect did not contain code, access_token, or error parameters",
      )
    },

    async signInWithProvider(provider: string) {
      const { data, error } = await supabase.auth.signInWithOAuth({
        options: { redirectTo: redirectUrl },
        provider: provider as any,
      })

      if (error) {throw error}

      return { url: data.url ?? null }
    },
  }
}
