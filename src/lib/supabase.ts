import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { clientConfiguration } from '../config.ts'
import { createJwtRecoveryFetch, createSessionRecovery } from '../auth/jwtRecovery.ts'

const config = clientConfiguration.config

function createConfiguredClient(): SupabaseClient | null {
  if (!config) return null
  let recover: (authorization: string) => Promise<string | null> = async () => null
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: {
      fetch: createJwtRecoveryFetch(config.supabaseUrl, (authorization) => recover(authorization)),
    },
  })
  recover = createSessionRecovery(client.auth)
  return client
}

export const supabase = createConfiguredClient()

export function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      clientConfiguration.error ?? 'The Supabase client could not be configured.',
    )
  }

  return supabase
}
