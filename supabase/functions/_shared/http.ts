import { corsHeaders, isAllowedOrigin } from './cors.ts'

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function jsonResponse(
  request: Request,
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'application/json',
    },
  })
}

export function handleCors(request: Request): Response | null {
  if (!isAllowedOrigin(request)) {
    return jsonResponse(request, 403, {
      error: 'Requests from this origin are not allowed.',
    })
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    })
  }

  return null
}
