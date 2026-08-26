import { Products } from 'npm:plaid@46.0.0'
import { getPlaidClient, getPlaidConfiguration } from '../_shared/plaid.ts'
import { HttpError, handleCors, jsonResponse } from '../_shared/http.ts'
import { getAuthenticatedUser } from '../_shared/supabase.ts'

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
    const response = await getPlaidClient(configuration).linkTokenCreate({
      client_name: configuration.clientName,
      country_codes: configuration.countryCodes,
      language: 'en',
      products: [Products.Transactions],
      redirect_uri: configuration.redirectUri,
      transactions: {
        days_requested: 30,
      },
      user: {
        client_user_id: user.id,
      },
    })

    return jsonResponse(request, 200, {
      linkToken: response.data.link_token,
    })
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(request, error.status, { error: error.message })
    }

    console.error('Plaid Link token creation failed.')
    return jsonResponse(request, 500, {
      error: 'We could not start the bank connection. Please try again.',
    })
  }
})
