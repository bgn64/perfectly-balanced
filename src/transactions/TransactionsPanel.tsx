import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SetStateAction,
} from 'react'
import { useAuth } from '../auth/useAuth.ts'
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

type TransactionSort = 'date' | 'merchant' | 'amount'

const uncategorizedFilter = 'uncategorized'
const nonUsdCategoryMessage = 'Only USD transactions can be categorized.'

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
  const [editingTransactionId, setEditingTransactionId] = useState<
    string | null
  >(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [categoryNotice, setCategoryNotice] = useState<string | null>(null)
  const [isSavingCategories, setIsSavingCategories] = useState(false)
  const requestGeneration = useRef(0)
  const selectedTransactionIdRef = useRef<string | null>(null)
  const transactionButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const pickerSearchInputRef = useRef<HTMLInputElement>(null)

  const refreshTransactions = useCallback(async () => {
    const generation = ++requestGeneration.current
    try {
      const data = await queryTransactions()
      if (generation !== requestGeneration.current) {
        return false
      }
      setTransactions(data.transactions)
      setCategories(data.categories)
      setSplits(data.splits)
      setBudgets(data.budgets)
      if (!selectedTransactionIdRef.current && data.transactions[0]) {
        selectedTransactionIdRef.current = data.transactions[0].id
        setSelectedTransactionId(data.transactions[0].id)
      }
      setDataError(null)
      return true
    } catch (error) {
      if (generation === requestGeneration.current) {
        setDataError(
          error instanceof Error
            ? error.message
            : 'We could not load transactions.',
        )
      }
      return false
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

  const selectTransaction = useCallback((transaction: Transaction) => {
    selectedTransactionIdRef.current = transaction.id
    setSelectedTransactionId(transaction.id)
    setEditingTransactionId(null)
    setPickerError(null)
    setCategoryNotice(
      transaction.currency_code === 'USD' ? null : nonUsdCategoryMessage,
    )
  }, [])

  const focusPickerSearch = useCallback(() => {
    window.requestAnimationFrame(() => {
      pickerSearchInputRef.current?.focus({ preventScroll: true })
    })
  }, [])

  const openCategoryPicker = useCallback(
    (transaction: Transaction) => {
      selectTransaction(transaction)
      if (transaction.currency_code !== 'USD') {
        setEditingTransactionId(null)
        setCategoryNotice(nonUsdCategoryMessage)
        setPickerError(nonUsdCategoryMessage)
        return
      }
      if (editingTransactionId !== transaction.id) {
        setEditingTransactionId(transaction.id)
        setPickerError(null)
      }
      focusPickerSearch()
    },
    [editingTransactionId, focusPickerSearch, selectTransaction],
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
      if (event.defaultPrevented || event.altKey || event.metaKey) {
        return
      }
      if (isTextEntryTarget(event.target)) {
        return
      }

      const key = event.key.toLocaleLowerCase()
      const focusedTransactionRow =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLButtonElement>(
              '.transaction-row-simple__select',
            )
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
          focusedTransactionRow?.dataset.transactionId ?? selectedTransactionId
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

      if (key === 'c' && !event.ctrlKey && !event.shiftKey && selectedTransaction) {
        event.preventDefault()
        openCategoryPicker(selectedTransaction)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    displayedTransactions,
    openCategoryPicker,
    selectTransaction,
    selectedTransaction,
    selectedTransactionId,
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

  async function saveCategory(
    transaction: Transaction,
    category: Category,
  ): Promise<void> {
    if (transaction.id !== editingTransactionId) {
      return
    }
    if (transaction.currency_code !== 'USD') {
      setPickerError(nonUsdCategoryMessage)
      return
    }

    setIsSavingCategories(true)
    setPickerError(null)
    try {
      const { error } = await getSupabaseClient().rpc(
        'replace_transaction_category_splits',
        {
          p_transaction_id: transaction.id,
          p_splits: [{ category_id: category.id, amount: transaction.amount }],
        },
      )
      if (error) {
        setPickerError(error.message)
        return
      }
      const didRefresh = await refreshTransactions()
      if (!didRefresh) {
        setPickerError(
          'The category changes were saved, but transactions could not be refreshed.',
        )
        return
      }
      onTransactionsChanged()
      setEditingTransactionId(null)
    } catch (error) {
      setPickerError(
        error instanceof Error
          ? error.message
          : 'The category changes could not be saved.',
      )
    } finally {
      setIsSavingCategories(false)
    }
  }

  function cancelCategoryPicker(transactionId: string) {
    setEditingTransactionId(null)
    setPickerError(null)
    window.requestAnimationFrame(() => {
      transactionButtonRefs.current.get(transactionId)?.focus({
        preventScroll: true,
      })
    })
  }

  function toggleFilter(
    value: string,
    setFilters: Dispatch<SetStateAction<string[]>>,
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
          <label
            className="terminal-search"
            data-semantic-id="transactions-search-label"
            data-semantic-kind="search-label"
            data-semantic-region="workspace"
            data-semantic-status-label="Search transactions"
            htmlFor="merchant-search"
          >
            <span aria-hidden="true">/</span>
            <span className="sr-only">Search merchant name</span>
            <input
              data-semantic-id="transactions-search"
              data-semantic-kind="search-input"
              data-semantic-region="workspace"
              data-semantic-status-action="search-transactions"
              data-semantic-status-label="Search merchant name"
              id="merchant-search"
              placeholder="Search merchant name..."
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          {activeFilterCount > 0 && (
            <div
              className="active-filters toolbar-tokens"
              aria-label="Active filters"
            >
              {scopeFilter && (
                <FilterChip
                  label={scopeByKey.get(scopeFilter)?.label ?? scopeFilter}
                  semanticId={`transaction-filter-remove-${scopeFilter}`}
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
                  semanticId={`transaction-filter-remove-${filter}`}
                  onRemove={() => toggleFilter(filter, setCategoryFilters)}
                />
              ))}
            </div>
          )}
          <div className="toolbar-group transaction-tools">
            <details className="filter-wrap">
              <summary
                className="terminal-button pill-button"
                data-semantic-id="transactions-filter"
                data-semantic-kind="filter-summary"
                data-semantic-region="workspace"
                data-semantic-status-action="filter-transactions"
                data-semantic-status-label="Transaction filters"
              >
                Filter{activeFilterCount ? ` · ${activeFilterCount}` : ''}
              </summary>
              <div className="popover filter-popover">
                <h2>Budget or month</h2>
                {scopeOptions.map((option) => (
                  <label className="radio" key={option.key}>
                    <input
                      checked={scopeFilter === option.key}
                      data-semantic-id={`transaction-scope-${option.key}`}
                      data-semantic-kind="filter-option"
                      data-semantic-region="workspace"
                      data-semantic-status-action="filter-transactions"
                      data-semantic-status-label={option.label}
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
                    data-semantic-id="transaction-filter-uncategorized"
                    data-semantic-kind="filter-option"
                    data-semantic-region="workspace"
                    data-semantic-status-action="filter-transactions"
                    data-semantic-status-label="Uncategorized"
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
                      data-semantic-id={`transaction-filter-category-${category.id}`}
                      data-semantic-kind="filter-option"
                      data-semantic-region="workspace"
                      data-semantic-status-action="filter-transactions"
                      data-semantic-status-label={category.name}
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
              <summary
                className="terminal-button pill-button"
                data-semantic-id="transactions-sort"
                data-semantic-kind="sort-summary"
                data-semantic-region="workspace"
                data-semantic-status-action="sort-transactions"
                data-semantic-status-label="Transaction sort"
              >
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
                      data-semantic-id={`transaction-sort-${value}`}
                      data-semantic-kind="sort-option"
                      data-semantic-region="workspace"
                      data-semantic-status-action="sort-transactions"
                      data-semantic-status-label={label}
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

        <div className="transaction-column-head" aria-hidden="true">
          <span>Transaction</span>
          <span>Category</span>
          <span>Amount</span>
        </div>

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
              const categoryNames = transactionSplits.map(
                (split) =>
                  categoriesById.get(split.category_id)?.name ?? 'Unknown category',
              )
              const isSelected = transaction.id === selectedTransactionId
              const isEditing = transaction.id === editingTransactionId
              const isUsd = transaction.currency_code === 'USD'
              return (
                <div
                  className={`transaction-row-simple${
                    isSelected ? ' is-selected' : ''
                  }`}
                  key={transaction.id}
                >
                  <button
                    aria-pressed={isSelected}
                    className="transaction-row-simple__select"
                    data-semantic-id={`transaction-select-${transaction.id}`}
                    data-semantic-kind="transaction-selection"
                    data-semantic-region="workspace"
                    data-semantic-status-action="select-transaction"
                    data-semantic-status-label={transactionDescription(transaction)}
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
                    <span className="transaction-row-simple__name">
                      <strong>{transactionDescription(transaction)}</strong>
                      <span>
                        {new Intl.DateTimeFormat(undefined, {
                          day: 'numeric',
                          month: 'short',
                        }).format(
                          new Date(`${transaction.transaction_date}T00:00:00`),
                        )}
                        {' · '}
                        {transaction.account_name}
                        {transaction.is_pending ? ' · Pending' : ''}
                      </span>
                    </span>
                  </button>
                  {isEditing ? (
                    <CategorySingleSelectPicker
                      categories={categories}
                      disabled={isSavingCategories}
                      errorMessage={pickerError}
                      inputRef={pickerSearchInputRef}
                      transaction={transaction}
                      onCreate={createCategory}
                      onCancel={() => cancelCategoryPicker(transaction.id)}
                      onError={setPickerError}
                      onSelect={(category) => saveCategory(transaction, category)}
                    />
                  ) : (
                    <div className="transaction-category-cell">
                      <button
                        aria-label={
                          isUsd
                            ? `Choose a category for ${transactionDescription(transaction)}`
                            : nonUsdCategoryMessage
                        }
                        className={`category-chip${
                          transactionSplits.length === 0 ? ' empty' : ''
                        }`}
                        data-semantic-id={`transaction-category-${transaction.id}`}
                        data-semantic-kind="category-action"
                        data-semantic-region="workspace"
                        data-semantic-status-action={
                          isUsd ? 'edit-transaction-categories' : 'category-unavailable'
                        }
                        data-semantic-status-label={transactionDescription(transaction)}
                        disabled={!isUsd}
                        type="button"
                        onClick={() => openCategoryPicker(transaction)}
                      >
                        {transactionSplits.length === 0 ? (
                          '+ Categorize'
                        ) : (
                          <CategorySummary categoryNames={categoryNames} />
                        )}
                      </button>
                      {isSelected && !isUsd && categoryNotice && (
                        <span
                          className="form-message form-message--error"
                          role="status"
                        >
                          {categoryNotice}
                        </span>
                      )}
                    </div>
                  )}
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
                </div>
              )
            })
          )}
        </section>
      </section>
    </section>
  )
}

function CategorySummary({ categoryNames }: { categoryNames: string[] }) {
  return <span className="category-summary">{categoryNames.join(', ')}</span>
}

type ActivePickerOption = string | 'create' | null

function CategorySingleSelectPicker({
  categories,
  disabled,
  errorMessage,
  inputRef,
  transaction,
  onCreate,
  onCancel,
  onError,
  onSelect,
}: {
  categories: Category[]
  disabled: boolean
  errorMessage: string | null
  inputRef: RefObject<HTMLInputElement | null>
  transaction: Transaction
  onCreate: (name: string) => Promise<Category>
  onCancel: () => void
  onError: (error: string | null) => void
  onSelect: (category: Category) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [activeOption, setActiveOption] = useState<ActivePickerOption>(null)
  const [activeQuery, setActiveQuery] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchingCategories = useMemo(
    () =>
      normalizedQuery
        ? categories.filter((category) =>
            category.name.toLocaleLowerCase().includes(normalizedQuery),
          )
        : categories,
    [categories, normalizedQuery],
  )
  const canCreate =
    normalizedQuery.length > 0 &&
    !categories.some(
      (category) => category.name.trim().toLocaleLowerCase() === normalizedQuery,
    )
  const createOption: ActivePickerOption[] = canCreate ? ['create'] : []
  const pickerOptionIds: ActivePickerOption[] = [
    ...matchingCategories.map((category) => category.id),
    ...createOption,
  ]
  const activeOptionIsAvailable = pickerOptionIds.includes(activeOption)
  const effectiveActiveOption =
    activeQuery === normalizedQuery && activeOptionIsAvailable
      ? activeOption
      : (pickerOptionIds[0] ?? null)

  async function createFromQuery() {
    const name = query.trim()
    if (!name || !canCreate || disabled || isCreating) {
      return
    }
    setIsCreating(true)
    onError(null)
    try {
      const category = await onCreate(name)
      await onSelect(category)
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : 'The category could not be created.',
      )
    } finally {
      setIsCreating(false)
    }
  }

  function moveActiveOption(direction: 1 | -1) {
    if (pickerOptionIds.length === 0) {
      return
    }
    const activeIndex = pickerOptionIds.indexOf(effectiveActiveOption)
    const nextIndex =
      activeIndex === -1
        ? 0
        : Math.max(
            0,
            Math.min(pickerOptionIds.length - 1, activeIndex + direction),
          )
    setActiveOption(pickerOptionIds[nextIndex])
    setActiveQuery(normalizedQuery)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!disabled && !isCreating) {
        onCancel()
      }
      return
    }
    const movesDown =
      event.key === 'ArrowDown' ||
      (event.ctrlKey && !event.shiftKey && event.key.toLocaleLowerCase() === 'n')
    const movesUp =
      event.key === 'ArrowUp' ||
      (event.ctrlKey && !event.shiftKey && event.key.toLocaleLowerCase() === 'p')
    if (movesDown || movesUp) {
      event.preventDefault()
      moveActiveOption(movesDown ? 1 : -1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (effectiveActiveOption === 'create') {
        void createFromQuery()
        return
      }
      const category = matchingCategories.find(
        (candidate) => candidate.id === effectiveActiveOption,
      )
      if (category) {
        void onSelect(category)
      }
    }
  }

  const transactionLabel = transactionDescription(transaction)

  return (
    <div className="transaction-category-editor">
      <input
        aria-activedescendant={
          typeof effectiveActiveOption === 'string' &&
          effectiveActiveOption !== 'create'
            ? `transaction-category-picker-option-${transaction.id}-${effectiveActiveOption}`
            : undefined
        }
        aria-label={`Choose a category for ${transactionLabel}`}
        aria-controls={`transaction-category-picker-menu-${transaction.id}`}
        className="category-search-input"
        data-semantic-id={`transaction-category-picker-search-${transaction.id}`}
        data-semantic-kind="category-picker-search"
        data-semantic-region="workspace"
        data-semantic-status-action="search-transaction-categories"
        data-semantic-status-label={transactionLabel}
        disabled={disabled || isCreating}
        placeholder="Search categories"
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveQuery('')
          onError(null)
        }}
        onKeyDown={handleKeyDown}
      />
      <div
        aria-label={
          normalizedQuery
            ? `Categories matching ${query.trim()}`
            : 'All categories'
        }
        className="category-search-menu"
        id={`transaction-category-picker-menu-${transaction.id}`}
        role="listbox"
      >
        {matchingCategories.map((category) => {
          const isActive = category.id === effectiveActiveOption
          return (
            <button
              aria-selected={isActive}
              className={isActive ? 'is-highlighted' : ''}
              data-semantic-id={`transaction-category-picker-option-${transaction.id}-${category.id}`}
              data-semantic-kind="category-picker-option"
              data-semantic-region="workspace"
              data-semantic-status-action="select-transaction-category"
              data-semantic-status-label={`${transactionLabel}: ${category.name}`}
              disabled={disabled || isCreating}
              id={`transaction-category-picker-option-${transaction.id}-${category.id}`}
              key={category.id}
              role="option"
              type="button"
              onClick={() => void onSelect(category)}
            >
              {category.name}
            </button>
          )
        })}
        {canCreate && (
          <button
            className={`category-search-menu__create${
              effectiveActiveOption === 'create' ? ' is-highlighted' : ''
            }`}
            data-semantic-id={`transaction-category-picker-create-${transaction.id}`}
            data-semantic-kind="category-picker-create"
            data-semantic-region="workspace"
            data-semantic-status-action="create-transaction-category"
            data-semantic-status-label={`${transactionLabel}: ${query.trim()}`}
            disabled={disabled || isCreating}
            role="option"
            type="button"
            onClick={() => void createFromQuery()}
          >
          {`+ Create “${query.trim()}”`}
          </button>
        )}
      </div>
      {errorMessage && (
        <p className="form-message form-message--error" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  )
}

function FilterChip({
  label,
  semanticId,
  onRemove,
}: {
  label: string
  semanticId: string
  onRemove: () => void
}) {
  return (
    <span className="filter-token">
      {label}
      <button
        aria-label={`Remove ${label} filter`}
        data-semantic-id={semanticId}
        data-semantic-kind="filter-remove"
        data-semantic-region="workspace"
        data-semantic-status-action="remove-transaction-filter"
        data-semantic-status-label={label}
        type="button"
        onClick={onRemove}
      >
        &times;
      </button>
    </span>
  )
}
