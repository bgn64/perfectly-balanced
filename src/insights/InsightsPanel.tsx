import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Budget,
  BudgetAllocation,
  BudgetDirection,
  BudgetSubsection,
  Category,
  Transaction,
  TransactionSplit,
} from '../finance/types.ts'
import {
  formatDisplayMoney,
  formatMonth,
  monthKey,
  shiftMonth,
} from '../finance/utils.ts'
import { collectPages } from '../finance/query.ts'
import { getSupabaseClient } from '../lib/supabase.ts'

type InsightMode = 'all' | 'categorized' | 'planned'

interface InsightsData {
  budgets: Budget[]
  budget: Budget | null
  subsections: BudgetSubsection[]
  allocations: BudgetAllocation[]
  categories: Category[]
  transactions: Transaction[]
  splits: TransactionSplit[]
}

interface InsightSlice {
  id: string
  label: string
  value: number
}

interface CategoryInsight {
  id: string
  label: string
  value: number
  netActivity: number
}

interface VarianceItem {
  id: string
  name: string
  planned: number
  spent: number
  variance: number
}

const chartColors = ['#356b5b', '#7cae9e', '#d7a95b', '#9c8273', '#91a39d']

async function queryInsights(month: string): Promise<InsightsData> {
  const client = getSupabaseClient()
  const nextMonth = shiftMonth(month, 1)
  const [budgetsResult, categoriesResult, transactions] = await Promise.all([
    client.from('budgets').select('id, month').order('month', { ascending: false }),
    client.from('categories').select('id, name').order('name'),
    collectPages((afterId, limit) => {
      let query = client
        .from('transactions')
        .select(
          'id, plaid_item_id, transaction_date, merchant_name, transaction_name, amount, currency_code, is_pending, account_name',
        )
        .gte('transaction_date', `${month}-01`)
        .lt('transaction_date', `${nextMonth}-01`)
        .eq('currency_code', 'USD')
        .order('id')
        .limit(limit)
      if (afterId) {
        query = query.gt('id', afterId)
      }
      return query
    }),
  ])

  for (const result of [budgetsResult, categoriesResult]) {
    if (result.error) {
      throw new Error(result.error.message)
    }
  }

  const budgets = budgetsResult.data ?? []
  const budget =
    budgets.find((candidate) => monthKey(candidate.month) === month) ?? null
  const normalizedTransactions = transactions.map((transaction) => ({
    ...transaction,
    amount: Number(transaction.amount),
  }))
  const transactionIds = normalizedTransactions.map(
    (transaction) => transaction.id,
  )
  const transactionIdSet = new Set(transactionIds)

  const [subsectionsResult, allocationsResult, splitsResult] = await Promise.all([
    budget
      ? client
          .from('budget_subsections')
          .select('id, name, position')
          .eq('budget_id', budget.id)
          .order('position')
      : Promise.resolve({ data: [], error: null }),
    budget
      ? client
          .from('budget_category_activity')
          .select(
            'allocation_id, category_id, category_name, subsection_id, subsection_name, position, direction, budgeted_amount, actual_amount',
          )
          .eq('budget_id', budget.id)
          .order('position')
      : Promise.resolve({ data: [], error: null }),
    transactionIds.length > 0
      ? collectPages((afterId, limit) => {
          let query = client
            .from('transaction_category_splits')
            .select('id, transaction_id, category_id, amount')
            .order('id')
            .limit(limit)
          if (afterId) {
            query = query.gt('id', afterId)
          }
          return query
        })
      : Promise.resolve([]),
  ])

  for (const result of [subsectionsResult, allocationsResult]) {
    if (result.error) {
      throw new Error(result.error.message)
    }
  }

  return {
    budgets,
    budget,
    subsections: subsectionsResult.data ?? [],
    allocations: (allocationsResult.data ?? []).map((allocation) => ({
      ...allocation,
      budgeted_amount: Number(allocation.budgeted_amount),
      actual_amount: Number(allocation.actual_amount),
    })) as BudgetAllocation[],
    categories: categoriesResult.data ?? [],
    transactions: normalizedTransactions,
    splits: splitsResult
      .filter((split) => transactionIdSet.has(split.transaction_id))
      .map((split) => ({
      ...split,
      amount: Number(split.amount),
      })),
  }
}

export function InsightsPanel({
  categoriesRevision,
  activityRevision,
  selectedMonth,
  onMonthChange,
  onOpenTransactions,
}: {
  categoriesRevision: number
  activityRevision: number
  selectedMonth: string
  onMonthChange: (month: string) => void
  onOpenTransactions: () => void
}) {
  const [data, setData] = useState<InsightsData>({
    budgets: [],
    budget: null,
    subsections: [],
    allocations: [],
    categories: [],
    transactions: [],
    splits: [],
  })
  const [incomeMode, setIncomeMode] = useState<InsightMode>('all')
  const [spendingMode, setSpendingMode] = useState<InsightMode>('all')
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const requestGeneration = useRef(0)

  const loadInsights = useCallback(async () => {
    const generation = ++requestGeneration.current
    try {
      const nextData = await queryInsights(selectedMonth)
      if (generation !== requestGeneration.current) {
        return
      }
      setData(nextData)
      setErrorMessage(null)
    } catch (error) {
      if (generation === requestGeneration.current) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'We could not load monthly insights.',
        )
      }
    } finally {
      if (generation === requestGeneration.current) {
        setIsLoading(false)
      }
    }
  }, [selectedMonth])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect synchronizes the selected month with Supabase.
    void loadInsights()
    return () => {
      requestGeneration.current += 1
    }
  }, [activityRevision, categoriesRevision, loadInsights])

  const activityByCategory = useMemo(() => {
    const values = new Map<string, number>()
    for (const split of data.splits) {
      values.set(
        split.category_id,
        (values.get(split.category_id) ?? 0) + split.amount,
      )
    }
    return values
  }, [data.splits])
  const transactionIdsWithSplits = useMemo(
    () => new Set(data.splits.map((split) => split.transaction_id)),
    [data.splits],
  )
  const allocationsByCategory = useMemo(
    () =>
      new Map(
        data.allocations.map((allocation) => [
          allocation.category_id,
          allocation,
        ]),
      ),
    [data.allocations],
  )
  const categoriesById = useMemo(
    () => new Map(data.categories.map((category) => [category.id, category])),
    [data.categories],
  )
  const selectorMonths = Array.from(
    new Set([
      selectedMonth,
      ...data.budgets.map((budget) => monthKey(budget.month)),
    ]),
  ).sort((left, right) => right.localeCompare(left))
  function changeMonth(month: string) {
    setIsLoading(true)
    onMonthChange(month)
  }

  const overBudget = data.allocations
    .filter((allocation) => allocation.direction === 'spending')
    .map(toVarianceItem)
    .filter((item) => item.variance > 0)
    .sort((left, right) => right.variance - left.variance)
  const underBudget = data.allocations
    .filter((allocation) => allocation.direction === 'spending')
    .map(toVarianceItem)
    .filter((item) => item.variance < 0)
    .sort((left, right) => left.variance - right.variance)
  const received = data.transactions
    .filter((transaction) => transaction.amount > 0)
    .reduce((sum, transaction) => sum + transaction.amount, 0)
  const spent = data.transactions
    .filter((transaction) => transaction.amount < 0)
    .reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0)
  const plannedSpending = data.allocations
    .filter((allocation) => allocation.direction === 'spending')
    .reduce(
      (sum, allocation) => sum + Math.abs(allocation.budgeted_amount),
      0,
    )
  const uncategorizedTransactionCount = data.transactions.filter(
    (transaction) => !transactionIdsWithSplits.has(transaction.id),
  ).length

  return (
    <section className="page insights-page insights-page--terminal">
      <header className="workspace-head workspace-head--compact">
        <div>
          <p className="eyebrow">Reports / {selectedMonth.replace('-', ' / ')}</p>
          <h1>{formatMonth(selectedMonth)} at a glance</h1>
          <p className="subtle">
            A compact readout of how this month is tracking against your plan.
          </p>
        </div>
        <div className="toolbar-group month-toolbar">
          <button
            aria-label="Previous month"
            className="icon-button"
            type="button"
            onClick={() => changeMonth(shiftMonth(selectedMonth, -1))}
          >
            &larr;
          </button>
          <label className="sr-only" htmlFor="insights-month-selector">
            Insights month
          </label>
          <select
            className="pill-select"
            id="insights-month-selector"
            value={selectedMonth}
            onChange={(event) => changeMonth(event.target.value)}
          >
            {selectorMonths.map((month) => (
              <option key={month} value={month}>
                {formatMonth(month)}
              </option>
            ))}
          </select>
          <button
            aria-label="Next month"
            className="icon-button"
            type="button"
            onClick={() => changeMonth(shiftMonth(selectedMonth, 1))}
          >
            &rarr;
          </button>
        </div>
      </header>

      {errorMessage && (
        <p className="form-message form-message--error" role="alert">
          {errorMessage}
        </p>
      )}

      {isLoading ? (
        <section className="screen-panel empty-state" aria-live="polite">
          Loading insights...
        </section>
      ) : (
        <>
          <section className="summary" aria-label="Report overview">
            <div>
              <span>Received</span>
              <strong className="available">{formatDisplayMoney(received)}</strong>
            </div>
            <div>
              <span>Spent</span>
              <strong className="spent">{formatDisplayMoney(spent)}</strong>
            </div>
            <div>
              <span>Still available</span>
              <strong className="available">
                {formatDisplayMoney(plannedSpending - spent)}
              </strong>
            </div>
            <div>
              <span>Needs review</span>
              <strong className="warning">
                {uncategorizedTransactionCount} transaction
                {uncategorizedTransactionCount === 1 ? '' : 's'}
              </strong>
            </div>
          </section>
          <section className="report-grid">
            <InsightChart
              activityByCategory={activityByCategory}
              allocations={data.allocations}
              allocationsByCategory={allocationsByCategory}
              categoriesById={categoriesById}
              direction="spending"
              mode={spendingMode}
              splits={data.splits}
              subsections={data.subsections}
              transactions={data.transactions}
              transactionIdsWithSplits={transactionIdsWithSplits}
              onModeChange={setSpendingMode}
            />
            <InsightChart
              activityByCategory={activityByCategory}
              allocations={data.allocations}
              allocationsByCategory={allocationsByCategory}
              categoriesById={categoriesById}
              direction="income"
              mode={incomeMode}
              splits={data.splits}
              subsections={data.subsections}
              transactions={data.transactions}
              transactionIdsWithSplits={transactionIdsWithSplits}
              onModeChange={setIncomeMode}
            />
            <VarianceCard direction="over" items={overBudget} />
            <VarianceCard direction="under" items={underBudget} />
            <section className="report-card report-card--review">
              <header className="report-card__head">
                <div>
                  <p className="eyebrow">Review queue</p>
                  <h2>Uncategorized activity</h2>
                </div>
                <strong className="warning">{uncategorizedTransactionCount}</strong>
              </header>
              <div className="report-card__body">
                <p className="detail-note">
                  Uncategorized spending remains visible in every total so
                  reports never conceal it.
                </p>
                <button
                  className="terminal-button"
                  type="button"
                  onClick={onOpenTransactions}
                >
                  Open transaction queue
                </button>
              </div>
            </section>
          </section>
        </>
      )}
    </section>
  )
}

function InsightChart({
  direction,
  mode,
  allocations,
  subsections,
  transactions,
  splits,
  allocationsByCategory,
  categoriesById,
  activityByCategory,
  transactionIdsWithSplits,
  onModeChange,
}: {
  direction: BudgetDirection
  mode: InsightMode
  allocations: BudgetAllocation[]
  subsections: BudgetSubsection[]
  transactions: Transaction[]
  splits: TransactionSplit[]
  allocationsByCategory: Map<string, BudgetAllocation>
  categoriesById: Map<string, Category>
  activityByCategory: Map<string, number>
  transactionIdsWithSplits: Set<string>
  onModeChange: (mode: InsightMode) => void
}) {
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>(null)
  const slices = buildSlices({
    direction,
    mode,
    allocations,
    subsections,
    transactions,
    splits,
    allocationsByCategory,
    transactionIdsWithSplits,
  })
  const selectedSlice =
    slices.find((slice) => slice.id === selectedSliceId) ?? null
  const categoryInsights = selectedSlice
    ? buildCategoryInsights({
        selectedSlice,
        direction,
        mode,
        allocations,
        splits,
        allocationsByCategory,
        categoriesById,
        activityByCategory,
        transactions,
        transactionIdsWithSplits,
      })
    : []
  const categorySlices = categoryInsights.map((category) => ({
    id: category.id,
    label: category.label,
    value: category.value,
  }))
  const categoryTotal = categorySlices.reduce(
    (sum, category) => sum + category.value,
    0,
  )
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const plannedTotal = allocations
    .filter((allocation) => allocation.direction === direction)
    .reduce((sum, allocation) => sum + Math.abs(allocation.budgeted_amount), 0)
  const categorizedTotal = splits
    .filter((split) =>
      direction === 'income' ? split.amount > 0 : split.amount < 0,
    )
    .reduce((sum, split) => sum + Math.abs(split.amount), 0)
  const allTotal = transactions
    .filter((transaction) =>
      direction === 'income' ? transaction.amount > 0 : transaction.amount < 0,
    )
    .reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0)

  return (
    <section
      className={`panel chart-card report-card${
        direction === 'spending' ? ' report-card--wide' : ''
      }`}
    >
      <div className="chart-head report-card__head">
        <div>
          <p className="eyebrow">
            {direction === 'income' ? 'Income' : 'Spending'}
          </p>
          <h2>
            {direction === 'income' ? 'Money received' : 'Money spent'}
          </h2>
        </div>
        <div className="segmented" aria-label={`${direction} insight mode`}>
          {(
            [
              ['all', allTotal],
              ['categorized', categorizedTotal],
              ['planned', plannedTotal],
            ] as const
          ).map(([value, valueTotal]) => (
            <button
              aria-pressed={mode === value}
              className={mode === value ? 'selected' : ''}
              key={value}
              type="button"
              onClick={() => {
                setSelectedSliceId(null)
                onModeChange(value)
              }}
            >
              {value[0].toUpperCase() + value.slice(1)} ·{' '}
              {formatDisplayMoney(valueTotal)}
            </button>
          ))}
        </div>
      </div>
      {slices.length === 0 ? (
        <div className="chart-empty">
          No {mode} {direction} for this month.
        </div>
      ) : (
        <div className="chart-body">
          <Donut slices={slices} total={total} />
          <div className="legend">
            {slices.map((slice, index) => (
              <button
                className={selectedSlice?.id === slice.id ? 'selected' : ''}
                key={slice.id}
                type="button"
                onClick={() => setSelectedSliceId(slice.id)}
              >
                <i style={{ background: chartColors[index % chartColors.length] }} />
                <span>{slice.label}</span>
                <strong>{formatDisplayMoney(slice.value)}</strong>
              </button>
            ))}
          </div>
          {selectedSlice && (
            <aside className="drilldown">
              <p className="eyebrow">Selected subsection</p>
              <div className="chart-head report-card__head">
                <h3>{selectedSlice.label}</h3>
                <button
                  className="button ghost"
                  type="button"
                  onClick={() => setSelectedSliceId(null)}
                >
                  Close
                </button>
              </div>
              <div className="drilldown-body">
                <Donut slices={categorySlices} total={categoryTotal} />
                <div className="legend detail-legend">
                  {categoryInsights.map((category, index) => (
                    <div key={category.id}>
                      <i
                        style={{
                          background:
                            chartColors[index % chartColors.length],
                        }}
                      />
                      <span>{category.label}</span>
                      <strong>{formatDisplayMoney(category.value)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          )}
        </div>
      )}
    </section>
  )
}

function buildSlices({
  direction,
  mode,
  allocations,
  subsections,
  transactions,
  splits,
  allocationsByCategory,
  transactionIdsWithSplits,
}: {
  direction: BudgetDirection
  mode: InsightMode
  allocations: BudgetAllocation[]
  subsections: BudgetSubsection[]
  transactions: Transaction[]
  splits: TransactionSplit[]
  allocationsByCategory: Map<string, BudgetAllocation>
  transactionIdsWithSplits: Set<string>
}): InsightSlice[] {
  const values = new Map<string, InsightSlice>()
  const add = (id: string, label: string, amount: number) => {
    const current = values.get(id)
    values.set(id, {
      id,
      label,
      value: (current?.value ?? 0) + Math.abs(amount),
    })
  }
  const subsectionNames = new Map(
    subsections.map((subsection) => [subsection.id, subsection.name]),
  )

  if (mode === 'planned') {
    for (const allocation of allocations) {
      if (allocation.direction !== direction) {
        continue
      }
      const id = allocation.subsection_id ?? 'unsectioned'
      add(
        id,
        allocation.subsection_id
          ? subsectionNames.get(allocation.subsection_id) ?? 'Subsection'
          : 'Unsectioned',
        allocation.budgeted_amount,
      )
    }
  } else {
    for (const split of splits) {
      if (
        (direction === 'income' && split.amount <= 0) ||
        (direction === 'spending' && split.amount >= 0)
      ) {
        continue
      }
      const allocation = allocationsByCategory.get(split.category_id)
      const id = allocation
        ? allocation.subsection_id ?? 'unsectioned'
        : 'not-budgeted'
      add(
        id,
        allocation?.subsection_name ??
          (allocation ? 'Unsectioned' : 'Not budgeted'),
        split.amount,
      )
    }
    if (mode === 'all') {
      for (const transaction of transactions) {
        if (
          transactionIdsWithSplits.has(transaction.id) ||
          (direction === 'income' && transaction.amount <= 0) ||
          (direction === 'spending' && transaction.amount >= 0)
        ) {
          continue
        }
        add('uncategorized', 'Uncategorized', transaction.amount)
      }
    }
  }

  return Array.from(values.values()).filter((slice) => slice.value > 0)
}

function buildCategoryInsights({
  selectedSlice,
  direction,
  mode,
  allocations,
  splits,
  allocationsByCategory,
  categoriesById,
  activityByCategory,
  transactions,
  transactionIdsWithSplits,
}: {
  selectedSlice: InsightSlice
  direction: BudgetDirection
  mode: InsightMode
  allocations: BudgetAllocation[]
  splits: TransactionSplit[]
  allocationsByCategory: Map<string, BudgetAllocation>
  categoriesById: Map<string, Category>
  activityByCategory: Map<string, number>
  transactions: Transaction[]
  transactionIdsWithSplits: Set<string>
}): CategoryInsight[] {
  if (selectedSlice.id === 'uncategorized') {
    const netActivity = transactions.reduce(
      (sum, transaction) =>
        transactionIdsWithSplits.has(transaction.id)
          ? sum
          : sum + transaction.amount,
      0,
    )
    return [
      {
        id: 'uncategorized',
        label: 'Uncategorized',
        value: selectedSlice.value,
        netActivity,
      },
    ]
  }

  const values = new Map<string, number>()
  if (mode === 'planned') {
    for (const allocation of allocations) {
      if (
        allocation.direction === direction &&
        (allocation.subsection_id ?? 'unsectioned') === selectedSlice.id
      ) {
        values.set(allocation.category_id, Math.abs(allocation.budgeted_amount))
      }
    }
  } else {
    for (const split of splits) {
      const allocation = allocationsByCategory.get(split.category_id)
      const sliceId = allocation
        ? allocation.subsection_id ?? 'unsectioned'
        : 'not-budgeted'
      if (
        sliceId === selectedSlice.id &&
        ((direction === 'income' && split.amount > 0) ||
          (direction === 'spending' && split.amount < 0))
      ) {
        values.set(
          split.category_id,
          (values.get(split.category_id) ?? 0) + Math.abs(split.amount),
        )
      }
    }
  }

  return Array.from(values, ([categoryId, value]) => ({
    id: categoryId,
    label:
      categoriesById.get(categoryId)?.name ??
      allocationsByCategory.get(categoryId)?.category_name ??
      'Category',
    value,
    netActivity: activityByCategory.get(categoryId) ?? 0,
  })).sort((left, right) => right.value - left.value)
}

function Donut({ slices, total }: { slices: InsightSlice[]; total: number }) {
  const stops = slices.map((slice, index) => {
    const start =
      (slices
        .slice(0, index)
        .reduce((sum, candidate) => sum + candidate.value, 0) /
        total) *
      100
    const end = start + (slice.value / total) * 100
    return `${chartColors[index % chartColors.length]} ${start}% ${end}%`
  })

  return (
    <div
      aria-label={`Total ${formatDisplayMoney(total)}`}
      className="donut"
      role="img"
      style={{ background: `conic-gradient(${stops.join(', ')})` }}
    >
      <span>{formatDisplayMoney(total)}</span>
    </div>
  )
}

function toVarianceItem(allocation: BudgetAllocation): VarianceItem {
  const planned = Math.abs(allocation.budgeted_amount)
  const spent = Math.max(0, -allocation.actual_amount)
  return {
    id: allocation.allocation_id,
    name: allocation.category_name,
    planned,
    spent,
    variance: spent - planned,
  }
}

function VarianceCard({
  direction,
  items,
}: {
  direction: 'over' | 'under'
  items: VarianceItem[]
}) {
  const isOver = direction === 'over'
  const visible = items.slice(0, 3)
  const more = items.slice(3)

  return (
    <section className="panel variance-card">
      <div className="chart-head">
        <div>
          <p className="eyebrow">Spending plan variance</p>
          <h2>Most {direction} budget</h2>
        </div>
        <span className={isOver ? 'negative' : 'positive'}>
          Amount {direction} budget
        </span>
      </div>
      {visible.length === 0 ? (
        <p className="variance-empty">
          No nonzero {direction}-budget spending items.
        </p>
      ) : (
        <VarianceList isOver={isOver} items={visible} />
      )}
      {more.length > 0 && (
        <details className="variance-more">
          <summary>Show more {direction}-budget items</summary>
          <VarianceList isOver={isOver} items={more} />
        </details>
      )}
    </section>
  )
}

function VarianceList({
  items,
  isOver,
}: {
  items: VarianceItem[]
  isOver: boolean
}) {
  return (
    <ol className="variance-list">
      {items.map((item) => (
        <li key={item.id}>
          <div>
            <strong>{item.name}</strong>
            <small>
              {formatDisplayMoney(item.spent)} spent ·{' '}
              {formatDisplayMoney(item.planned)} planned
            </small>
          </div>
          <strong className={isOver ? 'negative' : 'positive'}>
            {formatDisplayMoney(Math.abs(item.variance))}
          </strong>
        </li>
      ))}
    </ol>
  )
}
