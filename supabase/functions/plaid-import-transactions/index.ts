import { getPlaidClient } from '../_shared/plaid.ts'
import { HttpError, handleCors, jsonResponse } from '../_shared/http.ts'
import {
  getAuthenticatedUser,
  getServiceRoleClient,
} from '../_shared/supabase.ts'

interface ImportRequest {
  publicToken: string
}

interface TransactionRow {
  source_transaction_id: string
  transaction_date: string
  merchant_name: string | null
  amount: number
  currency_code: string | null
  is_pending: boolean
  category: string | null
  account_name: string
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
  let importedCount: number | null = null
  let operationError: unknown = null

  try {
    const user = await getAuthenticatedUser(request)
    const { publicToken } = await readImportRequest(request)
    const plaid = getPlaidClient()
    const exchange = await plaid.itemPublicTokenExchange({
      public_token: publicToken,
    })
    accessToken = exchange.data.access_token

    const accounts = await plaid.accountsGet({
      access_token: accessToken,
    })
    const accountNames = new Map(
      accounts.data.accounts.map((account) => [account.account_id, account.name]),
    )
    const transactions = new Map<string, TransactionRow>()
    let cursor: string | undefined
    let hasMore = true

    while (hasMore) {
      const page = await plaid.transactionsSync({
        access_token: accessToken,
        cursor,
      })

      for (const transaction of [...page.data.added, ...page.data.modified]) {
        transactions.set(transaction.transaction_id, {
          source_transaction_id: transaction.transaction_id,
          transaction_date: transaction.date,
          merchant_name: transaction.merchant_name ?? null,
          amount: transaction.amount,
          currency_code: transaction.iso_currency_code ?? null,
          is_pending: transaction.pending,
          category: transaction.personal_finance_category?.primary ?? null,
          account_name: accountNames.get(transaction.account_id) ?? 'Linked account',
        })
      }

      cursor = page.data.next_cursor
      hasMore = page.data.has_more
    }

    const { data, error } = await getServiceRoleClient().rpc(
      'replace_transactions_for_user',
      {
        p_user_id: user.id,
        p_transactions: [...transactions.values()],
      },
    )

    if (error) {
      throw new Error('The imported transactions could not be saved.')
    }

    importedCount = typeof data === 'number' ? data : transactions.size
  } catch (error) {
    operationError = error
  }

  let removalError: unknown = null

  if (accessToken) {
    try {
      await getPlaidClient().itemRemove({
        access_token: accessToken,
      })
    } catch (error) {
      removalError = error
    }
  }

  if (removalError) {
    console.error('Plaid Item removal failed after an import attempt.')
    return jsonResponse(request, 502, {
      error:
        'We could not remove the temporary bank connection. Please contact support before trying again.',
    })
  }

  if (operationError) {
    if (operationError instanceof HttpError) {
      return jsonResponse(request, operationError.status, {
        error: operationError.message,
      })
    }

    console.error('Plaid transaction import failed.')
    return jsonResponse(request, 500, {
      error: 'We could not import transactions from this bank. Please try again.',
    })
  }

  return jsonResponse(request, 200, {
    importedCount,
  })
})
