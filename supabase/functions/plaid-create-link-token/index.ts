import { Products } from 'npm:plaid@46.0.0'
import { getPlaidClient, getPlaidConfiguration } from '../_shared/plaid.ts'
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

interface LinkTokenRequest {
  itemId?: string
}

function isLinkTokenRequest(value: unknown): value is LinkTokenRequest {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { itemId } = value as Record<string, unknown>
  return itemId === undefined || (typeof itemId === 'string' && itemId.length > 0)
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
    const configuration = getPlaidConfiguration()
    const body: unknown = await request.json()

    if (!isLinkTokenRequest(body)) {
      throw new HttpError(400, 'The Link request is invalid.')
    }

    const commonRequest = {
      client_name: configuration.clientName,
      country_codes: configuration.countryCodes,
      language: 'en' as const,
      redirect_uri: configuration.redirectUri,
      user: {
        client_user_id: user.id,
      },
      webhook: configuration.webhookUrl,
    }
    const plaid = getPlaidClient(configuration)
    const response = body.itemId
      ? await createUpdateLinkToken(plaid, commonRequest, body.itemId, user.id)
      : await plaid.linkTokenCreate({
          ...commonRequest,
          products: [Products.Transactions],
          transactions: {
            days_requested: 90,
          },
        })

    return jsonResponse(request, 200, {
      linkToken: response.data.link_token,
      isUpdateMode: Boolean(body.itemId),
    })
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(request, error.status, { error: error.message })
    }

    logExternalServiceError('Plaid Link token creation failed.', error)
    return jsonResponse(request, 500, {
      error: 'We could not start the bank connection. Please try again.',
    })
  }
})

async function createUpdateLinkToken(
  plaid: ReturnType<typeof getPlaidClient>,
  commonRequest: {
    client_name: string
    country_codes: ReturnType<typeof getPlaidConfiguration>['countryCodes']
    language: 'en'
    redirect_uri: string
    user: {
      client_user_id: string
    }
    webhook: string
  },
  itemId: string,
  userId: string,
) {
  const { data, error } = await getServiceRoleClient().rpc(
    'get_plaid_item_token_for_user',
    {
      p_item_id: itemId,
      p_user_id: userId,
    },
  )

  if (
    error ||
    !Array.isArray(data) ||
    data.length !== 1 ||
    typeof data[0]?.access_token !== 'string'
  ) {
    throw new HttpError(404, 'The bank connection that needs repair was not found.')
  }

  return plaid.linkTokenCreate({
    ...commonRequest,
    access_token: data[0].access_token,
  })
}
