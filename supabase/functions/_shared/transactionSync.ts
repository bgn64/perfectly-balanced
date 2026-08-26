import { getPlaidClient } from './plaid.ts'
import { getServiceRoleClient } from './supabase.ts'

interface ClaimedPlaidItem {
  item_id: string
  plaid_item_id: string
  access_token: string
  sync_cursor: string | null
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
  plaid_account_id: string
}

export interface SyncResult {
  claimed: boolean
  importedCount: number
}

export interface SyncOptions {
  initialUpdateComplete?: boolean
  historicalUpdateComplete?: boolean
}

function isClaimedPlaidItem(value: unknown): value is ClaimedPlaidItem {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const item = value as Record<string, unknown>
  return (
    typeof item.item_id === 'string' &&
    typeof item.plaid_item_id === 'string' &&
    typeof item.access_token === 'string' &&
    (typeof item.sync_cursor === 'string' || item.sync_cursor === null)
  )
}

function plaidErrorCode(error: unknown): string {
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

  return 'SYNC_FAILED'
}

async function claimPlaidItem(
  itemId: string,
): Promise<ClaimedPlaidItem | null> {
  const { data, error } = await getServiceRoleClient().rpc(
    'claim_plaid_item_sync',
    {
      p_item_id: itemId,
    },
  )

  if (error) {
    throw new Error('The Plaid connection could not be claimed for synchronization.')
  }

  if (!Array.isArray(data) || data.length === 0) {
    return null
  }

  if (!isClaimedPlaidItem(data[0])) {
    throw new Error('The Plaid connection returned an invalid synchronization state.')
  }

  return data[0]
}

async function retrieveTransactionChanges(
  claimedItem: ClaimedPlaidItem,
): Promise<{
  added: TransactionRow[]
  modified: TransactionRow[]
  removed: string[]
  nextCursor: string | null
}> {
  const plaid = getPlaidClient()
  const accounts = await plaid.accountsGet({
    access_token: claimedItem.access_token,
  })
  const accountNames = new Map(
    accounts.data.accounts.map((account) => [account.account_id, account.name]),
  )
  const originalCursor = claimedItem.sync_cursor ?? undefined

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const added = new Map<string, TransactionRow>()
    const modified = new Map<string, TransactionRow>()
    const removed = new Set<string>()
    let cursor = originalCursor
    let hasMore = true

    try {
      while (hasMore) {
        const page = await plaid.transactionsSync({
          access_token: claimedItem.access_token,
          cursor,
        })

        for (const transaction of page.data.added) {
          added.set(transaction.transaction_id, {
            source_transaction_id: transaction.transaction_id,
            transaction_date: transaction.date,
            merchant_name: transaction.merchant_name ?? null,
            amount: transaction.amount,
            currency_code: transaction.iso_currency_code ?? null,
            is_pending: transaction.pending,
            category: transaction.personal_finance_category?.primary ?? null,
            account_name:
              accountNames.get(transaction.account_id) ?? 'Linked account',
            plaid_account_id: transaction.account_id,
          })
        }

        for (const transaction of page.data.modified) {
          modified.set(transaction.transaction_id, {
            source_transaction_id: transaction.transaction_id,
            transaction_date: transaction.date,
            merchant_name: transaction.merchant_name ?? null,
            amount: transaction.amount,
            currency_code: transaction.iso_currency_code ?? null,
            is_pending: transaction.pending,
            category: transaction.personal_finance_category?.primary ?? null,
            account_name:
              accountNames.get(transaction.account_id) ?? 'Linked account',
            plaid_account_id: transaction.account_id,
          })
        }

        for (const transaction of page.data.removed) {
          removed.add(transaction.transaction_id)
        }

        cursor = page.data.next_cursor
        hasMore = page.data.has_more
      }

      return {
        added: [...added.values()],
        modified: [...modified.values()],
        removed: [...removed],
        nextCursor: cursor ?? null,
      }
    } catch (error) {
      if (
        plaidErrorCode(error) ===
          'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' &&
        attempt === 0
      ) {
        continue
      }

      throw error
    }
  }

  throw new Error('Plaid transaction synchronization could not be completed.')
}

export async function syncPlaidItem(
  itemId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const claimedItem = await claimPlaidItem(itemId)

  if (!claimedItem) {
    return {
      claimed: false,
      importedCount: 0,
    }
  }

  try {
    const changes = await retrieveTransactionChanges(claimedItem)
    const { data, error } = await getServiceRoleClient().rpc(
      'apply_plaid_transaction_sync',
      {
        p_item_id: claimedItem.item_id,
        p_next_cursor: changes.nextCursor,
        p_added: changes.added,
        p_modified: changes.modified,
        p_removed: changes.removed,
        p_initial_update_complete: options.initialUpdateComplete ?? false,
        p_historical_update_complete: options.historicalUpdateComplete ?? false,
      },
    )

    if (error) {
      throw new Error('The transaction changes could not be saved.')
    }

    return {
      claimed: true,
      importedCount: typeof data === 'number' ? data : changes.added.length,
    }
  } catch (error) {
    await getServiceRoleClient().rpc('record_plaid_item_sync_failure', {
      p_item_id: claimedItem.item_id,
      p_error_code: plaidErrorCode(error),
    })
    throw error
  }
}
