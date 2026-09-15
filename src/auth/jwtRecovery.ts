import type { SupabaseClient } from '@supabase/supabase-js'

type RecoveryAuth = Pick<SupabaseClient['auth'], 'getSession' | 'refreshSession'>

export function createSessionRecovery(auth: RecoveryAuth) {
  let attempt: {
    authorization: string
    userId: string
    token: Promise<string | null>
  } | null = null

  return async (authorization: string): Promise<string | null> => {
    const initial = await auth.getSession()
    const session = initial.data.session
    if (initial.error || !session) return null

    if (attempt?.authorization !== authorization) {
      if (authorization !== `Bearer ${session.access_token}`) return null
      attempt = {
        authorization,
        userId: session.user.id,
        token: auth.refreshSession().then(({ data, error }) =>
          error ? null : data.session?.access_token ?? null,
        ).catch(() => null),
      }
    }
    const currentAttempt = attempt
    const token = await currentAttempt.token
    if (!token) return null
    const current = await auth.getSession()
    return !current.error &&
      current.data.session?.user.id === currentAttempt.userId &&
      current.data.session?.access_token === token ? token : null
  }
}

export function isFutureJwtError(message: unknown): boolean {
  return typeof message === 'string' && /\bJWT issued at future\b/i.test(message)
}

export async function loadSessionWithJwtRecovery(auth: RecoveryAuth) {
  const result = await auth.getSession()
  if (!isFutureJwtError(result.error?.message)) return result
  try {
    const refreshed = await auth.refreshSession()
    if (!refreshed.error && refreshed.data.session) {
      return { data: { session: refreshed.data.session }, error: null }
    }
  } catch {
    return result
  }
  return result
}

export function createJwtRecoveryFetch(
  supabaseUrl: string,
  recoverAccessToken: (rejectedAuthorization: string) => Promise<string | null>,
  fetchRequest: typeof fetch = (...args) => fetch(...args),
): typeof fetch {
  const restUrl = new URL(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/`)

  return async (input, init) => {
    const response = await fetchRequest(input, init)
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url ?? String(input))
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const signal = init?.signal ?? request?.signal
    if (response.status !== 401 || method !== 'GET' ||
        url.origin !== restUrl.origin || !url.pathname.startsWith(restUrl.pathname) ||
        signal?.aborted) {
      return response
    }

    let message: unknown
    try {
      const body = await response.clone().json()
      message = body?.message
    } catch {
      return response
    }
    if (!isFutureJwtError(message)) return response

    const headers = new Headers(init?.headers ?? request?.headers)
    const authorization = headers.get('Authorization')
    if (!authorization) return response

    let token: string | null
    try {
      token = await recoverAccessToken(authorization)
    } catch {
      return response
    }
    if (!token || signal?.aborted) return response
    headers.set('Authorization', `Bearer ${token}`)
    return fetchRequest(input, { ...init, headers })
  }
}