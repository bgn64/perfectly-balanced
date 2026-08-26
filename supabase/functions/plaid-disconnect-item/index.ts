import { getPlaidClient } from '../_shared/plaid.ts'
import {
  HttpError,
  handleCors,
  jsonResponse,
  logExternalServiceError,
} from '../_shared/http.ts'
import {
  getAuthenticatedUser,
  getServiceRoleClient,
} from '../_shared/supabase.ts'

interface ItemRequest {
  itemId: string
}

function isItemRequest(value: unknown): value is ItemRequest {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { itemId } = value as Record<string, unknown>
  return typeof itemId === 'string' && itemId.length > 0
}

function plaidErrorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof error.response === 'object' &&
    error.response !== null &&
    'data' in error.response &&
    typeof error.response.data === 'object' &&
    error.response.data !== null &&
    'error_code' in error.response.data &&
    typeof error.response.data.error_code === 'string'
  ) {
    return error.response.data.error_code
  }

  return null
}

async function readItemRequest(request: Request): Promise<ItemRequest> {
  let body: unknown

  try {
    body = await request.json()
  } catch {
    throw new HttpError(400, 'The request body must be valid JSON.')
  }

  if (!isItemRequest(body)) {
    throw new HttpError(400, 'A Plaid connection is required.')
  }

  return {
    itemId: body.itemId,
  }
}

Deno.serve(async (request) => {
  const corsResponse = handleCors(request)

  if (corsResponse) {
    return corsResponse
  }

  if (request.method !== 'POST') {
    return jsonResponse(request, 405, { error: 'Method not allowed.' })
  }

  try {
    const user = await getAuthenticatedUser(request)
    const { itemId } = await readItemRequest(request)
    const service = getServiceRoleClient()
    const { data: tokenRows, error: tokenError } = await service.rpc(
      'get_plaid_item_token_for_user',
      {
        p_item_id: itemId,
        p_user_id: user.id,
      },
    )

    if (
      tokenError ||
      !Array.isArray(tokenRows) ||
      tokenRows.length !== 1 ||
      typeof tokenRows[0]?.access_token !== 'string'
    ) {
      throw new HttpError(404, 'The active bank connection was not found.')
    }

    try {
      await getPlaidClient().itemRemove({
        access_token: tokenRows[0].access_token,
      })
    } catch (error) {
      if (plaidErrorCode(error) !== 'ITEM_NOT_FOUND') {
        throw error
      }
    }

    const { error: disconnectError } = await service.rpc(
      'disconnect_plaid_item',
      {
        p_item_id: itemId,
        p_user_id: user.id,
      },
    )

    if (disconnectError) {
      throw new Error('The bank connection could not be removed securely.')
    }

    return jsonResponse(request, 200, {
      disconnected: true,
    })
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(request, error.status, { error: error.message })
    }

    logExternalServiceError('Plaid Item disconnect failed.', error)
    return jsonResponse(request, 500, {
      error: 'We could not disconnect this bank. Please try again.',
    })
  }
})
