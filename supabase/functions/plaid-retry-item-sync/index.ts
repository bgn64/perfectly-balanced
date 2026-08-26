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
import { syncPlaidItem } from '../_shared/transactionSync.ts'

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
      throw new HttpError(400, 'A bank connection is required.')
    }

    const { data: item, error: itemError } = await getServiceRoleClient()
      .from('plaid_items')
      .select('id')
      .eq('id', body.itemId)
      .eq('user_id', user.id)
      .neq('status', 'disconnected')
      .maybeSingle()

    if (itemError || !item) {
      throw new HttpError(404, 'The active bank connection was not found.')
    }

    const result = await syncPlaidItem(item.id)

    return jsonResponse(request, 200, {
      importedCount: result.importedCount,
      isSyncing: !result.claimed,
    })
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(request, error.status, { error: error.message })
    }

    logExternalServiceError('Plaid transaction sync retry failed.', error)
    return jsonResponse(request, 500, {
      error: 'We could not check for available transactions. Please try again.',
    })
  }
})
