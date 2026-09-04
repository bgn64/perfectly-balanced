import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useAuth } from '../auth/useAuth.ts'
import { CategoryCombobox } from '../finance/CategoryCombobox.tsx'
import type {
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
import { focusWithScrollComfort } from '../navigation/focus.ts'

interface TransactionsData {
  transactions: Transaction[]
  categories: Category[]
  splits: TransactionSplit[]
}

type TransactionSort =
  | 'newest'
  | 'oldest'
  | 'merchant'
  | 'amount-high'
  | 'amount-low'
type TransactionTimeRange =
  | 'current-month'
  | 'last-month'
  | 'last-3-months'
  | 'last-6-months'
  | 'this-year'
  | 'all-time'
type TransactionFilter =
  | 'categorized'
  | 'uncategorized'
  | 'included'
  | 'ignored'
type TransactionControlDialog = 'time' | 'filter' | 'sort'

const nonUsdCategoryMessage = 'Only USD transactions can be categorized.'
const transactionPageSize = 25
const timeRangeOptions: ReadonlyArray<{
  value: TransactionTimeRange
  label: string
  description: string
}> = [
  { value: 'current-month', label: 'Current month', description: 'Selected month' },
  { value: 'last-month', label: 'Last month', description: 'Previous month' },
  { value: 'last-3-months', label: 'Last 3 months', description: 'Selected month and previous 2' },
  { value: 'last-6-months', label: 'Last 6 months', description: 'Selected month and previous 5' },
  { value: 'this-year', label: 'This year', description: 'January through selected month' },
  { value: 'all-time', label: 'All time', description: 'All imported transactions' },
]
const sortOptions: ReadonlyArray<{
  value: TransactionSort
  label: string
  description: string
}> = [
  { value: 'newest', label: 'Newest first', description: 'Transaction date descending' },
  { value: 'oldest', label: 'Oldest first', description: 'Transaction date ascending' },
  { value: 'amount-high', label: 'Highest amount', description: 'Absolute amount descending' },
  { value: 'amount-low', label: 'Lowest amount', description: 'Absolute amount ascending' },
  { value: 'merchant', label: 'Merchant A-Z', description: 'Alphabetical by display name' },
]
const transactionFilterOptions: ReadonlyArray<{
  value: TransactionFilter
  label: string
  description: string
}> = [
  { value: 'uncategorized', label: 'Uncategorized', description: 'Needs a category' },
  { value: 'categorized', label: 'Categorized', description: 'Has one or more categories' },
  { value: 'included', label: 'Included', description: 'Contributes to budgets and reports' },
  { value: 'ignored', label: 'Ignored', description: 'Excluded from budgets and reports' },
]
const filterLabels: Record<TransactionFilter, string> = {
  categorized: 'Categorized',
  uncategorized: 'Uncategorized',
  included: 'Included',
  ignored: 'Ignored',
}

function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function isInTimeRange(
  transactionMonth: string,
  selectedMonth: string,
  timeRange: TransactionTimeRange,
): boolean {
  if (timeRange === 'all-time') {
    return true
  }
  if (timeRange === 'current-month') {
    return transactionMonth === selectedMonth
  }
  if (timeRange === 'last-month') {
    return transactionMonth === shiftMonth(selectedMonth, -1)
  }
  const firstMonth =
    timeRange === 'last-3-months'
      ? shiftMonth(selectedMonth, -2)
      : timeRange === 'last-6-months'
        ? shiftMonth(selectedMonth, -5)
        : `${selectedMonth.slice(0, 4)}-01`
  return transactionMonth >= firstMonth && transactionMonth <= selectedMonth
}

interface PendingIgnoredUpdate {
  desired: boolean
  persisted: boolean
}

interface PendingResultFocus {
  transactionId: string
  pageIndex: number
}

async function queryTransactions(): Promise<TransactionsData> {
  const client = getSupabaseClient()
  const [transactions, categoriesResult, splits] =
    await Promise.all([
      collectPages((afterId, limit) => {
        let query = client
          .from('transactions')
          .select(
            'id, plaid_item_id, transaction_date, merchant_name, transaction_name, amount, currency_code, is_pending, is_ignored, account_name',
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
    ])

  if (categoriesResult.error) {
    throw new Error(categoriesResult.error.message)
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
  }
}

export function TransactionsPanel({
  categoriesRevision,
  focusTransactionRequest,
  selectedMonth,
  onCategoriesChanged,
  onControlDialogChange,
  onSearchStateChange,
  onTransactionsChanged,
  onUncategorizedCountChange,
}: {
  categoriesRevision: number
  focusTransactionRequest: { transactionId: string; sequence: number } | null
  selectedMonth: string
  onCategoriesChanged: () => void
  onControlDialogChange: (dialog: TransactionControlDialog | null) => void
  onSearchStateChange: (isOpen: boolean, query: string) => void
  onTransactionsChanged: () => void
  onUncategorizedCountChange: (count: number) => void
}) {
  const { user } = useAuth()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [splits, setSplits] = useState<TransactionSplit[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [dataError, setDataError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [timeRange, setTimeRange] =
    useState<TransactionTimeRange>('current-month')
  const [transactionFilters, setTransactionFilters] = useState<
    TransactionFilter[]
  >([])
  const [draftTransactionFilters, setDraftTransactionFilters] = useState<
    TransactionFilter[]
  >([])
  const [sort, setSort] = useState<TransactionSort>('newest')
  const [controlDialog, setControlDialog] =
    useState<TransactionControlDialog | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedTransactionId, setSelectedTransactionId] = useState<
    string | null
  >(null)
  const [editingTransactionId, setEditingTransactionId] = useState<
    string | null
  >(null)
  const [categoryNotice, setCategoryNotice] = useState<string | null>(null)
  const [isSavingCategories, setIsSavingCategories] = useState(false)
  const requestGeneration = useRef(0)
  const selectedTransactionIdRef = useRef<string | null>(null)
  const transactionRowRefs = useRef(new Map<string, HTMLDivElement>())
  const pickerSearchInputRef = useRef<HTMLInputElement>(null)
  const transactionSearchInputRef = useRef<HTMLInputElement>(null)
  const searchOriginRef = useRef<HTMLElement | null>(null)
  const lastFocusedTransactionControlRef = useRef<HTMLElement | null>(null)
  const handledFocusRequestSequence = useRef(0)
  const ignoredUpdatesRef = useRef(new Map<string, PendingIgnoredUpdate>())
  const processingIgnoredUpdatesRef = useRef(false)
  const controlDialogRef = useRef<HTMLElement>(null)
  const controlDialogOriginRef = useRef<HTMLElement | null>(null)
  const filterButtonRef = useRef<HTMLButtonElement>(null)
  const pendingResultFocusRef = useRef<PendingResultFocus | null>(null)

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
  const activeTransactions = useMemo(
    () => transactions.filter((transaction) => !transaction.is_ignored),
    [transactions],
  )
  const ignoredTransactionCount = transactions.length - activeTransactions.length
  const uncategorizedTransactionCount = useMemo(
    () =>
      activeTransactions.filter(
        (transaction) =>
          (splitsByTransaction.get(transaction.id) ?? []).length === 0,
      ).length,
    [activeTransactions, splitsByTransaction],
  )
  const selectedMonthTransactionCount = useMemo(
    () =>
      activeTransactions.filter(
        (transaction) => monthKey(transaction.transaction_date) === selectedMonth,
      ).length,
    [activeTransactions, selectedMonth],
  )
  const categorizedTransactionCount =
    activeTransactions.length - uncategorizedTransactionCount

  useEffect(() => {
    onUncategorizedCountChange(uncategorizedTransactionCount)
  }, [onUncategorizedCountChange, uncategorizedTransactionCount])

  useEffect(() => {
    onSearchStateChange(isSearchOpen, searchQuery)
  }, [isSearchOpen, onSearchStateChange, searchQuery])

  useEffect(() => {
    onControlDialogChange(controlDialog)
  }, [controlDialog, onControlDialogChange])

  useEffect(() => {
    if (!controlDialog) {
      return
    }
    const animationFrame = window.requestAnimationFrame(() => {
      const checkedOption = controlDialogRef.current?.querySelector<HTMLElement>(
        '[data-control-checked="true"]',
      )
      const firstControl =
        checkedOption ??
        controlDialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)')
      firstControl?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [controlDialog])

  useEffect(
    () => () => {
      onSearchStateChange(false, '')
      onControlDialogChange(null)
    },
    [onControlDialogChange, onSearchStateChange],
  )

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A month change starts the result set at its first page.
    setCurrentPage(1)
  }, [selectedMonth])

  const displayedTransactions = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
    const fieldSearch = normalizedSearch.match(
      /^(merchant|account|category):\s*(.*)$/,
    )
    const categoryStateFilters = transactionFilters.filter(
      (filter) => filter === 'categorized' || filter === 'uncategorized',
    )
    const inclusionFilters = transactionFilters.filter(
      (filter) => filter === 'included' || filter === 'ignored',
    )
    const filtered = transactions.filter((transaction) => {
      const transactionMonth = monthKey(transaction.transaction_date)
      if (!isInTimeRange(transactionMonth, selectedMonth, timeRange)) {
        return false
      }
      const transactionSplits = splitsByTransaction.get(transaction.id) ?? []
      const categoryNames = transactionSplits.map(
        (split) => categoriesById.get(split.category_id)?.name ?? '',
      )
      const isCategorized = transactionSplits.length > 0
      if (
        categoryStateFilters.length === 1 &&
        ((categoryStateFilters[0] === 'categorized') !== isCategorized)
      ) {
        return false
      }
      if (
        inclusionFilters.length === 1 &&
        ((inclusionFilters[0] === 'ignored') !== transaction.is_ignored)
      ) {
        return false
      }
      if (!normalizedSearch) {
        return true
      }
      const searchValue = fieldSearch?.[2] ?? normalizedSearch
      const matchesMerchant = transactionDescription(transaction)
        .toLocaleLowerCase()
        .includes(searchValue)
      const matchesAccount = transaction.account_name
        .toLocaleLowerCase()
        .includes(searchValue)
      const matchesCategory = categoryNames.some((name) =>
        name.toLocaleLowerCase().includes(searchValue),
      )
      if (fieldSearch?.[1] === 'merchant') {
        return matchesMerchant
      }
      if (fieldSearch?.[1] === 'account') {
        return matchesAccount
      }
      if (fieldSearch?.[1] === 'category') {
        return matchesCategory
      }
      return matchesMerchant || matchesAccount || matchesCategory
    })

    return [...filtered].sort((left, right) => {
      if (sort === 'merchant') {
        return transactionDescription(left).localeCompare(
          transactionDescription(right),
        )
      }
      if (sort === 'amount-high') {
        return Math.abs(right.amount) - Math.abs(left.amount)
      }
      if (sort === 'amount-low') {
        return Math.abs(left.amount) - Math.abs(right.amount)
      }
      return sort === 'oldest'
        ? left.transaction_date.localeCompare(right.transaction_date)
        : right.transaction_date.localeCompare(left.transaction_date)
    })
  }, [
    categoriesById,
    searchQuery,
    selectedMonth,
    sort,
    splitsByTransaction,
    timeRange,
    transactionFilters,
    transactions,
  ])
  const totalPages = Math.max(
    1,
    Math.ceil(displayedTransactions.length / transactionPageSize),
  )
  const displayedPage = Math.min(currentPage, totalPages)
  const pageTransactions = useMemo(
    () =>
      displayedTransactions.slice(
        (displayedPage - 1) * transactionPageSize,
        displayedPage * transactionPageSize,
      ),
    [displayedPage, displayedTransactions],
  )
  const paginationItems = useMemo(() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1)
    }
    const pages = Array.from(
      new Set([
        1,
        totalPages,
        displayedPage - 1,
        displayedPage,
        displayedPage + 1,
      ]),
    )
      .filter((page) => page >= 1 && page <= totalPages)
      .sort((left, right) => left - right)
    const items: Array<number | string> = []
    for (const page of pages) {
      const previousPage = items.at(-1)
      if (
        typeof previousPage === 'number' &&
        page - previousPage > 1
      ) {
        items.push(`ellipsis-${previousPage}`)
      }
      items.push(page)
    }
    return items
  }, [displayedPage, totalPages])

  const selectedTransaction =
    transactions.find((transaction) => transaction.id === selectedTransactionId) ??
    null

  const selectTransaction = useCallback((transaction: Transaction) => {
    selectedTransactionIdRef.current = transaction.id
    setSelectedTransactionId(transaction.id)
    setEditingTransactionId(null)
    setCategoryNotice(
      transaction.currency_code === 'USD' ? null : nonUsdCategoryMessage,
    )
  }, [])

  const focusTransaction = useCallback((transactionId: string) => {
    window.requestAnimationFrame(() => {
      const row = transactionRowRefs.current.get(transactionId)
      if (row) {
        focusWithScrollComfort(row)
      }
    })
  }, [])

  useEffect(() => {
    const pendingFocus = pendingResultFocusRef.current
    if (!pendingFocus) {
      return
    }
    if (selectedTransactionIdRef.current !== pendingFocus.transactionId) {
      pendingResultFocusRef.current = null
      return
    }
    const retainedTransaction = pageTransactions.find(
      (transaction) => transaction.id === pendingFocus.transactionId,
    )
    const targetTransaction =
      retainedTransaction ??
      pageTransactions[
        Math.min(pendingFocus.pageIndex, pageTransactions.length - 1)
      ]
    pendingResultFocusRef.current = null
    if (currentPage !== displayedPage) {
      // oxlint-disable-next-line react/set-state-in-effect -- A mutation can remove the final row from the final page, requiring a page clamp.
      setCurrentPage(displayedPage)
    }
    if (targetTransaction) {
      selectTransaction(targetTransaction)
      focusTransaction(targetTransaction.id)
      return
    }
    selectedTransactionIdRef.current = null
    setSelectedTransactionId(null)
    window.requestAnimationFrame(() => {
      if (filterButtonRef.current) {
        focusWithScrollComfort(filterButtonRef.current)
      }
    })
  }, [
    currentPage,
    displayedPage,
    focusTransaction,
    pageTransactions,
    selectTransaction,
  ])

  useEffect(() => {
    if (
      !focusTransactionRequest ||
      focusTransactionRequest.sequence === handledFocusRequestSequence.current
    ) {
      return
    }
    const transaction = transactions.find(
      (candidate) => candidate.id === focusTransactionRequest.transactionId,
    )
    if (!transaction) {
      return
    }
    handledFocusRequestSequence.current = focusTransactionRequest.sequence
    // oxlint-disable-next-line react/set-state-in-effect -- A parent navigation request selects the matching transaction after its data loads.
    selectTransaction(transaction)
    focusTransaction(transaction.id)
  }, [focusTransaction, focusTransactionRequest, selectTransaction, transactions])

  const openSearch = useCallback((origin?: HTMLElement | null) => {
    const activeElement =
      origin ??
      searchOriginRef.current ??
      lastFocusedTransactionControlRef.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null)
    searchOriginRef.current = activeElement?.isConnected ? activeElement : null
    setIsSearchOpen(true)
    window.requestAnimationFrame(() =>
      transactionSearchInputRef.current?.focus({ preventScroll: true }),
    )
  }, [])

  const rememberSearchOrigin = useCallback((origin: EventTarget | null) => {
    if (origin instanceof HTMLElement && origin.isConnected) {
      searchOriginRef.current = origin
    }
  }, [])

  const rememberTransactionFocus = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      const target = event.target
      if (
        target.matches('.transaction-search-trigger, #merchant-search')
      ) {
        return
      }
      const transactionId = target.dataset.transactionId
      if (
        transactionId &&
        transactionId !== selectedTransactionIdRef.current
      ) {
        const transaction = transactions.find(
          (candidate) => candidate.id === transactionId,
        )
        if (transaction) {
          selectTransaction(transaction)
        }
      }
      lastFocusedTransactionControlRef.current = target
    },
    [selectTransaction, transactions],
  )

  const closeSearch = useCallback(() => {
    const origin = searchOriginRef.current
    searchOriginRef.current = null
    setSearchQuery('')
    setIsSearchOpen(false)
    window.requestAnimationFrame(() => {
      if (origin?.isConnected) {
        origin.focus({ preventScroll: true })
        return
      }
      if (selectedTransactionId) {
        focusTransaction(selectedTransactionId)
      }
    })
  }, [focusTransaction, selectedTransactionId])

  function focusFirstSearchResult() {
    const firstTransaction = displayedTransactions[0]
    if (!firstTransaction) {
      return
    }
    selectTransaction(firstTransaction)
    focusTransaction(firstTransaction.id)
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSearch()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      focusFirstSearchResult()
    }
  }

  const focusPickerSearch = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (pickerSearchInputRef.current) {
        focusWithScrollComfort(pickerSearchInputRef.current)
      }
    })
  }, [])

  const openCategoryPicker = useCallback(
    (transaction: Transaction) => {
      selectTransaction(transaction)
      if (transaction.currency_code !== 'USD') {
        setEditingTransactionId(null)
        setCategoryNotice(nonUsdCategoryMessage)
        return
      }
      if (editingTransactionId !== transaction.id) {
        setEditingTransactionId(transaction.id)
      }
      focusPickerSearch()
    },
    [editingTransactionId, focusPickerSearch, selectTransaction],
  )

  const processIgnoredUpdates = useCallback(async () => {
    if (processingIgnoredUpdatesRef.current) {
      return
    }
    processingIgnoredUpdatesRef.current = true
    try {
      while (ignoredUpdatesRef.current.size > 0) {
        const [transactionId, update] = ignoredUpdatesRef.current.entries().next()
          .value as [string, PendingIgnoredUpdate]
        try {
          while (update.persisted !== update.desired) {
            const nextState = update.desired
            const { error } = await getSupabaseClient().rpc(
              'set_transaction_ignored',
              {
                p_is_ignored: nextState,
                p_transaction_id: transactionId,
              },
            )
            if (error) {
              throw new Error(error.message)
            }
            update.persisted = nextState
          }
          onTransactionsChanged()
        } catch (error) {
          setTransactions((current) =>
            current.map((candidate) =>
              candidate.id === transactionId
                ? { ...candidate, is_ignored: update.persisted }
                : candidate,
            ),
          )
          setDataError(
            error instanceof Error
              ? error.message
              : 'The transaction status could not be saved.',
          )
        } finally {
          ignoredUpdatesRef.current.delete(transactionId)
        }
      }
    } finally {
      processingIgnoredUpdatesRef.current = false
    }
  }, [onTransactionsChanged])

  const toggleTransactionIgnored = useCallback(
    (transaction: Transaction) => {
      const currentUpdate = ignoredUpdatesRef.current.get(transaction.id)
      const desired = !(currentUpdate?.desired ?? transaction.is_ignored)
      if (currentUpdate) {
        currentUpdate.desired = desired
      } else {
        ignoredUpdatesRef.current.set(transaction.id, {
          desired,
          persisted: transaction.is_ignored,
        })
      }
      setDataError(null)
      pendingResultFocusRef.current = {
        transactionId: transaction.id,
        pageIndex: Math.max(
          0,
          pageTransactions.findIndex(
            (candidate) => candidate.id === transaction.id,
          ),
        ),
      }
      setTransactions((current) =>
        current.map((candidate) =>
          candidate.id === transaction.id
            ? { ...candidate, is_ignored: desired }
            : candidate,
        ),
      )
      void processIgnoredUpdates()
    },
    [pageTransactions, processIgnoredUpdates],
  )

  const removeTransactionFilter = useCallback(
    (filter: TransactionFilter) => {
      const filterIndex = transactionFilters.indexOf(filter)
      const remainingFilters = transactionFilters.filter(
        (candidate) => candidate !== filter,
      )
      setTransactionFilters(remainingFilters)
      setCurrentPage(1)
      window.requestAnimationFrame(() => {
        const nextFilter =
          remainingFilters[Math.min(filterIndex, remainingFilters.length - 1)]
        const nextControl = nextFilter
          ? document.querySelector<HTMLElement>(
              `[data-filter-value="${nextFilter}"]`,
            )
          : filterButtonRef.current
        if (nextControl) {
          focusWithScrollComfort(nextControl)
        }
      })
    },
    [transactionFilters],
  )

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.metaKey) {
        return
      }
      if (isTextEntryTarget(event.target)) {
        return
      }
      if (controlDialog) {
        return
      }

      const key = event.key.toLocaleLowerCase()
      if (event.key === 'Escape' && isSearchOpen) {
        event.preventDefault()
        closeSearch()
        return
      }
      if (key === '/' && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault()
        openSearch()
        return
      }
      const focusedFilter =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLButtonElement>('[data-filter-value]')
          : null
      if (key === 'd' && focusedFilter?.dataset.filterValue) {
        const filter = focusedFilter.dataset.filterValue as TransactionFilter
        if (transactionFilterOptions.some((option) => option.value === filter)) {
          event.preventDefault()
          removeTransactionFilter(filter)
          return
        }
      }

      const focusedTransactionId =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>(
              '[data-semantic-kind="transaction-row"]',
            )?.dataset.transactionId
          : null
      const actionTransaction = focusedTransactionId
        ? transactions.find(
            (transaction) => transaction.id === focusedTransactionId,
          ) ?? null
        : selectedTransaction

      if (key === 'c' && !event.ctrlKey && !event.shiftKey && actionTransaction) {
        event.preventDefault()
        openCategoryPicker(actionTransaction)
        return
      }

      if (key === 't' && !event.ctrlKey && !event.shiftKey && actionTransaction) {
        event.preventDefault()
        selectTransaction(actionTransaction)
        toggleTransactionIgnored(actionTransaction)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    closeSearch,
    controlDialog,
    isSearchOpen,
    openSearch,
    openCategoryPicker,
    removeTransactionFilter,
    selectTransaction,
    selectedTransaction,
    toggleTransactionIgnored,
    transactionFilters,
    transactions,
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
      throw new Error(nonUsdCategoryMessage)
    }

    setIsSavingCategories(true)
    try {
      const { error } = await getSupabaseClient().rpc(
        'replace_transaction_category_splits',
        {
          p_transaction_id: transaction.id,
          p_splits: [{ category_id: category.id, amount: transaction.amount }],
        },
      )
      if (error) {
        throw new Error(error.message)
      }
      if (selectedTransactionIdRef.current === transaction.id) {
        pendingResultFocusRef.current = {
          transactionId: transaction.id,
          pageIndex: Math.max(
            0,
            pageTransactions.findIndex(
              (candidate) => candidate.id === transaction.id,
            ),
          ),
        }
      }
      const didRefresh = await refreshTransactions()
      if (!didRefresh) {
        throw new Error(
          'The category changes were saved, but transactions could not be refreshed.',
        )
      }
      onTransactionsChanged()
      setEditingTransactionId((current) =>
        current === transaction.id ? null : current,
      )
    } catch (error) {
      pendingResultFocusRef.current = null
      throw error
    } finally {
      setIsSavingCategories(false)
    }
  }

  function cancelCategoryPicker(transactionId: string) {
    setEditingTransactionId(null)
    focusTransaction(transactionId)
  }

  function toggleDraftFilter(value: TransactionFilter) {
    setDraftTransactionFilters((current) =>
      current.includes(value)
        ? current.filter((filter) => filter !== value)
        : [...current, value],
    )
  }

  const closeControlDialog = useCallback(() => {
    const origin = controlDialogOriginRef.current
    controlDialogOriginRef.current = null
    setControlDialog(null)
    window.requestAnimationFrame(() => {
      if (origin?.isConnected) {
        focusWithScrollComfort(origin)
      }
    })
  }, [])

  function openControlDialog(
    dialog: TransactionControlDialog,
    origin: HTMLElement,
  ) {
    controlDialogOriginRef.current = origin
    if (dialog === 'filter') {
      setDraftTransactionFilters(transactionFilters)
    }
    setControlDialog(dialog)
  }

  function handleControlDialogKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeControlDialog()
      event.stopPropagation()
    }
  }

  function selectTimeRange(value: TransactionTimeRange) {
    setTimeRange(value)
    setCurrentPage(1)
    closeControlDialog()
  }

  function selectSort(value: TransactionSort) {
    setSort(value)
    setCurrentPage(1)
    closeControlDialog()
  }

  function applyTransactionFilters() {
    setTransactionFilters(draftTransactionFilters)
    setCurrentPage(1)
    closeControlDialog()
  }

  const activeFilterCount = transactionFilters.length
  const timeRangeLabel =
    timeRangeOptions.find((option) => option.value === timeRange)?.label ??
    'Current month'
  const sortLabel =
    sortOptions.find((option) => option.value === sort)?.label ?? 'Newest first'

  return (
    <section
      className="page transactions-page transactions-page--terminal"
      onFocusCapture={rememberTransactionFocus}
    >
      <header className="workspace-head workspace-head--compact">
        <div>
          <p className="eyebrow">Transaction stream / all accounts</p>
          <h1>Transactions</h1>
          <p className="subtle">
            Search, filter, sort, and categorize every imported transaction from
            one simple queue.
          </p>
        </div>
        <div className="transaction-state-pills">
          <span className="terminal-pill terminal-pill--warning">
            {uncategorizedTransactionCount} uncategorized
          </span>
          {ignoredTransactionCount > 0 && (
            <span className="terminal-pill terminal-pill--muted">
              {ignoredTransactionCount} ignored
            </span>
          )}
        </div>
      </header>

      {dataError && (
        <p className="form-message form-message--error" role="alert">
          {dataError}
        </p>
      )}

      <section className="summary" aria-label="Active transaction overview">
        <div>
          <span>{ignoredTransactionCount > 0 ? 'Active activity' : 'All activity'}</span>
          <strong>{activeTransactions.length.toLocaleString()}</strong>
        </div>
        <div>
          <span>
            {formatMonth(selectedMonth)}
            {ignoredTransactionCount > 0 ? ' active' : ' activity'}
          </span>
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
        <div className="data-toolbar transaction-toolbar-v2">
          <div className="transaction-toolbar-primary">
            {isSearchOpen ? (
              <label
                className="terminal-search transaction-query-field"
                htmlFor="merchant-search"
              >
                <span aria-hidden="true">/</span>
                <span className="sr-only">
                  Search merchant, account, or category
                </span>
                <input
                  id="merchant-search"
                  placeholder="Search merchant, account, or category"
                  ref={transactionSearchInputRef}
                  type="search"
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value)
                    setCurrentPage(1)
                  }}
                  onKeyDown={handleSearchKeyDown}
                />
              </label>
            ) : (
              <button
                aria-keyshortcuts="/"
                aria-label="Search merchant, account, or category"
                className="terminal-button transaction-search-trigger"
                tabIndex={-1}
                type="button"
                onMouseDown={() => rememberSearchOrigin(document.activeElement)}
                onClick={(event) => openSearch(event.currentTarget)}
              >
                <kbd>/</kbd> Search merchant, account, or category
              </button>
            )}
            <button
              className="terminal-button transaction-tool-button"
              data-semantic-id="transactions-time"
              data-semantic-kind="transaction-control"
              data-semantic-region="workspace"
              data-status-action="choose time range"
              data-status-label={`transactions / time / ${timeRangeLabel.toLocaleLowerCase()}`}
              type="button"
              onClick={(event) => openControlDialog('time', event.currentTarget)}
            >
              Time <span>{timeRangeLabel}</span>
            </button>
            <button
              className="terminal-button transaction-tool-button"
              data-semantic-id="transactions-filter"
              data-semantic-kind="transaction-control"
              data-semantic-region="workspace"
              data-status-action="filter transactions"
              data-status-label="transactions / filters"
              ref={filterButtonRef}
              type="button"
              onClick={(event) => openControlDialog('filter', event.currentTarget)}
            >
              Filter <span>{activeFilterCount || 'None'}</span>
            </button>
            <button
              className="terminal-button transaction-tool-button"
              data-semantic-id="transactions-sort"
              data-semantic-kind="transaction-control"
              data-semantic-region="workspace"
              data-status-action="sort transactions"
              data-status-label={`transactions / sort / ${sortLabel.toLocaleLowerCase()}`}
              type="button"
              onClick={(event) => openControlDialog('sort', event.currentTarget)}
            >
              Sort <span>{sortLabel}</span>
            </button>
          </div>
          <span className="transaction-result-count">
            {displayedTransactions.length.toLocaleString()} results
          </span>
          {activeFilterCount > 0 && (
            <div
              className="transaction-active-filter-row"
              aria-label="Active filters"
            >
              <span className="transaction-filter-label">Active</span>
              {transactionFilters.map((filter) => (
                <button
                  className="filter-token"
                  data-filter-value={filter}
                  data-semantic-id={`transaction-filter-${filter}`}
                  data-semantic-kind="filter-remove"
                  data-semantic-region="workspace"
                  data-status-action="edit filters"
                  data-status-label={`transactions / filter / ${filterLabels[filter].toLocaleLowerCase()}`}
                  key={filter}
                  type="button"
                  onClick={(event) =>
                    openControlDialog('filter', event.currentTarget)
                  }
                >
                  {filterLabels[filter]} <span aria-hidden="true">×</span>
                </button>
              ))}
              <button
                className="transaction-clear-filters"
                data-semantic-id="transaction-filter-clear"
                data-semantic-kind="filter-clear"
                data-semantic-region="workspace"
                data-status-action="clear filters"
                data-status-label="transactions / filters"
                type="button"
                onClick={() => {
                  setTransactionFilters([])
                  setCurrentPage(1)
                }}
              >
                Clear all
              </button>
            </div>
          )}
        </div>

        <div className="transaction-column-head" aria-hidden="true">
          <span>Transaction</span>
          <span>Category</span>
          <span>Status</span>
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
            pageTransactions.map((transaction) => {
              const transactionSplits =
                splitsByTransaction.get(transaction.id) ?? []
              const categoryNames = transactionSplits.map(
                (split) =>
                  categoriesById.get(split.category_id)?.name ?? 'Unknown category',
              )
              const isEditing = transaction.id === editingTransactionId
              const isSelected = isEditing
              const isUsd = transaction.currency_code === 'USD'
              return (
                <div
                  aria-current={isSelected ? 'true' : undefined}
                  className={`transaction-row-simple${
                    isSelected ? ' is-selected' : ''
                  }${
                    transaction.is_ignored ? ' is-ignored' : ''
                  }`}
                  data-semantic-id={`transaction-row-${transaction.id}`}
                  data-semantic-kind="transaction-row"
                  data-semantic-region="workspace"
                  data-status-action="select transaction"
                  data-status-label={`transaction / ${transactionDescription(transaction)}`}
                  data-transaction-id={transaction.id}
                  key={transaction.id}
                  ref={(row) => {
                    if (row) {
                      transactionRowRefs.current.set(transaction.id, row)
                    } else {
                      transactionRowRefs.current.delete(transaction.id)
                    }
                  }}
                  tabIndex={0}
                  onFocus={(event) => {
                    if (event.target === event.currentTarget) {
                      selectTransaction(transaction)
                    }
                  }}
                  onClick={(event) => {
                    if (event.target === event.currentTarget) {
                      selectTransaction(transaction)
                    }
                  }}
                >
                  <button
                    className="transaction-row-simple__select"
                    data-transaction-id={transaction.id}
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
                    <CategoryCombobox
                      autoFocus
                      categories={categories}
                      className="transaction-category-editor"
                      disabled={isSavingCategories}
                      inputRef={pickerSearchInputRef}
                      label={`Choose a category for ${transactionDescription(transaction)}`}
                      menuLabel={(query) =>
                        query.trim()
                          ? `Categories matching ${query.trim()}`
                          : 'All categories'
                      }
                      placeholder="Search categories"
                      semanticContext={{
                        createAction: 'create-transaction-category',
                        idPrefix: `transaction-category-picker-${transaction.id}`,
                        inputAction: 'search categories',
                        optionAction: 'select category',
                        statusLabel: `transaction / ${transactionDescription(transaction)} / category`,
                      }}
                      onCreate={createCategory}
                      onCancel={() => cancelCategoryPicker(transaction.id)}
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
                        data-status-action={
                          isUsd ? 'edit categories' : 'category unavailable'
                        }
                        data-status-label={transactionDescription(transaction)}
                        data-transaction-id={transaction.id}
                        disabled={!isUsd}
                        type="button"
                        onClick={() => openCategoryPicker(transaction)}
                      >
                        {transactionSplits.length === 0 ? (
                          'Select category...'
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
                  <button
                    aria-label={`${
                      transaction.is_ignored ? 'Ignored' : 'Included'
                    } transaction: ${transactionDescription(transaction)}`}
                    className={`transaction-state-button${
                      transaction.is_ignored ? ' is-ignored' : ''
                    }`}
                    data-status-action="toggle status"
                    data-status-label={`transaction / ${transactionDescription(transaction)}`}
                    data-transaction-id={transaction.id}
                    type="button"
                    onClick={() => {
                      selectTransaction(transaction)
                      toggleTransactionIgnored(transaction)
                    }}
                  >
                    {transaction.is_ignored ? 'Ignored' : 'Included'}
                  </button>
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
        {!isLoading && displayedTransactions.length > 0 && (
          <nav className="transaction-pagination" aria-label="Transaction pages">
            <span className="transaction-page-summary">
              Showing{' '}
              {((displayedPage - 1) * transactionPageSize + 1).toLocaleString()}
              –
              {Math.min(
                displayedPage * transactionPageSize,
                displayedTransactions.length,
              ).toLocaleString()}{' '}
              of {displayedTransactions.length.toLocaleString()}
            </span>
            <div className="transaction-page-controls">
              <button
                aria-label="Previous page"
                className="terminal-button"
                data-semantic-id="transactions-page-previous"
                data-semantic-kind="pagination"
                data-semantic-region="workspace"
                data-status-action="previous page"
                data-status-label="transactions / pages"
                disabled={displayedPage === 1}
                type="button"
                onClick={() => setCurrentPage(displayedPage - 1)}
              >
                ←
              </button>
              {paginationItems.map((item) =>
                typeof item === 'number' ? (
                  <button
                    aria-current={item === displayedPage ? 'page' : undefined}
                    className={`terminal-button${
                      item === displayedPage ? ' is-current' : ''
                    }`}
                    data-semantic-id={`transactions-page-${item}`}
                    data-semantic-kind="pagination"
                    data-semantic-region="workspace"
                    data-status-action="go to page"
                    data-status-label={`transactions / page ${item}`}
                    key={item}
                    type="button"
                    onClick={() => setCurrentPage(item)}
                  >
                    {item}
                  </button>
                ) : (
                  <span aria-hidden="true" key={item}>…</span>
                ),
              )}
              <button
                aria-label="Next page"
                className="terminal-button"
                data-semantic-id="transactions-page-next"
                data-semantic-kind="pagination"
                data-semantic-region="workspace"
                data-status-action="next page"
                data-status-label="transactions / pages"
                disabled={displayedPage === totalPages}
                type="button"
                onClick={() => setCurrentPage(displayedPage + 1)}
              >
                →
              </button>
            </div>
          </nav>
        )}
      </section>
      {controlDialog && (
        <div
          className="transaction-control-layer"
          role="presentation"
          onKeyDown={handleControlDialogKeyDown}
        >
          <section
            aria-labelledby={`transaction-${controlDialog}-dialog-title`}
            aria-modal="true"
            className={`transaction-control-dialog transaction-${controlDialog}-dialog`}
            ref={controlDialogRef}
            role="dialog"
          >
            <header className="transaction-dialog-head">
              <div>
                <p className="eyebrow">Transactions</p>
                <h2 id={`transaction-${controlDialog}-dialog-title`}>
                  {controlDialog === 'time'
                    ? 'Time range'
                    : controlDialog === 'filter'
                      ? 'Filter transactions'
                      : 'Sort transactions'}
                </h2>
              </div>
              <span>
                {controlDialog === 'time'
                  ? timeRangeLabel
                  : controlDialog === 'filter'
                    ? `${draftTransactionFilters.length} selected`
                    : sortLabel}
              </span>
            </header>
            {controlDialog === 'time' && (
              <div className="transaction-time-options">
                {timeRangeOptions.map((option) => {
                  const isChecked = option.value === timeRange
                  return (
                    <button
                      aria-checked={isChecked}
                      className={`transaction-option${
                        isChecked ? ' is-checked' : ''
                      }`}
                      data-control-checked={isChecked}
                      data-semantic-id={`transaction-time-${option.value}`}
                      data-semantic-kind="dialog-option"
                      data-semantic-region="workspace"
                      data-status-action="select and close"
                      data-status-label={`transactions / time / ${option.label.toLocaleLowerCase()}`}
                      key={option.value}
                      role="radio"
                      type="button"
                      onClick={() => selectTimeRange(option.value)}
                    >
                      <i aria-hidden="true" />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {controlDialog === 'filter' && (
              <div className="transaction-simple-filter-options">
                {(['Category state', 'Inclusion status'] as const).map(
                  (group, groupIndex) => (
                    <section key={group}>
                      <p className="eyebrow">{group}</p>
                      {transactionFilterOptions
                        .slice(groupIndex * 2, groupIndex * 2 + 2)
                        .map((option) => {
                          const isChecked = draftTransactionFilters.includes(
                            option.value,
                          )
                          return (
                            <button
                              aria-checked={isChecked}
                              className={`transaction-option${
                                isChecked ? ' is-checked' : ''
                              }`}
                              data-control-checked={isChecked}
                              data-semantic-id={`transaction-filter-option-${option.value}`}
                              data-semantic-kind="dialog-option"
                              data-semantic-region="workspace"
                              data-status-action="toggle filter"
                              data-status-label={`transactions / filter / ${option.label.toLocaleLowerCase()}`}
                              key={option.value}
                              role="checkbox"
                              type="button"
                              onClick={() => toggleDraftFilter(option.value)}
                            >
                              <i aria-hidden="true">{isChecked ? '✓' : ''}</i>
                              <span>
                                <strong>{option.label}</strong>
                                <small>{option.description}</small>
                              </span>
                            </button>
                          )
                        })}
                    </section>
                  ),
                )}
              </div>
            )}
            {controlDialog === 'sort' && (
              <div className="transaction-sort-options">
                {sortOptions.map((option) => {
                  const isChecked = option.value === sort
                  return (
                    <button
                      aria-checked={isChecked}
                      className={`transaction-option${
                        isChecked ? ' is-checked' : ''
                      }`}
                      data-control-checked={isChecked}
                      data-semantic-id={`transaction-sort-${option.value}`}
                      data-semantic-kind="dialog-option"
                      data-semantic-region="workspace"
                      data-status-action="select and close"
                      data-status-label={`transactions / sort / ${option.label.toLocaleLowerCase()}`}
                      key={option.value}
                      role="radio"
                      type="button"
                      onClick={() => selectSort(option.value)}
                    >
                      <i aria-hidden="true" />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {controlDialog === 'filter' && (
              <footer className="transaction-dialog-actions">
                <button
                  className="terminal-button"
                  data-semantic-id="transaction-filter-clear-draft"
                  data-semantic-kind="dialog-action"
                  data-semantic-region="workspace"
                  type="button"
                  onClick={() => setDraftTransactionFilters([])}
                >
                  Clear all
                </button>
                <span />
                <button
                  className="terminal-button"
                  data-semantic-id="transaction-filter-cancel"
                  data-semantic-kind="dialog-action"
                  data-semantic-region="workspace"
                  type="button"
                  onClick={closeControlDialog}
                >
                  Cancel
                </button>
                <button
                  className="terminal-button terminal-button--primary"
                  data-semantic-id="transaction-filter-apply"
                  data-semantic-kind="dialog-action"
                  data-semantic-region="workspace"
                  type="button"
                  onClick={applyTransactionFilters}
                >
                  Apply filters
                </button>
              </footer>
            )}
          </section>
        </div>
      )}
    </section>
  )
}

function CategorySummary({ categoryNames }: { categoryNames: string[] }) {
  return <span className="category-summary">{categoryNames.join(', ')}</span>
}
