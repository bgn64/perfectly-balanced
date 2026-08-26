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
    const body: unknown = await request.json()

    if (!isItemRequest(body)) {
      throw new HttpError(400, 'A disconnected bank connection is required.')
    }

    const { error } = await getServiceRoleClient().rpc(
      'delete_disconnected_plaid_history',
      {
        p_item_id: body.itemId,
        p_user_id: user.id,
      },
    )

    if (error) {
      throw new Error('The disconnected bank history could not be deleted.')
    }

    return jsonResponse(request, 200, {
      deleted: true,
    })
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(request, error.status, { error: error.message })
    }

    logExternalServiceError('Disconnected Plaid history deletion failed.', error)
    return jsonResponse(request, 500, {
      error: 'We could not delete this disconnected bank history.',
    })
  }
})
