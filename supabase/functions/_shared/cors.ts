function allowedOrigins(): Set<string> {
  const configuredOrigins = Deno.env.get('APP_ALLOWED_ORIGINS') ?? ''

  return new Set(
    configuredOrigins
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
}

export function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')

  return origin !== null && allowedOrigins().has(origin)
}

export function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('origin')
  const headers: HeadersInit = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }

  if (origin !== null && allowedOrigins().has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return headers
}
