import { corsHeaders, isAllowedOrigin } from './cors.ts'

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

export function logExternalServiceError(event: string, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown error'
  const responseData =
    isRecord(error) && isRecord(error.response) && isRecord(error.response.data)
      ? error.response.data
      : null

  console.error(event, {
    message,
    errorCode: responseData ? optionalString(responseData.error_code) : undefined,
    errorType: responseData ? optionalString(responseData.error_type) : undefined,
    requestId: responseData ? optionalString(responseData.request_id) : undefined,
  })
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
