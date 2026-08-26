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
import { syncPlaidItem } from '../_shared/transactionSync.ts'

interface ImportRequest {
  publicToken: string
}

function isImportRequest(value: unknown): value is ImportRequest {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { publicToken } = value as Record<string, unknown>
  return typeof publicToken === 'string' && publicToken.trim().length > 0
}

async function readImportRequest(request: Request): Promise<ImportRequest> {
  let body: unknown

  try {
    body = await request.json()
  } catch {
    throw new HttpError(400, 'The request body must be valid JSON.')
  }

  if (!isImportRequest(body)) {
    throw new HttpError(400, 'A Plaid public token is required.')
  }

  return {
    publicToken: body.publicToken.trim(),
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

  let accessToken: string | null = null
  let plaidItemId: string | null = null
  let persistedItemId: string | null = null

  try {
    const user = await getAuthenticatedUser(request)
    const { publicToken } = await readImportRequest(request)
    const plaid = getPlaidClient()
    const exchange = await plaid.itemPublicTokenExchange({
      public_token: publicToken,
    })
    accessToken = exchange.data.access_token
    plaidItemId = exchange.data.item_id
    const item = await plaid.itemGet({
      access_token: accessToken,
    })
    const { data: localItemId, error: createItemError } =
      await getServiceRoleClient().rpc('create_plaid_item', {
        p_user_id: user.id,
        p_plaid_item_id: plaidItemId,
        p_access_token: accessToken,
        p_institution_id: item.data.item.institution_id ?? '',
        p_institution_name: item.data.item.institution_name ?? '',
      })

    if (createItemError || typeof localItemId !== 'string') {
      throw new Error('The connected bank could not be stored securely.')
    }

    persistedItemId = localItemId

    try {
      const result = await syncPlaidItem(localItemId)

      return jsonResponse(request, 200, {
        itemId: localItemId,
        importedCount: result.importedCount,
        isSyncing: true,
      })
    } catch (error) {
      logExternalServiceError('Initial Plaid transaction sync failed.', error)
      return jsonResponse(request, 200, {
        itemId: localItemId,
        importedCount: 0,
        isSyncing: true,
      })
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(request, error.status, { error: error.message })
    }

    if (accessToken && !persistedItemId) {
      let storedItemExists = false

      if (plaidItemId) {
        const { data } = await getServiceRoleClient()
          .from('plaid_items')
          .select('id')
          .eq('plaid_item_id', plaidItemId)
          .maybeSingle()

        storedItemExists = Boolean(data)
      }

      if (!storedItemExists) {
        try {
          await getPlaidClient().itemRemove({
            access_token: accessToken,
          })
        } catch (cleanupError) {
          logExternalServiceError(
            'Plaid Item cleanup after failed creation failed.',
            cleanupError,
          )
        }
      }
    }

    logExternalServiceError('Plaid Item creation failed.', error)
    return jsonResponse(request, 500, {
      error: 'We could not connect this bank. Please try again.',
    })
  }
})
