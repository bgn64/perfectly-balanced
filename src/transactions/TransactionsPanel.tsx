import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useAuth } from '../auth/useAuth.ts'
import { CategoryCombobox } from '../finance/CategoryCombobox.tsx'
import type {
  Budget,
  Category,
  Transaction,
  TransactionSplit,
} from '../finance/types.ts'
import { collectPages } from '../finance/query.ts'
import {
  formatMoney,
  formatMonth,
  monthKey,
  transactionDescription,
} from '../finance/utils.ts'
import { getSupabaseClient } from '../lib/supabase.ts'

interface TransactionsData {
  transactions: Transaction[]
  categories: Category[]
  splits: TransactionSplit[]
  budgets: Budget[]
}

interface DraftSplit {
  key: string
  categoryId: string
  amount: string
}

type TransactionSort = 'date' | 'merchant' | 'amount'

const uncategorizedFilter = 'uncategorized'

async function queryTransactions(): Promise<TransactionsData> {
  const client = getSupabaseClient()
  const [transactions, categoriesResult, splits, budgetsResult] =
    await Promise.all([
      collectPages((afterId, limit) => {
        let query = client
          .from('transactions')
          .select(
            'id, plaid_item_id, transaction_date, merchant_name, transaction_name, amount, currency_code, is_pending, account_name',
          )
          .order('id')
          .limit(limit)
        if (afterId) {
          query = query.gt('id', afterId)
        }
        return query
      }),
      client.from('categories').select('id, name').order('name'),
      collectPages((afterId, limit) => {
        let query = client
          .from('transaction_category_splits')
          .select('id, transaction_id, category_id, amount')
          .order('id')
          .limit(limit)
        if (afterId) {
          query = query.gt('id', afterId)
        }
        return query
      }),
      client.from('budgets').select('id, month').order('month', { ascending: false }),
    ])

  for (const result of [categoriesResult, budgetsResult]) {
    if (result.error) {
      throw new Error(result.error.message)
    }
  }

  return {
    transactions: transactions.map((transaction) => ({
      ...transaction,
      amount: Number(transaction.amount),
    })),
    categories: categoriesResult.data ?? [],
    splits: splits.map((split) => ({
      ...split,
      amount: Number(split.amount),
    })),
    budgets: budgetsResult.data ?? [],
  }
}

function parseSplitAmount(value: string): number | null {
  const normalized = value.trim().replace(/[$,\s]/g, '')
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null
  }
  const amount = Number(normalized)
  return Number.isFinite(amount) ? amount : null
}

function evenlyDistributedSplits(
  transactionAmount: number,
  splits: DraftSplit[],
): DraftSplit[] {
  if (splits.length === 0) {
    return []
  }

  const totalCents = Math.round(transactionAmount * 100)
  const evenCents = Math.trunc(totalCents / splits.length)
  const remainder = totalCents - evenCents * splits.length

  return splits.map((split, index) => ({
    ...split,
    amount: (
      (evenCents + (index === splits.length - 1 ? remainder : 0)) /
      100
    ).toFixed(2),
  }))
}

function splitsMatchEvenDistribution(
  transactionAmount: number,
  splits: TransactionSplit[],
): boolean {
  if (splits.length === 0) {
    return true
  }

  const expected = evenlyDistributedSplits(
    transactionAmount,
    splits.map((split) => ({
      key: split.id,
      categoryId: split.category_id,
      amount: split.amount.toFixed(2),
    })),
  )
    .map((split) => Math.round(Number(split.amount) * 100))
    .sort((left, right) => left - right)
  const actual = splits
    .map((split) => Math.round(split.amount * 100))
    .sort((left, right) => left - right)

  return actual.every((amount, index) => amount === expected[index])
}

export function TransactionsPanel({
  categoriesRevision,
  onCategoriesChanged,
  onTransactionsChanged,
}: {
  categoriesRevision: number
  onCategoriesChanged: () => void
  onTransactionsChanged: () => void
}) {
  const { user } = useAuth()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [splits, setSplits] = useState<TransactionSplit[]>([])
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [dataError, setDataError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState<string | null>(null)
  const [categoryFilters, setCategoryFilters] = useState<string[]>([])
  const [sort, setSort] = useState<TransactionSort>('date')
  const [selectedTransactionId, setSelectedTransactionId] = useState<
    string | null
  >(null)
  const [draftSplits, setDraftSplits] = useState<DraftSplit[]>([])
  const [isManualSplit, setIsManualSplit] = useState(false)
  const [splitError, setSplitError] = useState<string | null>(null)
  const [isSavingSplits, setIsSavingSplits] = useState(false)
  const requestGeneration = useRef(0)
  const selectedTransactionIdRef = useRef<string | null>(null)

  const refreshTransactions = useCallback(async () => {
    const generation = ++requestGeneration.current
    try {
      const data = await queryTransactions()
      if (generation !== requestGeneration.current) {
        return
      }
      setTransactions(data.transactions)
      setCategories(data.categories)
      setSplits(data.splits)
      setBudgets(data.budgets)
      if (!selectedTransactionIdRef.current && data.transactions[0]) {
        const firstTransaction = data.transactions[0]
        const firstSplits = data.splits.filter(
          (split) => split.transaction_id === firstTransaction.id,
        )
        selectedTransactionIdRef.current = firstTransaction.id
        setSelectedTransactionId(firstTransaction.id)
        setDraftSplits(
          firstSplits.map((split) => ({
            key: split.id,
            categoryId: split.category_id,
            amount: split.amount.toFixed(2),
          })),
        )
        setIsManualSplit(
          !splitsMatchEvenDistribution(firstTransaction.amount, firstSplits),
        )
      }
      setDataError(null)
    } catch (error) {
      if (generation === requestGeneration.current) {
        setDataError(
          error instanceof Error
            ? error.message
            : 'We could not load transactions.',
        )
      }
    } finally {
      if (generation === requestGeneration.current) {
        setIsLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect synchronizes the transaction stream with Supabase.
    void refreshTransactions()
    const interval = window.setInterval(() => {
      void refreshTransactions()
    }, 60_000)
    return () => {
      requestGeneration.current += 1
      window.clearInterval(interval)
    }
  }, [categoriesRevision, refreshTransactions])

  const splitsByTransaction = useMemo(() => {
    const grouped = new Map<string, TransactionSplit[]>()
    for (const split of splits) {
      const current = grouped.get(split.transaction_id) ?? []
      current.push(split)
      grouped.set(split.transaction_id, current)
    }
    return grouped
  }, [splits])
  const categoriesById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  )
  const monthOptions = useMemo(
    () =>
      Array.from(
        new Set(transactions.map((transaction) => monthKey(transaction.transaction_date))),
      ).sort((left, right) => right.localeCompare(left)),
    [transactions],
  )
  const scopeOptions = useMemo(
    () => [
      ...budgets.map((budget) => ({
        key: `budget:${budget.id}`,
        label: `${formatMonth(monthKey(budget.month))} budget`,
        month: monthKey(budget.month),
      })),
      ...monthOptions.map((month) => ({
        key: `month:${month}`,
        label: formatMonth(month),
        month,
      })),
    ],
    [budgets, monthOptions],
  )
  const scopeByKey = useMemo(
    () => new Map(scopeOptions.map((option) => [option.key, option])),
    [scopeOptions],
  )

  const displayedTransactions = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
    const activeMonth = scopeFilter
      ? scopeByKey.get(scopeFilter)?.month
      : undefined
    const filtered = transactions.filter((transaction) => {
      if (
        normalizedSearch &&
        !transactionDescription(transaction)
          .toLocaleLowerCase()
          .includes(normalizedSearch)
      ) {
        return false
      }
      if (
        activeMonth &&
        activeMonth !== monthKey(transaction.transaction_date)
      ) {
        return false
      }
      if (categoryFilters.length > 0) {
        const transactionSplits = splitsByTransaction.get(transaction.id) ?? []
        const matchesUncategorized =
          categoryFilters.includes(uncategorizedFilter) &&
          transactionSplits.length === 0
        const matchesCategory = transactionSplits.some((split) =>
          categoryFilters.includes(split.category_id),
        )
        if (!matchesUncategorized && !matchesCategory) {
          return false
        }
      }
      return true
    })

    return [...filtered].sort((left, right) => {
      if (sort === 'merchant') {
        return transactionDescription(left).localeCompare(
          transactionDescription(right),
        )
      }
      if (sort === 'amount') {
        return Math.abs(right.amount) - Math.abs(left.amount)
      }
      return right.transaction_date.localeCompare(left.transaction_date)
    })
  }, [
    categoryFilters,
    scopeByKey,
    scopeFilter,
    searchQuery,
    sort,
    splitsByTransaction,
    transactions,
  ])

  const selectedTransaction =
    transactions.find((transaction) => transaction.id === selectedTransactionId) ??
    null

  function selectTransaction(transaction: Transaction) {
    const transactionSplits = splitsByTransaction.get(transaction.id) ?? []
    selectedTransactionIdRef.current = transaction.id
    setSelectedTransactionId(transaction.id)
    setDraftSplits(
      transactionSplits.map((split) => ({
        key: split.id,
        categoryId: split.category_id,
        amount: split.amount.toFixed(2),
      })),
    )
    setIsManualSplit(
      !splitsMatchEvenDistribution(transaction.amount, transactionSplits),
    )
    setSplitError(
      transaction.currency_code === 'USD'
        ? null
        : 'Only USD transactions can be categorized.',
    )
  }

  async function createCategory(name: string): Promise<Category> {
    if (!user) {
      throw new Error('Authentication is required.')
    }
    const { data, error } = await getSupabaseClient()
      .from('categories')
      .insert({ name: name.trim(), user_id: user.id })
      .select('id, name')
      .single()
    if (error) {
      throw new Error(
        error.code === '23505' ? 'Category names must be unique.' : error.message,
      )
    }
    setCategories((current) =>
      [...current, data].sort((left, right) => left.name.localeCompare(right.name)),
    )
    onCategoriesChanged()
    return data
  }

  function addCategoryToSplit(category: Category) {
    if (!selectedTransaction) {
      return
    }
    if (draftSplits.some((split) => split.categoryId === category.id)) {
      throw new Error('That category is already assigned.')
    }
    const next = [
      ...draftSplits,
      {
        key: window.crypto.randomUUID(),
        categoryId: category.id,
        amount: '0.00',
      },
    ]
    if (isManualSplit) {
      const assignedCents = draftSplits.reduce(
        (sum, split) =>
          sum + Math.round((parseSplitAmount(split.amount) ?? 0) * 100),
        0,
      )
      const remainingCents =
        Math.round(selectedTransaction.amount * 100) - assignedCents
      next[next.length - 1] = {
        ...next[next.length - 1],
        amount: (remainingCents / 100).toFixed(2),
      }
      setDraftSplits(next)
    } else {
      setDraftSplits(evenlyDistributedSplits(selectedTransaction.amount, next))
    }
    setSplitError(null)
  }

  function removeSplit(key: string) {
    const next = draftSplits.filter((split) => split.key !== key)
    setDraftSplits(
      !isManualSplit && selectedTransaction
        ? evenlyDistributedSplits(selectedTransaction.amount, next)
        : next,
    )
    setSplitError(null)
  }

  function changeSplitCategory(key: string, category: Category) {
    setDraftSplits((current) =>
      current.map((split) =>
        split.key === key ? { ...split, categoryId: category.id } : split,
      ),
    )
    setSplitError(null)
  }

  function validateSplits(transaction: Transaction): string | null {
    if (draftSplits.length === 0) {
      return null
    }
    const amounts = draftSplits.map((split) => parseSplitAmount(split.amount))
    if (amounts.some((amount) => amount === null || amount === 0)) {
      return 'Every category needs a nonzero amount with no more than two decimals.'
    }
    const validAmounts = amounts as number[]
    if (
      validAmounts.some(
        (amount) => Math.sign(amount) !== Math.sign(transaction.amount),
      )
    ) {
      return `Every amount must be ${transaction.amount > 0 ? 'income' : 'spending'}.`
    }
    const splitCents = validAmounts.reduce(
      (sum, amount) => sum + Math.round(amount * 100),
      0,
    )
    if (splitCents !== Math.round(transaction.amount * 100)) {
      return `Splits must total ${formatMoney(
        transaction.amount,
        transaction.currency_code ?? 'USD',
      )}.`
    }
    return null
  }

  async function saveSplits() {
    if (!selectedTransaction) {
      return
    }
    const validationError = validateSplits(selectedTransaction)
    if (validationError) {
      setSplitError(validationError)
      return
    }
    setIsSavingSplits(true)
    setSplitError(null)
    const { error } = await getSupabaseClient().rpc(
      'replace_transaction_category_splits',
      {
        p_transaction_id: selectedTransaction.id,
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
    await refreshTransactions()
    onTransactionsChanged()
  }

  function toggleFilter(
    value: string,
    setFilters: React.Dispatch<React.SetStateAction<string[]>>,
  ) {
    setFilters((current) =>
      current.includes(value)
        ? current.filter((filter) => filter !== value)
        : [...current, value],
    )
  }

  const activeFilterCount = (scopeFilter ? 1 : 0) + categoryFilters.length

  return (
    <main className="page transactions-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Complete transaction stream</p>
          <h1>Transactions</h1>
          <p className="subtle">
            Search, filter, and categorize activity from every connected account.
          </p>
        </div>
        <span className="subtle">
          {displayedTransactions.length.toLocaleString()} transactions
        </span>
      </div>

      {dataError && (
        <p className="form-message form-message--error" role="alert">
          {dataError}
        </p>
      )}

      <div className="toolbar">
        <div className="search">
          <label className="sr-only" htmlFor="merchant-search">
            Search merchant name
          </label>
          <input
            id="merchant-search"
            placeholder="Search merchant name..."
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        <div className="toolbar-group transaction-tools">
          <details className="filter-wrap">
            <summary className="pill-button">
              Filter{activeFilterCount ? ` · ${activeFilterCount}` : ''}
            </summary>
            <div className="popover filter-popover">
              <h2>Budget or month</h2>
              {scopeOptions.map((option) => (
                <label className="radio" key={option.key}>
                  <input
                    checked={scopeFilter === option.key}
                    name="transaction-scope"
                    type="radio"
                    onChange={() => setScopeFilter(option.key)}
                  />
                  {option.label}
                </label>
              ))}
              <h2>Categories · match any</h2>
              <label className="check">
                <input
                  checked={categoryFilters.includes(uncategorizedFilter)}
                  type="checkbox"
                  onChange={() =>
                    toggleFilter(uncategorizedFilter, setCategoryFilters)
                  }
                />
                Uncategorized
              </label>
              {categories.map((category) => (
                <label className="check" key={category.id}>
                  <input
                    checked={categoryFilters.includes(category.id)}
                    type="checkbox"
                    onChange={() =>
                      toggleFilter(category.id, setCategoryFilters)
                    }
                  />
                  {category.name}
                </label>
              ))}
            </div>
          </details>
          <details className="filter-wrap">
            <summary className="pill-button">
              {sort === 'date'
                ? 'Newest first'
                : sort === 'merchant'
                  ? 'Merchant A-Z'
                  : 'Highest amount'}
            </summary>
            <div className="popover sort-popover">
              {(
                [
                  ['date', 'Date · newest'],
                  ['merchant', 'Merchant · A-Z'],
                  ['amount', 'Amount · highest'],
                ] as const
              ).map(([value, label]) => (
                <label className="radio" key={value}>
                  <input
                    checked={sort === value}
                    name="transaction-sort"
                    type="radio"
                    onChange={() => setSort(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </details>
        </div>
      </div>

      {activeFilterCount > 0 && (
        <div className="active-filters" aria-label="Active filters">
          {scopeFilter && (
            <FilterChip
              label={scopeByKey.get(scopeFilter)?.label ?? scopeFilter}
              onRemove={() => setScopeFilter(null)}
            />
          )}
          {categoryFilters.map((filter) => (
            <FilterChip
              key={filter}
              label={
                filter === uncategorizedFilter
                  ? 'Uncategorized'
                  : categoriesById.get(filter)?.name ?? filter
              }
              onRemove={() => toggleFilter(filter, setCategoryFilters)}
            />
          ))}
        </div>
      )}

      <div className="transaction-layout with-detail">
        <section className="panel transactions" aria-busy={isLoading}>
          {isLoading ? (
            <div className="empty-state" aria-live="polite">
              Loading transactions...
            </div>
          ) : displayedTransactions.length === 0 ? (
            <div className="empty-state">
              No transactions match the current search and filters.
            </div>
          ) : (
            displayedTransactions.map((transaction) => {
              const transactionSplits =
                splitsByTransaction.get(transaction.id) ?? []
              const isSelected = transaction.id === selectedTransactionId
              return (
                <button
                  className={`transaction-row${
                    isSelected ? ' selected-transaction' : ''
                  }`}
                  key={transaction.id}
                  type="button"
                  onClick={() => selectTransaction(transaction)}
                >
                  <div className="transaction-main">
                    <strong>{transactionDescription(transaction)}</strong>
                    <p>
                      {new Intl.DateTimeFormat(undefined, {
                        day: 'numeric',
                        month: 'short',
                      }).format(new Date(`${transaction.transaction_date}T00:00:00`))}
                      {' · '}
                      {transaction.account_name}
                      {transaction.is_pending ? ' · Pending' : ''}
                    </p>
                  </div>
                  <strong
                    className={`transaction-amount ${
                      transaction.amount >= 0 ? 'positive' : 'negative'
                    }`}
                  >
                    {formatMoney(
                      transaction.amount,
                      transaction.currency_code ?? 'USD',
                    )}
                  </strong>
                  <span
                    className={`category-chip${
                      transactionSplits.length === 0 ? ' empty' : ''
                    }`}
                  >
                    {transactionSplits.length === 0
                      ? '+ Categorize'
                      : transactionSplits.length === 1
                        ? categoriesById.get(transactionSplits[0].category_id)
                            ?.name ?? '1 category'
                        : `${transactionSplits.length} categories`}
                  </span>
                </button>
              )
            })
          )}
        </section>

        <aside className="detail-panel" aria-live="polite">
          {!selectedTransaction ? (
            <div className="detail-panel__empty">
              <p className="eyebrow">Selected transaction</p>
              <h2>Choose a transaction</h2>
              <p className="subtle">
                Its category split will stay open here while you work.
              </p>
            </div>
          ) : (
            <>
              <p className="eyebrow">Selected transaction</p>
              <div className="section-head">
                <div>
                  <h2>{transactionDescription(selectedTransaction)}</h2>
                  <p className="subtle">
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'medium',
                    }).format(
                      new Date(`${selectedTransaction.transaction_date}T00:00:00`),
                    )}
                    {' · '}
                    {selectedTransaction.account_name}
                  </p>
                </div>
                <strong
                  className={
                    selectedTransaction.amount >= 0 ? 'positive' : 'negative'
                  }
                >
                  {formatMoney(
                    selectedTransaction.amount,
                    selectedTransaction.currency_code ?? 'USD',
                  )}
                </strong>
              </div>
              <h3 className="split-heading">Category split</h3>
              {draftSplits.map((split) => (
                <div
                  className="split-line"
                  key={`${split.key}-${split.categoryId}`}
                >
                  <CategoryCombobox
                    categories={categories}
                    disabled={isSavingSplits}
                    excludedCategoryIds={draftSplits
                      .filter((candidate) => candidate.key !== split.key)
                      .map((candidate) => candidate.categoryId)}
                    label={`${
                      categoriesById.get(split.categoryId)?.name ?? 'Category'
                    } category`}
                    selectedCategory={categoriesById.get(split.categoryId)}
                    onCreate={createCategory}
                    onSelect={(category) =>
                      changeSplitCategory(split.key, category)
                    }
                  />
                  <label>
                    <span className="sr-only">
                      {categoriesById.get(split.categoryId)?.name} amount
                    </span>
                    <input
                      aria-invalid={splitError ? 'true' : undefined}
                      disabled={isSavingSplits}
                      inputMode="decimal"
                      type="text"
                      value={split.amount}
                      onChange={(event) => {
                        setIsManualSplit(true)
                        setDraftSplits((current) =>
                          current.map((candidate) =>
                            candidate.key === split.key
                              ? { ...candidate, amount: event.target.value }
                              : candidate,
                          ),
                        )
                        setSplitError(null)
                      }}
                    />
                  </label>
                  <button
                    aria-label={`Remove ${
                      categoriesById.get(split.categoryId)?.name ?? 'category'
                    }`}
                    className="icon-button"
                    disabled={isSavingSplits}
                    type="button"
                    onClick={() => removeSplit(split.key)}
                  >
                    &times;
                  </button>
                </div>
              ))}
              {selectedTransaction.currency_code === 'USD' && (
                <div className="detail-category-add">
                  <CategoryCombobox
                    categories={categories}
                    disabled={isSavingSplits}
                    excludedCategoryIds={draftSplits.map(
                      (split) => split.categoryId,
                    )}
                    label="Add or create a split category"
                    placeholder="Search or create a category..."
                    onCreate={createCategory}
                    onSelect={addCategoryToSplit}
                  />
                </div>
              )}
              <p className="split-note">
                {isManualSplit
                  ? 'Amounts are manual. New categories receive the remaining amount.'
                  : 'Categories are evenly split; the final category receives any leftover cent.'}
              </p>
              {splitError && (
                <p className="form-message form-message--error" role="alert">
                  {splitError}
                </p>
              )}
              <button
                className="button detail-save"
                disabled={
                  isSavingSplits || selectedTransaction.currency_code !== 'USD'
                }
                type="button"
                onClick={() => void saveSplits()}
              >
                {isSavingSplits
                  ? 'Saving...'
                  : draftSplits.length === 0
                    ? 'Save as uncategorized'
                    : 'Done'}
              </button>
            </>
          )}
        </aside>
      </div>
    </main>
  )
}

function FilterChip({
  label,
  onRemove,
}: {
  label: string
  onRemove: () => void
}) {
  return (
    <span className="filter-chip">
      {label}
      <button aria-label={`Remove ${label} filter`} type="button" onClick={onRemove}>
        &times;
      </button>
    </span>
  )
}
