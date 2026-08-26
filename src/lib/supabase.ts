import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { clientConfiguration } from '../config.ts'

const config = clientConfiguration.config

export const supabase: SupabaseClient | null = config
  ? createClient(config.supabaseUrl, config.supabaseAnonKey)
  : null

export function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      clientConfiguration.error ?? 'The Supabase client could not be configured.',
    )
  }

  return supabase
}
