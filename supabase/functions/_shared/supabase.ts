import {
  createClient,
  type SupabaseClient,
  type User,
} from 'npm:@supabase/supabase-js@2.112.3'
import { HttpError } from './http.ts'

function requiredEnvironmentValue(name: string): string {
  const value = Deno.env.get(name)?.trim()

  if (!value) {
    throw new Error(`Missing required function environment variable: ${name}.`)
  }

  return value
}

function supabaseUrl(): string {
  return requiredEnvironmentValue('SUPABASE_URL')
}

function supabaseAnonKey(): string {
  return requiredEnvironmentValue('SUPABASE_ANON_KEY')
}

function supabaseServiceRoleKey(): string {
  return requiredEnvironmentValue('SUPABASE_SERVICE_ROLE_KEY')
}

export async function getAuthenticatedUser(request: Request): Promise<User> {
  const authorization = request.headers.get('authorization')

  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Authentication is required.')
  }

  const accessToken = authorization.slice('Bearer '.length)
  const client = createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
  const {
    data: { user },
    error,
  } = await client.auth.getUser(accessToken)

  if (error || !user) {
    throw new HttpError(401, 'Your session is no longer valid. Sign in again.')
  }

  return user
}

export function getServiceRoleClient(): SupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
