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
  isTextEntryTarget,
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
  categoryId: string | null
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
  selectedMonth,
  onCategoriesChanged,
  onTransactionsChanged,
  onUncategorizedCountChange,
}: {
  categoriesRevision: number
  selectedMonth: string
  onCategoriesChanged: () => void
  onTransactionsChanged: () => void
  onUncategorizedCountChange: (count: number) => void
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
  const [focusedSplitKey, setFocusedSplitKey] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const selectedTransactionIdRef = useRef<string | null>(null)
  const transactionButtonRefs = useRef(
    new Map<string, HTMLButtonElement>(),
  )
  const splitCategoryInputRefs = useRef(
    new Map<string, HTMLInputElement>(),
  )
  const addCategoryInputRef = useRef<HTMLInputElement>(null)

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
  const uncategorizedTransactionCount = useMemo(
    () =>
      transactions.filter(
        (transaction) =>
          (splitsByTransaction.get(transaction.id) ?? []).length === 0,
      ).length,
    [splitsByTransaction, transactions],
  )
  const selectedMonthTransactionCount = useMemo(
    () =>
      transactions.filter(
        (transaction) => monthKey(transaction.transaction_date) === selectedMonth,
      ).length,
    [selectedMonth, transactions],
  )
  const categorizedTransactionCount =
    transactions.length - uncategorizedTransactionCount

  useEffect(() => {
    onUncategorizedCountChange(uncategorizedTransactionCount)
  }, [onUncategorizedCountChange, uncategorizedTransactionCount])
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
  const applicableBudget = selectedTransaction
    ? budgets.find(
        (candidate) =>
          monthKey(candidate.month) === monthKey(selectedTransaction.transaction_date),
      ) ?? null
    : null

  const selectTransaction = useCallback(
    (transaction: Transaction) => {
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
      setFocusedSplitKey(null)
    },
    [splitsByTransaction],
  )

  const quickCategorize = useCallback(
    (transaction: Transaction) => {
      selectTransaction(transaction)
      if (transaction.currency_code !== 'USD') {
        return
      }
      const key = window.crypto.randomUUID()
      setDraftSplits([
        {
          key,
          categoryId: null,
          amount: transaction.amount.toFixed(2),
        },
      ])
      setIsManualSplit(false)
      setFocusedSplitKey(key)
    },
    [selectTransaction],
  )

  useEffect(() => {
    function focusTransaction(transactionId: string) {
      window.requestAnimationFrame(() => {
        const button = transactionButtonRefs.current.get(transactionId)
        button?.focus({ preventScroll: true })
        button?.scrollIntoView({ block: 'nearest' })
      })
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.metaKey ||
        isTextEntryTarget(event.target)
      ) {
        return
      }

      const key = event.key.toLocaleLowerCase()
      const focusedTransactionRow =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLButtonElement>('.transaction-select')
          : null
      const direction =
        !event.ctrlKey && !event.shiftKey && key === 'j'
          ? 1
          : !event.ctrlKey && !event.shiftKey && key === 'k'
            ? -1
            : focusedTransactionRow && event.key === 'ArrowDown'
              ? 1
              : focusedTransactionRow && event.key === 'ArrowUp'
                ? -1
                : null
      if (direction !== null) {
        if (displayedTransactions.length === 0) {
          return
        }
        event.preventDefault()
        const originTransactionId =
          focusedTransactionRow?.dataset.transactionId ??
          selectedTransactionId
        const currentIndex = displayedTransactions.findIndex(
          (transaction) => transaction.id === originTransactionId,
        )
        const nextIndex =
          currentIndex === -1
            ? direction === 1
              ? 0
              : displayedTransactions.length - 1
            : Math.max(
                0,
                Math.min(
                  displayedTransactions.length - 1,
                  currentIndex + direction,
                ),
              )
        const transaction = displayedTransactions[nextIndex]
        if (transaction.id !== selectedTransactionId) {
          selectTransaction(transaction)
        }
        focusTransaction(transaction.id)
        return
      }

      if (
        key === 'c' &&
        !event.ctrlKey &&
        !event.shiftKey &&
        selectedTransaction?.currency_code === 'USD'
      ) {
        event.preventDefault()
        const transactionSplits =
          splitsByTransaction.get(selectedTransaction.id) ?? []
        if (transactionSplits.length === 0) {
          if (draftSplits.length === 0) {
            quickCategorize(selectedTransaction)
          } else {
            splitCategoryInputRefs.current.get(draftSplits[0].key)?.focus()
          }
        } else {
          addCategoryInputRef.current?.focus()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    displayedTransactions,
    draftSplits,
    quickCategorize,
    selectTransaction,
    selectedTransaction,
    selectedTransactionId,
    splitsByTransaction,
  ])

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

  async function createCategoryAndAddToBudget(name: string): Promise<Category> {
    if (!applicableBudget) {
      throw new Error('This transaction month does not have a budget.')
    }
    const { data, error } = await getSupabaseClient().rpc(
      'create_category_with_root_budget_allocation',
      {
        p_budget_id: applicableBudget.id,
        p_name: name.trim(),
      },
    )
    if (error) {
      throw new Error(
        error.code === '23505' ? 'Category names must be unique.' : error.message,
      )
    }
    if (
      !data ||
      typeof data !== 'object' ||
      !('id' in data) ||
      !('name' in data) ||
      typeof data.id !== 'string' ||
      typeof data.name !== 'string'
    ) {
      throw new Error('The created category could not be read.')
    }
    const category = { id: data.id, name: data.name }
    setCategories((current) =>
      [...current, category].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    )
    onCategoriesChanged()
    return category
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
    setFocusedSplitKey(null)
    setSplitError(null)
  }

  function validateSplits(transaction: Transaction): string | null {
    if (draftSplits.length === 0) {
      return null
    }
    if (draftSplits.some((split) => !split.categoryId)) {
      return 'Choose a category for every split.'
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
        p_splits: draftSplits.map((split) => {
          if (!split.categoryId) {
            throw new Error('Choose a category for every split.')
          }
          return {
            category_id: split.categoryId,
            amount: Number(split.amount),
          }
        }),
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
    <section className="page transactions-page transactions-page--terminal">
      <header className="workspace-head workspace-head--compact">
        <div>
          <p className="eyebrow">Transaction stream / all accounts</p>
          <h1>Transactions</h1>
          <p className="subtle">
            Search, filter, sort, and categorize every imported transaction from
            one simple queue.
          </p>
        </div>
        <span className="terminal-pill terminal-pill--warning">
          {uncategorizedTransactionCount} uncategorized
        </span>
      </header>

      {dataError && (
        <p className="form-message form-message--error" role="alert">
          {dataError}
        </p>
      )}

      <section className="summary" aria-label="Transaction overview">
        <div>
          <span>All activity</span>
          <strong>{transactions.length.toLocaleString()}</strong>
        </div>
        <div>
          <span>{formatMonth(selectedMonth)} activity</span>
          <strong>{selectedMonthTransactionCount.toLocaleString()}</strong>
        </div>
        <div>
          <span>Categorized</span>
          <strong className="available">
            {categorizedTransactionCount.toLocaleString()}
          </strong>
        </div>
        <div>
          <span>Needs review</span>
          <strong className="warning">
            {uncategorizedTransactionCount.toLocaleString()}
          </strong>
        </div>
      </section>

      <section
        className="budget-table transaction-table"
        aria-busy={isLoading}
        aria-labelledby="transactions-title"
      >
        <div className="table-head">
          <div>
            <p className="eyebrow">Imported activity</p>
            <h2 id="transactions-title">Every account, one queue</h2>
          </div>
        </div>
      <div className="data-toolbar">
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

      <div className="transaction-layout transaction-layout--stacked">
        <section className="transactions">
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
                <div
                  className={`transaction-row${
                    isSelected ? ' selected-transaction' : ''
                  }`}
                  key={transaction.id}
                >
                  <button
                    aria-pressed={isSelected}
                    className="transaction-select"
                    data-transaction-id={transaction.id}
                    ref={(button) => {
                      if (button) {
                        transactionButtonRefs.current.set(transaction.id, button)
                      } else {
                        transactionButtonRefs.current.delete(transaction.id)
                      }
                    }}
                    type="button"
                    onClick={() => selectTransaction(transaction)}
                  >
                    <div className="transaction-main">
                      <strong>{transactionDescription(transaction)}</strong>
                      <p>
                        {new Intl.DateTimeFormat(undefined, {
                          day: 'numeric',
                          month: 'short',
                        }).format(
                          new Date(`${transaction.transaction_date}T00:00:00`),
                        )}
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
                  </button>
                  <button
                    className={`category-chip${
                      transactionSplits.length === 0 ? ' empty' : ''
                    }`}
                    type="button"
                    onClick={() =>
                      transactionSplits.length === 0
                        ? quickCategorize(transaction)
                        : selectTransaction(transaction)
                    }
                  >
                    {transactionSplits.length === 0
                      ? '+ Categorize'
                      : transactionSplits.length === 1
                        ? categoriesById.get(transactionSplits[0].category_id)
                            ?.name ?? '1 category'
                        : `${transactionSplits.length} categories`}
                  </button>
                </div>
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
                    autoFocus={focusedSplitKey === split.key}
                    categories={categories}
                    disabled={isSavingSplits}
                    excludedCategoryIds={draftSplits
                      .filter((candidate) => candidate.key !== split.key)
                      .flatMap((candidate) =>
                        candidate.categoryId ? [candidate.categoryId] : [],
                      )}
                    label={`${
                      (split.categoryId
                        ? categoriesById.get(split.categoryId)?.name
                        : null) ?? 'Category'
                    } category`}
                    selectedCategory={
                      split.categoryId
                        ? categoriesById.get(split.categoryId)
                        : undefined
                    }
                    createAlternativeLabel={
                      applicableBudget
                        ? (name) => `+ Create “${name}” and add to budget`
                        : undefined
                    }
                    inputRef={(input) => {
                      if (input) {
                        splitCategoryInputRefs.current.set(split.key, input)
                      } else {
                        splitCategoryInputRefs.current.delete(split.key)
                      }
                    }}
                    onCreate={createCategory}
                    onCreateAlternative={
                      applicableBudget
                        ? createCategoryAndAddToBudget
                        : undefined
                    }
                    onCancel={
                      split.categoryId === null
                        ? () =>
                            setDraftSplits((current) =>
                              current.filter(
                                (candidate) => candidate.key !== split.key,
                              ),
                            )
                        : undefined
                    }
                    onSelect={(category) =>
                      changeSplitCategory(split.key, category)
                    }
                  />
                  <label>
                    <span className="sr-only">
                      {split.categoryId
                        ? categoriesById.get(split.categoryId)?.name
                        : 'Category'}{' '}
                      amount
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
                      (split.categoryId
                        ? categoriesById.get(split.categoryId)?.name
                        : null) ?? 'category'
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
                    ).filter(
                      (categoryId): categoryId is string => categoryId !== null,
                    )}
                    inputRef={addCategoryInputRef}
                    label="Add or create a split category"
                    placeholder="Search or create a category..."
                    onCreate={createCategory}
                    createAlternativeLabel={
                      applicableBudget
                        ? (name) => `+ Create “${name}” and add to budget`
                        : undefined
                    }
                    onCreateAlternative={
                      applicableBudget
                        ? createCategoryAndAddToBudget
                        : undefined
                    }
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
      </section>
    </section>
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
