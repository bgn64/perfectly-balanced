import { useCallback, useEffect, useState } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import { getSupabaseClient } from '../lib/supabase.ts'

interface Transaction {
  id: string
  transaction_date: string
  merchant_name: string | null
  amount: number
  currency_code: string | null
  is_pending: boolean
  category: string | null
  account_name: string
}

interface LinkTokenResponse {
  linkToken: string
}

interface ImportTransactionsResponse {
  importedCount: number
}

const linkTokenStorageKey = 'plaid-link-token'

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00`))
}

function formatAmount(amount: number, currencyCode: string | null): string {
  if (!currencyCode) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(amount)
  }

  return new Intl.NumberFormat(undefined, {
    currency: currencyCode,
    style: 'currency',
  }).format(amount)
}

function hasOAuthRedirect(): boolean {
  return new URL(window.location.href).searchParams.has('oauth_state_id')
}

function clearPersistedLinkToken(): void {
  window.sessionStorage.removeItem(linkTokenStorageKey)

  if (hasOAuthRedirect()) {
    window.history.replaceState({}, document.title, window.location.pathname)
  }
}

function responseErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) {
    return error
  }

  return error instanceof Error && error.message ? error.message : fallback
}

async function queryTransactions(): Promise<Transaction[]> {
  const { data, error } = await getSupabaseClient()
    .from('transactions')
    .select(
      'id, transaction_date, merchant_name, amount, currency_code, is_pending, category, account_name',
    )
    .order('transaction_date', { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  return data ?? []
}

export function TransactionsPanel({ userId }: { userId: string }) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreatingLink, setIsCreatingLink] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [dataError, setDataError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null)
  const [linkToken, setLinkToken] = useState<string | null>(() => {
    if (!hasOAuthRedirect()) {
      window.sessionStorage.removeItem(linkTokenStorageKey)
      return null
    }

    return window.sessionStorage.getItem(linkTokenStorageKey)
  })

  const loadTransactions = useCallback(async () => {
    try {
      const loadedTransactions = await queryTransactions()

      setDataError(null)
      setTransactions(loadedTransactions)
    } catch (error) {
      setDataError(responseErrorMessage(error, 'We could not load transactions.'))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let isCurrent = true

    async function loadInitialTransactions() {
      try {
        const loadedTransactions = await queryTransactions()

        if (!isCurrent) {
          return
        }

        setDataError(null)
        setTransactions(loadedTransactions)
      } catch (error) {
        if (isCurrent) {
          setDataError(
            responseErrorMessage(error, 'We could not load transactions.'),
          )
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false)
        }
      }
    }

    void loadInitialTransactions()

    return () => {
      isCurrent = false
    }
  }, [])

  const importTransactions = useCallback(
    async (publicToken: string) => {
      setIsImporting(true)
      setConnectionError(null)
      setConnectionMessage(null)

      const { data, error } = await getSupabaseClient().functions.invoke<
        ImportTransactionsResponse
      >('plaid-import-transactions', {
        body: { publicToken },
      })

      setIsImporting(false)

      if (error) {
        setConnectionError(error.message)
        return
      }

      const importedCount = data?.importedCount

      if (typeof importedCount !== 'number') {
        setConnectionError(
          'The bank connection completed, but the import result was invalid.',
        )
        return
      }

      setConnectionMessage(
        importedCount === 0
          ? 'Your bank did not provide transactions during this initial import.'
          : `Imported ${importedCount} transaction${importedCount === 1 ? '' : 's'}.`,
      )
      await loadTransactions()
    },
    [loadTransactions],
  )

  const { error: plaidLoadError, open, ready } = usePlaidLink({
    token: linkToken,
    ...(hasOAuthRedirect()
      ? {
          receivedRedirectUri: window.location.href,
        }
      : {}),
    onSuccess: (publicToken) => {
      clearPersistedLinkToken()
      setLinkToken(null)

      if (!publicToken) {
        setConnectionError('The bank connection did not return a usable token.')
        return
      }

      void importTransactions(publicToken)
    },
    onExit: (error) => {
      clearPersistedLinkToken()
      setLinkToken(null)

      if (error) {
        setConnectionError(error.display_message ?? error.error_message)
      }
    },
  })

  useEffect(() => {
    if (linkToken && ready && !isImporting) {
      open()
    }
  }, [isImporting, linkToken, open, ready])

  const displayedConnectionError = plaidLoadError
    ? 'We could not load the secure bank connection window.'
    : connectionError

  async function startConnection() {
    setIsCreatingLink(true)
    setConnectionError(null)
    setConnectionMessage(null)

    const { data, error } = await getSupabaseClient().functions.invoke<LinkTokenResponse>(
      'plaid-create-link-token',
    )

    setIsCreatingLink(false)

    if (error) {
      setConnectionError(error.message)
      return
    }

    if (!data?.linkToken) {
      setConnectionError('The bank connection could not be initialized.')
      return
    }

    window.sessionStorage.setItem(linkTokenStorageKey, data.linkToken)
    setLinkToken(data.linkToken)
  }

  async function clearTransactions() {
    if (
      !window.confirm(
        'Delete all imported transaction data from this application? This cannot be undone.',
      )
    ) {
      return
    }

    setIsClearing(true)
    setDataError(null)

    const { error } = await getSupabaseClient()
      .from('transactions')
      .delete()
      .eq('user_id', userId)

    setIsClearing(false)

    if (error) {
      setDataError(error.message)
      return
    }

    setTransactions([])
    setConnectionMessage('Imported transaction data was deleted.')
  }

  return (
    <section
      className="app-shell__content transactions-panel"
      aria-labelledby="transactions-title"
    >
      <div className="transactions-panel__header">
        <div>
          <p className="eyebrow">Transactions</p>
          <h2 id="transactions-title">Imported transactions</h2>
          <p>
            Connect a bank to import its currently available transactions. The
            connection is removed after the import completes.
          </p>
        </div>
        <div className="transactions-panel__actions">
          <button
            type="button"
            onClick={() => void startConnection()}
            disabled={isCreatingLink || isImporting}
          >
            {isCreatingLink
              ? 'Preparing secure connection...'
              : isImporting
                ? 'Importing transactions...'
                : 'Connect bank'}
          </button>
          {transactions.length > 0 && (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void clearTransactions()}
              disabled={isClearing || isCreatingLink || isImporting}
            >
              {isClearing ? 'Deleting data...' : 'Clear imported data'}
            </button>
          )}
        </div>
      </div>

      {displayedConnectionError && (
        <p className="form-message form-message--error" role="alert">
          {responseErrorMessage(
            displayedConnectionError,
            'The bank connection failed.',
          )}
        </p>
      )}
      {dataError && (
        <p className="form-message form-message--error" role="alert">
          {responseErrorMessage(dataError, 'We could not load transactions.')}
        </p>
      )}
      {connectionMessage && (
        <p className="form-message form-message--success" role="status">
          {connectionMessage}
        </p>
      )}

      {isLoading ? (
        <p className="transactions-panel__status" aria-live="polite">
          Loading transactions...
        </p>
      ) : transactions.length === 0 ? (
        <p className="transactions-panel__status">
          No transactions have been imported yet.
        </p>
      ) : (
        <div className="transactions-table__scroll">
          <table className="transactions-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Merchant</th>
                <th scope="col">Amount</th>
                <th scope="col">Currency</th>
                <th scope="col">Pending</th>
                <th scope="col">Category</th>
                <th scope="col">Account</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td>{formatDate(transaction.transaction_date)}</td>
                  <td>{transaction.merchant_name ?? '-'}</td>
                  <td>{formatAmount(transaction.amount, transaction.currency_code)}</td>
                  <td>{transaction.currency_code ?? '-'}</td>
                  <td>{transaction.is_pending ? 'Pending' : 'Posted'}</td>
                  <td>{transaction.category ?? '-'}</td>
                  <td>{transaction.account_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
