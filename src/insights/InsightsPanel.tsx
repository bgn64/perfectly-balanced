import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Budget,
  BudgetAllocation,
  BudgetDirection,
  BudgetSubsection,
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

interface InsightsData {
  budgets: Budget[]
  budget: Budget | null
  subsections: BudgetSubsection[]
  allocations: BudgetAllocation[]
  transactions: Transaction[]
  splits: TransactionSplit[]
}

interface InsightSlice {
  id: string
  label: string
  value: number
}

interface VarianceItem {
  id: string
  name: string
  planned: number
  spent: number
  variance: number
}

const chartColors = ['#7aa2f7', '#bb9af7', '#e0af68', '#f7768e', '#7dcfff']

async function queryInsights(month: string): Promise<InsightsData> {
  const client = getSupabaseClient()
  const nextMonth = shiftMonth(month, 1)
  const [budgetsResult, transactions] = await Promise.all([
    client.from('budgets').select('id, month').order('month', { ascending: false }),
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

  if (budgetsResult.error) {
    throw new Error(budgetsResult.error.message)
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

  const [subsectionsResult, allocationsResult, splits] = await Promise.all([
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
    transactions: normalizedTransactions,
    splits: splits
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
    transactions: [],
    splits: [],
  })
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
  const transactionIdsWithSplits = useMemo(
    () => new Set(data.splits.map((split) => split.transaction_id)),
    [data.splits],
  )
  const spendingSlices = useMemo(
    () =>
      buildSlices({
        direction: 'spending',
        subsections: data.subsections,
        transactions: data.transactions,
        splits: data.splits,
        allocationsByCategory,
        transactionIdsWithSplits,
      }),
    [
      allocationsByCategory,
      data.subsections,
      data.splits,
      data.transactions,
      transactionIdsWithSplits,
    ],
  )
  const incomeSlices = useMemo(
    () =>
      buildSlices({
        direction: 'income',
        subsections: data.subsections,
        transactions: data.transactions,
        splits: data.splits,
        allocationsByCategory,
        transactionIdsWithSplits,
      }),
    [
      allocationsByCategory,
      data.subsections,
      data.splits,
      data.transactions,
      transactionIdsWithSplits,
    ],
  )
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
  const plannedIncome = data.allocations
    .filter((allocation) => allocation.direction === 'income')
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
          <p className="subtitle">
            A compact readout of how this month is tracking against your plan.
          </p>
        </div>
        <div className="month-controls" aria-label="Month navigation">
          <button
            data-semantic-id="report-month-previous"
            data-semantic-region="workspace"
            data-status-action="previous month"
            data-status-label="reports / previous month"
            type="button"
            onClick={() => onMonthChange(shiftMonth(selectedMonth, -1))}
          >
            &larr; Previous
          </button>
          <button
            data-semantic-id="report-month-next"
            data-semantic-region="workspace"
            data-status-action="next month"
            data-status-label="reports / next month"
            type="button"
            onClick={() => onMonthChange(shiftMonth(selectedMonth, 1))}
          >
            Next &rarr;
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
          <section className="summary" aria-label={`${formatMonth(selectedMonth)} report summary`}>
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

          <section
            className="report-grid"
            aria-label={`${formatMonth(selectedMonth)} reports`}
          >
            <BreakdownCard
              eyebrow="Spending breakdown"
              heading={`Where the ${formatDisplayMoney(spent)} went`}
              slices={spendingSlices}
              total={spent}
              wide
            />
            <IncomeCard
              plannedIncome={plannedIncome}
              received={received}
              slices={incomeSlices}
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
                  data-semantic-id="report-review-queue"
                  data-semantic-region="workspace"
                  data-status-action="open"
                  data-status-label="reports / transaction queue"
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

function BreakdownCard({
  eyebrow,
  heading,
  slices,
  total,
  wide = false,
}: {
  eyebrow: string
  heading: string
  slices: InsightSlice[]
  total: number
  wide?: boolean
}) {
  return (
    <section className={`report-card${wide ? ' report-card--wide' : ''}`}>
      <header className="report-card__head">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{heading}</h2>
        </div>
        <strong>{formatDisplayMoney(total)}</strong>
      </header>
      <div className="report-card__body donut-report">
        {slices.length === 0 ? (
          <p className="detail-note">No activity for this month.</p>
        ) : (
          <>
            <ReportDonut slices={slices} total={total} />
            <BarList slices={slices} />
          </>
        )}
      </div>
    </section>
  )
}

function IncomeCard({
  plannedIncome,
  received,
  slices,
}: {
  plannedIncome: number
  received: number
  slices: InsightSlice[]
}) {
  const progress =
    plannedIncome === 0 ? 0 : Math.min(100, (received / plannedIncome) * 100)

  return (
    <section className="report-card">
      <header className="report-card__head">
        <div>
          <p className="eyebrow">Income</p>
          <h2>Progress to plan</h2>
        </div>
        <strong className="available">{Math.round(progress)}%</strong>
      </header>
      <div className="report-card__body">
        {slices.length === 0 ? (
          <p className="detail-note">No income activity for this month.</p>
        ) : (
          <BarList slices={slices} />
        )}
      </div>
    </section>
  )
}

function ReportDonut({
  slices,
  total,
}: {
  slices: InsightSlice[]
  total: number
}) {
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
      className="donut-chart"
      role="img"
      style={{ background: `conic-gradient(${stops.join(', ')})` }}
    >
      <span>{formatDisplayMoney(total)}</span>
    </div>
  )
}

function BarList({ slices }: { slices: InsightSlice[] }) {
  const maximum = Math.max(...slices.map((slice) => slice.value), 1)

  return (
    <ul className="bar-list">
      {slices.map((slice, index) => (
        <li key={slice.id}>
          <span>{slice.label}</span>
          <span className="bar-track">
            <i
              style={{
                background: chartColors[index % chartColors.length],
                width: `${(slice.value / maximum) * 100}%`,
              }}
            />
          </span>
          <strong>{formatDisplayMoney(slice.value)}</strong>
        </li>
      ))}
    </ul>
  )
}

function buildSlices({
  direction,
  subsections,
  transactions,
  splits,
  allocationsByCategory,
  transactionIdsWithSplits,
}: {
  direction: BudgetDirection
  subsections: BudgetSubsection[]
  transactions: Transaction[]
  splits: TransactionSplit[]
  allocationsByCategory: Map<string, BudgetAllocation>
  transactionIdsWithSplits: Set<string>
}): InsightSlice[] {
  const values = new Map<string, InsightSlice>()
  const subsectionNames = new Map(
    subsections.map((subsection) => [subsection.id, subsection.name]),
  )

  function add(id: string, label: string, amount: number) {
    const current = values.get(id)
    values.set(id, {
      id,
      label,
      value: (current?.value ?? 0) + Math.abs(amount),
    })
  }

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
      allocation?.subsection_id
        ? subsectionNames.get(allocation.subsection_id) ?? 'Subsection'
        : allocation
          ? 'Unsectioned'
          : 'Not budgeted',
      split.amount,
    )
  }

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

  return Array.from(values.values())
    .filter((slice) => slice.value > 0)
    .sort((left, right) => right.value - left.value)
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

  return (
    <section className="report-card">
      <header className="report-card__head">
        <div>
          <p className="eyebrow">Plan variance</p>
          <h2>{isOver ? 'Over budget' : 'Under budget'}</h2>
        </div>
        <span
          className={`terminal-pill ${
            isOver ? 'terminal-pill--danger' : 'terminal-pill--ok'
          }`}
        >
          {items.length} item{items.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="report-card__body">
        {visible.length === 0 ? (
          <p className="detail-note">
            No {direction}-budget spending items.
          </p>
        ) : (
          <ol className="variance-list">
            {visible.map((item) => (
              <li key={item.id}>
                <span>
                  {item.name}
                  <small>
                    {formatDisplayMoney(item.spent)} spent ·{' '}
                    {formatDisplayMoney(item.planned)} planned
                  </small>
                </span>
                <strong className={isOver ? 'is-over' : 'is-under'}>
                  {isOver ? '+' : ''}
                  {formatDisplayMoney(Math.abs(item.variance))}
                </strong>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
