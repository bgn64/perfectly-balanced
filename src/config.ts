const requiredEnvironmentVariables = [
  'VITE_APP_NAME',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SITE_URL',
] as const

type RequiredEnvironmentVariable = (typeof requiredEnvironmentVariables)[number]

export interface ClientConfiguration {
  appName: string
  supabaseUrl: string
  supabaseAnonKey: string
  siteUrl: string
}

interface ClientConfigurationResult {
  config: ClientConfiguration | null
  error: string | null
}

function environmentValue(name: RequiredEnvironmentVariable): string {
  const value = import.meta.env[name]
  return typeof value === 'string' ? value.trim() : ''
}

function isSupportedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function loadClientConfiguration(): ClientConfigurationResult {
  const values = Object.fromEntries(
    requiredEnvironmentVariables.map((name) => [name, environmentValue(name)]),
  ) as Record<RequiredEnvironmentVariable, string>
  const missingVariables = requiredEnvironmentVariables.filter(
    (name) => !values[name],
  )

  if (missingVariables.length > 0) {
    return {
      config: null,
      error: `Missing required environment variable${missingVariables.length === 1 ? '' : 's'}: ${missingVariables.join(', ')}.`,
    }
  }

  if (!isSupportedUrl(values.VITE_SUPABASE_URL)) {
    return {
      config: null,
      error: 'VITE_SUPABASE_URL must be an absolute http or https URL.',
    }
  }

  if (!isSupportedUrl(values.VITE_SITE_URL)) {
    return {
      config: null,
      error: 'VITE_SITE_URL must be an absolute http or https URL.',
    }
  }

  return {
    config: {
      appName: values.VITE_APP_NAME,
      supabaseUrl: values.VITE_SUPABASE_URL,
      supabaseAnonKey: values.VITE_SUPABASE_ANON_KEY,
      siteUrl: values.VITE_SITE_URL,
    },
    error: null,
  }
}

export const clientConfiguration = loadClientConfiguration()

export function getClientConfiguration(): ClientConfiguration {
  if (!clientConfiguration.config) {
    throw new Error(
      clientConfiguration.error ?? 'The application environment is invalid.',
    )
  }

  return clientConfiguration.config
}
