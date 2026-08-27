import { useCallback, useEffect, useState } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import { getSupabaseClient } from '../lib/supabase.ts'

interface Transaction {
  id: string
  plaid_item_id: string | null
  transaction_date: string
  merchant_name: string | null
  transaction_name: string | null
  amount: number
  currency_code: string | null
  is_pending: boolean
  account_name: string
}

interface Category {
  id: string
  name: string
}

interface TransactionSplit {
  id: string
  transaction_id: string
  category_id: string
  amount: number
}

interface DraftSplit {
  key: string
  categoryId: string
  amount: string
}

interface PlaidItem {
  id: string
  institution_name: string | null
  status:
    | 'initial_syncing'
    | 'active'
    | 'needs_reconnect'
    | 'error'
    | 'disconnected'
  initial_update_complete: boolean
  historical_update_complete: boolean
  last_synced_at: string | null
  connected_at: string
}

interface DashboardData {
  items: PlaidItem[]
  transactions: Transaction[]
  categories: Category[]
  splits: TransactionSplit[]
}

interface LinkTokenResponse {
  linkToken: string
}

interface ImportTransactionsResponse {
  itemId: string
  importedCount: number
  isSyncing: boolean
}

interface CompleteItemUpdateResponse {
  importedCount: number
  isSyncing: boolean
}

type ItemOperation = 'retry' | 'disconnect' | 'delete-history' | 'update'

const linkTokenStorageKey = 'plaid-link-token'

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00`))
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'Not yet synchronized'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatAmount(amount: number, currencyCode: string | null): string {
  let formatted: string

  if (!currencyCode) {
    formatted = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(amount)
  } else {
    formatted = new Intl.NumberFormat(undefined, {
      currency: currencyCode,
      style: 'currency',
    }).format(amount)
  }

  return amount > 0 ? `+${formatted}` : formatted
}

function parseSplitAmount(value: string): number | null {
  const normalized = value.trim()
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null
  }

  const amount = Number(normalized)
  return Number.isFinite(amount) ? amount : null
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

function isFunctionErrorResponse(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string' &&
    value.error.length > 0
  )
}

async function functionErrorMessage(
  error: unknown,
  fallback: string,
): Promise<string> {
  if (
    typeof error === 'object' &&
    error !== null &&
    'context' in error &&
    error.context instanceof Response
  ) {
    try {
      const body: unknown = await error.context.clone().json()

      if (isFunctionErrorResponse(body)) {
        return body.error
      }
    } catch {
      return responseErrorMessage(error, fallback)
    }
  }

  return responseErrorMessage(error, fallback)
}

async function queryDashboard(): Promise<DashboardData> {
  const client = getSupabaseClient()
  const [itemsResult, transactionsResult, categoriesResult, splitsResult] =
    await Promise.all([
    client
      .from('plaid_items')
      .select(
        'id, institution_name, status, initial_update_complete, historical_update_complete, last_synced_at, connected_at',
      )
      .order('connected_at', { ascending: false }),
    client
      .from('transactions')
      .select(
        'id, plaid_item_id, transaction_date, merchant_name, transaction_name, amount, currency_code, is_pending, account_name',
      )
      .order('transaction_date', { ascending: false }),
    client.from('categories').select('id, name').order('name'),
    client
      .from('transaction_category_splits')
      .select('id, transaction_id, category_id, amount'),
  ])

  if (itemsResult.error) {
    throw new Error(itemsResult.error.message)
  }

  if (transactionsResult.error) {
    throw new Error(transactionsResult.error.message)
  }

  if (categoriesResult.error) {
    throw new Error(categoriesResult.error.message)
  }

  if (splitsResult.error) {
    throw new Error(splitsResult.error.message)
  }

  return {
    items: itemsResult.data ?? [],
    transactions: transactionsResult.data ?? [],
    categories: categoriesResult.data ?? [],
    splits: splitsResult.data ?? [],
  }
}

function connectionStatus(item: PlaidItem): string {
  switch (item.status) {
    case 'initial_syncing':
      return item.initial_update_complete
        ? 'Preparing additional history'
        : 'Preparing transaction history'
    case 'active':
      return item.historical_update_complete
        ? 'Connected and synchronized'
        : 'Connected'
    case 'needs_reconnect':
      return 'Reconnect needed'
    case 'error':
      return 'Synchronization needs attention'
    case 'disconnected':
      return 'Disconnected; history retained'
  }
}

export function TransactionsPanel({
  categoriesRevision,
}: {
  categoriesRevision: number
}) {
  const [items, setItems] = useState<PlaidItem[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [splits, setSplits] = useState<TransactionSplit[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreatingLink, setIsCreatingLink] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [itemOperation, setItemOperation] = useState<{
    itemId: string
    operation: ItemOperation
  } | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null)
  const [editingTransactionId, setEditingTransactionId] = useState<
    string | null
  >(null)
  const [draftSplits, setDraftSplits] = useState<DraftSplit[]>([])
  const [splitError, setSplitError] = useState<string | null>(null)
  const [isSavingSplits, setIsSavingSplits] = useState(false)
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null)
  const [linkToken, setLinkToken] = useState<string | null>(() => {
    if (!hasOAuthRedirect()) {
      window.sessionStorage.removeItem(linkTokenStorageKey)
      return null
    }

    return window.sessionStorage.getItem(linkTokenStorageKey)
  })

  function isItemOperation(itemId: string, operation: ItemOperation): boolean {
    return (
      itemOperation?.itemId === itemId && itemOperation.operation === operation
    )
  }

  const refreshDashboard = useCallback(async () => {
    try {
      const dashboard = await queryDashboard()

      setDataError(null)
      setItems(dashboard.items)
      setTransactions(dashboard.transactions)
      setCategories(dashboard.categories)
      setSplits(dashboard.splits)
    } catch (error) {
      setDataError(responseErrorMessage(error, 'We could not load transactions.'))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let isCurrent = true

    async function loadInitialDashboard() {
      try {
        const dashboard = await queryDashboard()

        if (!isCurrent) {
          return
        }

        setDataError(null)
        setItems(dashboard.items)
        setTransactions(dashboard.transactions)
        setCategories(dashboard.categories)
        setSplits(dashboard.splits)
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

    void loadInitialDashboard()

    return () => {
      isCurrent = false
    }
  }, [categoriesRevision])

  const hasInitialSync = items.some((item) => item.status === 'initial_syncing')

  useEffect(() => {
    const interval = window.setInterval(
      () => {
        void refreshDashboard()
      },
      hasInitialSync ? 5_000 : 60_000,
    )

    return () => {
      window.clearInterval(interval)
    }
  }, [hasInitialSync, refreshDashboard])

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
        setConnectionError(
          await functionErrorMessage(
            error,
            'We could not connect this bank. Please try again.',
          ),
        )
        return
      }

      if (!data?.itemId || typeof data.importedCount !== 'number') {
        setConnectionError(
          'The bank connected, but the synchronization result was invalid.',
        )
        return
      }

      setConnectionMessage(
        data.importedCount === 0
          ? 'Your bank is connected. We are preparing its transaction history.'
          : `Connected bank and imported ${data.importedCount} transaction${data.importedCount === 1 ? '' : 's'}.`,
      )
      await refreshDashboard()
    },
    [refreshDashboard],
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

      if (updatingItemId) {
        const itemId = updatingItemId
        setUpdatingItemId(null)
        void completeItemUpdate(itemId)
        return
      }

      if (!publicToken) {
        setConnectionError('The bank connection did not return a usable token.')
        return
      }

      void importTransactions(publicToken)
    },
    onExit: (error) => {
      clearPersistedLinkToken()
      setLinkToken(null)
      setUpdatingItemId(null)

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

  async function startConnection(itemId?: string) {
    setIsCreatingLink(true)
    setUpdatingItemId(itemId ?? null)
    setConnectionError(null)
    setConnectionMessage(null)

    const { data, error } = await getSupabaseClient().functions.invoke<LinkTokenResponse>(
      'plaid-create-link-token',
      {
        body: itemId ? { itemId } : {},
      },
    )

    setIsCreatingLink(false)

    if (error) {
      setUpdatingItemId(null)
      setConnectionError(
        await functionErrorMessage(
          error,
          'We could not start the bank connection. Please try again.',
        ),
      )
      return
    }

    if (!data?.linkToken) {
      setUpdatingItemId(null)
      setConnectionError('The bank connection could not be initialized.')
      return
    }

    window.sessionStorage.setItem(linkTokenStorageKey, data.linkToken)
    setLinkToken(data.linkToken)
  }

  async function completeItemUpdate(itemId: string) {
    setItemOperation({ itemId, operation: 'update' })
    setConnectionError(null)
    setConnectionMessage(null)

    const { data, error } = await getSupabaseClient().functions.invoke<
      CompleteItemUpdateResponse
    >('plaid-complete-item-update', {
      body: { itemId },
    })

    setItemOperation(null)

    if (error) {
      setConnectionError(
        await functionErrorMessage(
          error,
          'We could not complete this bank update. Please try again.',
        ),
      )
      return
    }

    setConnectionMessage(
      data?.isSyncing
        ? 'Your bank was updated. We are synchronizing transactions.'
        : `Your bank was updated. Imported ${data?.importedCount ?? 0} transaction${data?.importedCount === 1 ? '' : 's'}.`,
    )
    await refreshDashboard()
  }

  async function retryItemSync(item: PlaidItem) {
    setItemOperation({ itemId: item.id, operation: 'retry' })
    setConnectionError(null)
    setConnectionMessage(null)

    const { data, error } = await getSupabaseClient().functions.invoke<
      CompleteItemUpdateResponse
    >('plaid-retry-item-sync', {
      body: { itemId: item.id },
    })

    setItemOperation(null)

    if (error) {
      setConnectionError(
        await functionErrorMessage(
          error,
          'We could not check for available transactions. Please try again.',
        ),
      )
      return
    }

    setConnectionMessage(
      data?.isSyncing
        ? 'A transaction synchronization is already in progress.'
        : data?.importedCount
          ? `Imported ${data.importedCount} transaction${data.importedCount === 1 ? '' : 's'}.`
          : 'Your bank has not provided additional transactions yet.',
    )
    await refreshDashboard()
  }

  async function disconnectItem(item: PlaidItem) {
    if (
      !window.confirm(
        `Disconnect ${item.institution_name ?? 'this bank'}? New transactions will stop syncing, but imported history will remain.`,
      )
    ) {
      return
    }

    setItemOperation({ itemId: item.id, operation: 'disconnect' })
    setConnectionError(null)
    setConnectionMessage(null)

    const { error } = await getSupabaseClient().functions.invoke(
      'plaid-disconnect-item',
      {
        body: { itemId: item.id },
      },
    )

    setItemOperation(null)

    if (error) {
      setConnectionError(
        await functionErrorMessage(
          error,
          'We could not disconnect this bank. Please try again.',
        ),
      )
      return
    }

    setConnectionMessage(
      `${item.institution_name ?? 'Bank'} was disconnected. Imported history remains available.`,
    )
    await refreshDashboard()
  }

  async function deleteDisconnectedHistory(item: PlaidItem) {
    if (
      !window.confirm(
        `Delete all retained history from ${item.institution_name ?? 'this bank'}? This cannot be undone.`,
      )
    ) {
      return
    }

    setItemOperation({ itemId: item.id, operation: 'delete-history' })
    setConnectionError(null)
    setConnectionMessage(null)

    const { error } = await getSupabaseClient().functions.invoke(
      'plaid-delete-disconnected-history',
      {
        body: { itemId: item.id },
      },
    )

    setItemOperation(null)

    if (error) {
      setConnectionError(
        await functionErrorMessage(
          error,
          'We could not delete this disconnected bank history.',
        ),
      )
      return
    }

    setConnectionMessage(
      `${item.institution_name ?? 'Disconnected bank'} history was deleted.`,
    )
    await refreshDashboard()
  }

  function startSplitEdit(transaction: Transaction) {
    const currentSplits = splits.filter(
      (split) => split.transaction_id === transaction.id,
    )

    setEditingTransactionId(transaction.id)
    setSplitError(null)
    setDraftSplits(
      currentSplits.length > 0
        ? currentSplits.map((split) => ({
            key: split.id,
            categoryId: split.category_id,
            amount: split.amount.toFixed(2),
          }))
        : [
            {
              key: window.crypto.randomUUID(),
              categoryId: categories[0]?.id ?? '',
              amount: transaction.amount.toFixed(2),
            },
          ],
    )
  }

  function updateDraftSplit(
    key: string,
    field: 'categoryId' | 'amount',
    value: string,
  ) {
    setDraftSplits((current) =>
      current.map((split) =>
        split.key === key ? { ...split, [field]: value } : split,
      ),
    )
    setSplitError(null)
  }

  function addDraftSplit(transaction: Transaction) {
    const selectedCategoryIds = new Set(
      draftSplits.map((split) => split.categoryId),
    )
    const availableCategory = categories.find(
      (category) => !selectedCategoryIds.has(category.id),
    )
    const assignedAmount = draftSplits.reduce(
      (sum, split) => sum + (parseSplitAmount(split.amount) ?? 0),
      0,
    )

    setDraftSplits((current) => [
      ...current,
      {
        key: window.crypto.randomUUID(),
        categoryId: availableCategory?.id ?? '',
        amount: (transaction.amount - assignedAmount).toFixed(2),
      },
    ])
    setSplitError(null)
  }

  function removeDraftSplit(key: string) {
    setDraftSplits((current) =>
      current.filter((split) => split.key !== key),
    )
    setSplitError(null)
  }

  function validateDraftSplits(transaction: Transaction): string | null {
    if (draftSplits.length === 0) {
      return null
    }

    if (draftSplits.some((split) => !split.categoryId)) {
      return 'Choose a category for every split.'
    }

    if (new Set(draftSplits.map((split) => split.categoryId)).size !==
      draftSplits.length) {
      return 'A category can appear only once in a transaction split.'
    }

    const amounts = draftSplits.map((split) =>
      parseSplitAmount(split.amount),
    )

    if (amounts.some((amount) => amount === null || amount === 0)) {
      return 'Enter a nonzero amount with no more than two decimal places for every split.'
    }

    const validAmounts = amounts as number[]
    if (
      validAmounts.some(
        (amount) => Math.sign(amount) !== Math.sign(transaction.amount),
      )
    ) {
      return `Every split must be ${
        transaction.amount > 0 ? 'an inflow' : 'an outflow'
      }.`
    }

    const transactionCents = Math.round(transaction.amount * 100)
    const splitCents = validAmounts.reduce(
      (sum, amount) => sum + Math.round(amount * 100),
      0,
    )

    if (splitCents !== transactionCents) {
      return `Splits must total ${formatAmount(
        transaction.amount,
        transaction.currency_code,
      )}.`
    }

    return null
  }

  function splitBalanceLabel(transaction: Transaction): {
    label: string
    isValid: boolean
  } {
    if (draftSplits.length === 0) {
      return { label: 'Unassigned', isValid: true }
    }

    const amounts = draftSplits.map((split) =>
      parseSplitAmount(split.amount),
    )
    if (amounts.some((amount) => amount === null)) {
      return { label: 'Check amounts', isValid: false }
    }

    const remainingCents =
      Math.round(transaction.amount * 100) -
      (amounts as number[]).reduce(
        (sum, amount) => sum + Math.round(amount * 100),
        0,
      )

    if (remainingCents === 0 && !validateDraftSplits(transaction)) {
      return { label: 'Fully assigned', isValid: true }
    }

    const direction = Math.sign(remainingCents) === Math.sign(transaction.amount)
      ? 'remaining'
      : 'over'

    return {
      label: `${formatAmount(
        Math.abs(remainingCents) / 100,
        transaction.currency_code,
      ).replace(/^\+/, '')} ${direction}`,
      isValid: false,
    }
  }

  async function saveSplits(transaction: Transaction) {
    const validationError = validateDraftSplits(transaction)
    if (validationError) {
      setSplitError(validationError)
      return
    }

    setIsSavingSplits(true)
    setSplitError(null)

    const { error } = await getSupabaseClient().rpc(
      'replace_transaction_category_splits',
      {
        p_transaction_id: transaction.id,
        p_splits: draftSplits.map((split) => ({
          category_id: split.categoryId,
          amount: Number(split.amount),
        })),
      },
    )

    setIsSavingSplits(false)

    if (error) {
      setSplitError(error.message)
      return
    }

    setEditingTransactionId(null)
    setDraftSplits([])
    await refreshDashboard()
  }

  const institutionsByItemId = new Map(
    items.map((item) => [item.id, item.institution_name ?? 'Connected bank']),
  )
  const categoriesById = new Map(
    categories.map((category) => [category.id, category]),
  )

  return (
    <section
      className="app-shell__content transactions-panel"
      aria-labelledby="transactions-title"
    >
      <div className="transactions-panel__header">
        <div>
          <p className="eyebrow">Transactions</p>
          <h2 id="transactions-title">Connected bank transactions</h2>
          <p>
            Connected banks update automatically. Disconnecting a bank stops
            future updates but keeps the history you have already imported.
          </p>
        </div>
        <button
          className="button"
          type="button"
          onClick={() => void startConnection()}
          disabled={isCreatingLink || isImporting}
        >
          {isCreatingLink
            ? 'Preparing secure connection...'
            : isImporting
              ? 'Connecting bank...'
              : 'Connect bank'}
        </button>
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

      <section
        className="connection-list"
        aria-labelledby="connections-title"
        aria-busy={isLoading}
      >
        <h3 id="connections-title">Bank connections</h3>
        {isLoading ? (
          <p className="transactions-panel__status" aria-live="polite">
            Loading bank connections...
          </p>
        ) : items.length === 0 ? (
          <p className="transactions-panel__status">
            No banks are connected yet.
          </p>
        ) : (
          <ul className="connection-list__items">
            {items.map((item) => (
              <li key={item.id} className="connection-card">
                <div>
                  <h4>{item.institution_name ?? 'Connected bank'}</h4>
                  <p>{connectionStatus(item)}</p>
                  <p>Last sync: {formatTimestamp(item.last_synced_at)}</p>
                </div>
                <div className="connection-card__actions">
                  {item.status === 'disconnected' ? (
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() => void deleteDisconnectedHistory(item)}
                      disabled={itemOperation?.itemId === item.id}
                    >
                      {isItemOperation(item.id, 'delete-history')
                        ? 'Deleting history...'
                        : 'Delete saved history'}
                    </button>
                  ) : (
                    <>
                      {(item.status === 'initial_syncing' ||
                        item.status === 'error') && (
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => void retryItemSync(item)}
                          disabled={itemOperation?.itemId === item.id}
                        >
                          {isItemOperation(item.id, 'retry')
                            ? 'Checking transactions...'
                            : 'Check available transactions'}
                        </button>
                      )}
                      {item.status === 'needs_reconnect' ? (
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => void startConnection(item.id)}
                          disabled={
                            isCreatingLink ||
                            isImporting ||
                            itemOperation?.itemId === item.id
                          }
                        >
                          {isCreatingLink && updatingItemId === item.id
                            ? 'Preparing reconnect...'
                            : isItemOperation(item.id, 'update')
                              ? 'Updating bank...'
                              : 'Reconnect bank'}
                        </button>
                      ) : (
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => void disconnectItem(item)}
                          disabled={itemOperation?.itemId === item.id}
                        >
                          {isItemOperation(item.id, 'disconnect')
                            ? 'Disconnecting...'
                            : 'Disconnect bank'}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="transaction-list" aria-labelledby="transaction-list-title">
        <h3 id="transaction-list-title">Imported transactions</h3>
        {isLoading ? (
          <p className="transactions-panel__status" aria-live="polite">
            Loading transactions...
          </p>
        ) : transactions.length === 0 ? (
          <p className="transactions-panel__status">
            No transactions have been imported yet.
          </p>
        ) : (
          <ul className="transaction-cards">
            {transactions.map((transaction) => {
              const transactionSplits = splits.filter(
                (split) => split.transaction_id === transaction.id,
              )
              const isEditing = editingTransactionId === transaction.id
              const balance = isEditing
                ? splitBalanceLabel(transaction)
                : null
              const institution = transaction.plaid_item_id
                ? institutionsByItemId.get(transaction.plaid_item_id) ??
                  'Connected bank'
                : 'Previous import'
              const description =
                transaction.merchant_name ??
                transaction.transaction_name ??
                'Transaction'

              return (
                <li
                  className={`transaction-card${
                    isEditing ? ' transaction-card--editing' : ''
                  }`}
                  key={transaction.id}
                >
                  <div className="transaction-card__summary">
                    <div className="transaction-card__details">
                      <div className="transaction-card__heading">
                        <h4>{description}</h4>
                        <time dateTime={transaction.transaction_date}>
                          {formatDate(transaction.transaction_date)}
                        </time>
                      </div>
                      <div className="transaction-card__meta">
                        <span>{transaction.account_name}</span>
                        <span>{institution}</span>
                        <span>{transaction.currency_code ?? '-'}</span>
                        <span>
                          {transaction.is_pending ? 'Pending' : 'Posted'}
                        </span>
                      </div>
                    </div>
                    <strong
                      className={`transaction-card__amount${
                        transaction.amount > 0
                          ? ' transaction-card__amount--inflow'
                          : ''
                      }`}
                    >
                      {formatAmount(
                        transaction.amount,
                        transaction.currency_code,
                      )}
                    </strong>
                    <div className="transaction-card__categories">
                      <span className="transaction-card__label">
                        Category splits
                      </span>
                      {isEditing ? (
                        <strong>Editing below</strong>
                      ) : transactionSplits.length > 0 ? (
                        <div className="split-summary">
                          {transactionSplits.map((split) => (
                            <span key={split.id}>
                              {categoriesById.get(split.category_id)?.name ??
                                'Deleted category'}{' '}
                              {formatAmount(
                                split.amount,
                                transaction.currency_code,
                              )}
                            </span>
                          ))}
                          <button
                            className="text-button"
                            type="button"
                            onClick={() => startSplitEdit(transaction)}
                          >
                            Edit
                          </button>
                        </div>
                      ) : (
                        <button
                          className="button button--compact"
                          type="button"
                          onClick={() => startSplitEdit(transaction)}
                          disabled={categories.length === 0}
                          title={
                            categories.length === 0
                              ? 'Create a category first'
                              : undefined
                          }
                        >
                          Categorize
                        </button>
                      )}
                    </div>
                  </div>

                  {isEditing && balance && (
                    <form
                      className={`split-editor${
                        splitError ? ' split-editor--invalid' : ''
                      }`}
                      onSubmit={(event) => {
                        event.preventDefault()
                        void saveSplits(transaction)
                      }}
                    >
                      <div className="split-editor__header">
                        <div>
                          <h4>Split {description}</h4>
                          <p>
                            Assign the full{' '}
                            <strong>
                              {formatAmount(
                                transaction.amount,
                                transaction.currency_code,
                              )}
                            </strong>
                            . Every split must also be{' '}
                            {transaction.amount > 0
                              ? 'an inflow'
                              : 'an outflow'}
                            .
                          </p>
                        </div>
                        <span
                          className={`split-balance ${
                            balance.isValid
                              ? 'split-balance--complete'
                              : 'split-balance--error'
                          }`}
                        >
                          {balance.label}
                        </span>
                      </div>

                      <div className="split-lines">
                        {draftSplits.map((split) => (
                          <div className="split-line" key={split.key}>
                            <label>
                              Category
                              <select
                                value={split.categoryId}
                                onChange={(event) =>
                                  updateDraftSplit(
                                    split.key,
                                    'categoryId',
                                    event.target.value,
                                  )
                                }
                                disabled={isSavingSplits}
                              >
                                <option value="">Choose category</option>
                                {categories.map((category) => (
                                  <option
                                    key={category.id}
                                    value={category.id}
                                    disabled={draftSplits.some(
                                      (other) =>
                                        other.key !== split.key &&
                                        other.categoryId === category.id,
                                    )}
                                  >
                                    {category.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              Amount
                              <input
                                inputMode="decimal"
                                type="text"
                                value={split.amount}
                                onChange={(event) =>
                                  updateDraftSplit(
                                    split.key,
                                    'amount',
                                    event.target.value,
                                  )
                                }
                                disabled={isSavingSplits}
                                aria-invalid={splitError ? 'true' : undefined}
                              />
                            </label>
                            <button
                              aria-label="Remove split"
                              className="text-button text-button--danger split-line__remove"
                              type="button"
                              onClick={() => removeDraftSplit(split.key)}
                              disabled={isSavingSplits}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>

                      {splitError && (
                        <p
                          className="form-message form-message--error"
                          role="alert"
                        >
                          {splitError}
                        </p>
                      )}

                      <button
                        className="text-button split-editor__add"
                        type="button"
                        onClick={() => addDraftSplit(transaction)}
                        disabled={
                          isSavingSplits ||
                          draftSplits.length >= categories.length
                        }
                      >
                        + Add split
                      </button>
                      <div className="split-editor__actions">
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => {
                            setEditingTransactionId(null)
                            setDraftSplits([])
                            setSplitError(null)
                          }}
                          disabled={isSavingSplits}
                        >
                          Cancel
                        </button>
                        <button
                          className="button"
                          type="submit"
                          disabled={
                            isSavingSplits ||
                            Boolean(validateDraftSplits(transaction))
                          }
                        >
                          {isSavingSplits ? 'Saving splits...' : 'Save splits'}
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </section>
  )
}
