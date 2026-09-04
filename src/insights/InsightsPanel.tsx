import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'
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
import { focusWithScrollComfort } from '../navigation/focus.ts'
import {
  buildReportModel,
  type ReportChartModel,
  type ReportItemSlice,
  type ReportMode,
  type ReportSlice,
  type ReportVarianceItem,
} from './reportModel.ts'

interface InsightsData {
  budgets: Budget[]
  budget: Budget | null
  subsections: BudgetSubsection[]
  allocations: BudgetAllocation[]
  categories: Category[]
  transactions: Transaction[]
  splits: TransactionSplit[]
}

export interface InsightsInteraction {
  mode: 'drilldown' | 'transactions'
  hasParent: boolean
  canOpenTransactions: boolean
}

type ReportModal =
  | {
      kind: 'breakdown'
      slice: ReportSlice
      direction: BudgetDirection
    }
  | {
      kind: 'transactions'
      slice: ReportSlice
      item: ReportItemSlice | null
      direction: BudgetDirection
      hasParent: boolean
    }
  | null

const reportModes: ReadonlyArray<{ value: ReportMode; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'planned', label: 'Planned' },
  { value: 'categorized', label: 'Categorized' },
]

function reportSliceSemanticId(
  direction: BudgetDirection,
  sliceId: string,
): string {
  return `report-slice-${direction}-${sliceId}`
}

function reportItemSemanticId(
  direction: BudgetDirection,
  sliceId: string,
  itemId: string,
): string {
  return `report-item-${direction}-${sliceId}-${itemId}`
}

async function queryInsights(month: string): Promise<InsightsData> {
  const client = getSupabaseClient()
  const nextMonth = shiftMonth(month, 1)
  const [budgetsResult, transactions] = await Promise.all([
    client.from('budgets').select('id, month').order('month', { ascending: false }),
    collectPages((afterId, limit) => {
      let query = client
        .from('transactions')
        .select(
          'id, plaid_item_id, transaction_date, merchant_name, transaction_name, amount, currency_code, is_pending, is_ignored, account_name',
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

  const [subsectionsResult, allocationsResult, categoriesResult, splits] =
    await Promise.all([
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
    client.from('categories').select('id, name').order('name'),
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

  for (const result of [
    subsectionsResult,
    allocationsResult,
    categoriesResult,
  ]) {
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
  onInteractionChange,
}: {
  categoriesRevision: number
  activityRevision: number
  selectedMonth: string
  onMonthChange: (month: string) => void
  onInteractionChange: (interaction: InsightsInteraction | null) => void
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
  const [mode, setMode] = useState<ReportMode>('all')
  const [modal, setModal] = useState<ReportModal>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const modalRef = useRef<HTMLElement>(null)
  const reportOriginIdRef = useRef<string | null>(null)
  const pendingModalFocusIdRef = useRef<string | null>(null)

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

  const report = useMemo(
    () =>
      buildReportModel({
        mode,
        allocations: data.allocations,
        subsections: data.subsections,
        categories: data.categories,
        transactions: data.transactions,
        splits: data.splits,
      }),
    [data, mode],
  )

  const closeModal = useCallback(() => {
    if (!modal) {
      return
    }
    if (modal.kind === 'transactions' && modal.hasParent) {
      const item = modal.item
      if (item) {
        pendingModalFocusIdRef.current = reportItemSemanticId(
          modal.direction,
          modal.slice.id,
          item.id,
        )
      }
      setModal({
        kind: 'breakdown',
        slice: modal.slice,
        direction: modal.direction,
      })
      return
    }

    const originId = reportOriginIdRef.current
    setModal(null)
    window.requestAnimationFrame(() => {
      const origin = originId ? document.getElementById(originId) : null
      if (origin) {
        focusWithScrollComfort(origin)
      }
    })
  }, [modal])

  useEffect(() => {
    onInteractionChange(
      modal
        ? {
            mode: modal.kind === 'breakdown' ? 'drilldown' : 'transactions',
            hasParent:
              modal.kind === 'transactions' ? modal.hasParent : false,
            canOpenTransactions:
              modal.kind === 'breakdown' && mode !== 'planned',
          }
        : null,
    )
  }, [modal, mode, onInteractionChange])

  useEffect(
    () => () => onInteractionChange(null),
    [onInteractionChange],
  )

  useEffect(() => {
    if (!modal) {
      return
    }
    const animationFrame = window.requestAnimationFrame(() => {
      const pendingId = pendingModalFocusIdRef.current
      pendingModalFocusIdRef.current = null
      const target = pendingId
        ? document.getElementById(pendingId)
        : modalRef.current?.querySelector<HTMLElement>(
            '[data-report-autofocus="true"]',
          )
      if (target) {
        focusWithScrollComfort(target)
      }
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [modal])

  useEffect(() => {
    if (!modal) {
      return
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeModal()
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [closeModal, modal])

  function openSlice(
    direction: BudgetDirection,
    slice: ReportSlice,
    origin: HTMLElement,
  ) {
    reportOriginIdRef.current = origin.id
    if (slice.kind === 'uncategorized') {
      setModal({
        kind: 'transactions',
        slice,
        item: null,
        direction,
        hasParent: false,
      })
      return
    }
    setModal({ kind: 'breakdown', slice, direction })
  }

  function openItem(
    direction: BudgetDirection,
    slice: ReportSlice,
    item: ReportItemSlice,
  ) {
    if (mode === 'planned') {
      return
    }
    setModal({
      kind: 'transactions',
      slice,
      item,
      direction,
      hasParent: true,
    })
  }

  return (
    <section className="page insights-page insights-page--terminal reports-v2-page">
      <header className="workspace-head workspace-head--compact">
        <div>
          <p className="eyebrow">Reports / {selectedMonth.replace('-', ' / ')}</p>
          <h1>{formatMonth(selectedMonth)} at a glance</h1>
          <p className="subtitle">
            Compare income and spending, then drill into any legend row.
          </p>
        </div>
        <nav className="month-jump-controls" aria-label="Month navigation">
          <button
            data-semantic-id="report-month-previous"
            data-semantic-region="workspace"
            data-status-action="previous month"
            data-status-label="reports / previous month"
            type="button"
            onClick={() => onMonthChange(shiftMonth(selectedMonth, -1))}
          >
            <span aria-hidden="true">←</span>
            <span>
              <small>Previous month</small>
              <strong>{formatMonth(shiftMonth(selectedMonth, -1))}</strong>
            </span>
          </button>
          <button
            data-semantic-id="report-month-next"
            data-semantic-region="workspace"
            data-status-action="next month"
            data-status-label="reports / next month"
            type="button"
            onClick={() => onMonthChange(shiftMonth(selectedMonth, 1))}
          >
            <span>
              <small>Next month</small>
              <strong>{formatMonth(shiftMonth(selectedMonth, 1))}</strong>
            </span>
            <span aria-hidden="true">→</span>
          </button>
        </nav>
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
          <div className="reports-v2-modebar">
            <div>
              <p className="eyebrow">Report mode</p>
              <p className="subtle">The selected mode applies to both charts.</p>
            </div>
            <div
              aria-label="Report mode"
              className="reports-v2-switch"
              role="group"
            >
              {reportModes.map((option) => (
                <button
                  aria-pressed={mode === option.value}
                  className={mode === option.value ? 'is-selected' : ''}
                  data-semantic-id={`report-mode-${option.value}`}
                  data-semantic-kind="report-mode"
                  data-semantic-region="workspace"
                  data-status-action="select"
                  data-status-label={`reports / mode / ${option.label.toLocaleLowerCase()}`}
                  key={option.value}
                  type="button"
                  onClick={() => setMode(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <section
            className="reports-v2-charts"
            aria-label="Income and spending charts"
          >
            <ReportChart
              chart={report.income}
              mode={mode}
              plannedTotal={report.totals.plannedIncome}
              onOpenSlice={openSlice}
            />
            <ReportChart
              chart={report.spending}
              mode={mode}
              plannedTotal={report.totals.plannedSpending}
              onOpenSlice={openSlice}
            />
          </section>

          <section
            aria-label="Budget variance rankings"
            className="reports-v2-variance-stack"
          >
            <VarianceRanking direction="over" items={report.overBudget} />
            <VarianceRanking direction="under" items={report.underBudget} />
          </section>
        </>
      )}

      {modal && (
        <div className="transaction-control-layer reports-v2-overlay">
          <ReportModalView
            modal={modal}
            modalRef={modalRef}
            mode={mode}
            onClose={closeModal}
            onOpenItem={openItem}
          />
        </div>
      )}
    </section>
  )
}

function ReportChart({
  chart,
  mode,
  plannedTotal,
  onOpenSlice,
}: {
  chart: ReportChartModel
  mode: ReportMode
  plannedTotal: number
  onOpenSlice: (
    direction: BudgetDirection,
    slice: ReportSlice,
    origin: HTMLElement,
  ) => void
}) {
  const directionLabel = chart.direction === 'income' ? 'Income' : 'Spending'
  const heading = `${mode[0].toLocaleUpperCase()}${mode.slice(1)} ${directionLabel.toLocaleLowerCase()}`

  return (
    <article className="reports-v2-chart-card">
      <header className="reports-v2-chart-head">
        <div>
          <p className="eyebrow">{directionLabel}</p>
          <h2>{heading}</h2>
        </div>
        <strong>{chartComparison(chart, mode, plannedTotal)}</strong>
      </header>
      <div className="reports-v2-donut-slot">
        <ReportDonut
          label={directionLabel}
          slices={chart.slices}
          total={chart.total}
        />
      </div>
      <div
        aria-label={`${directionLabel} slices`}
        className="reports-v2-legend"
      >
        <p>{mode === 'planned' ? `${directionLabel} plan` : `${directionLabel} slices`}</p>
        {chart.slices.length === 0 ? (
          <span className="reports-v2-empty">No activity for this month.</span>
        ) : (
          chart.slices.map((slice) => {
            const semanticId = reportSliceSemanticId(chart.direction, slice.id)
            return (
              <button
                aria-haspopup="dialog"
                className={`reports-v2-slice-row${
                  slice.kind === 'uncategorized' ? ' is-uncategorized' : ''
                }`}
                data-semantic-id={semanticId}
                data-semantic-kind="report-slice"
                data-semantic-region="workspace"
                data-status-action={
                  slice.kind === 'uncategorized'
                    ? 'open transactions'
                    : 'open breakdown'
                }
                data-status-label={`reports / ${chart.direction} / ${slice.label.toLocaleLowerCase()}`}
                id={semanticId}
                key={slice.id}
                type="button"
                onClick={(event) =>
                  onOpenSlice(chart.direction, slice, event.currentTarget)
                }
              >
                <i aria-hidden="true" style={{ background: slice.color }} />
                <span>{slice.label}</span>
                <strong>{formatDisplayMoney(slice.value)}</strong>
              </button>
            )
          })
        )}
      </div>
    </article>
  )
}

function chartComparison(
  chart: ReportChartModel,
  mode: ReportMode,
  plannedTotal: number,
): string {
  if (mode !== 'all') {
    return formatDisplayMoney(chart.total)
  }
  const difference = chart.total - plannedTotal
  if (chart.direction === 'income') {
    return difference === 0
      ? 'On plan'
      : `${formatDisplayMoney(difference, 'USD', true)} vs plan`
  }
  if (difference === 0) {
    return 'On plan'
  }
  return `${formatDisplayMoney(Math.abs(difference))} ${
    difference > 0 ? 'over' : 'under'
  } plan`
}

function ReportDonut({
  label,
  slices,
  total,
}: {
  label: string
  slices: ReadonlyArray<{ id: string; color: string; value: number }>
  total: number
}) {
  return (
    <div
      aria-label={`${label} total ${formatDisplayMoney(total)}`}
      className={`reports-v2-donut reports-v2-donut--chart${
        slices.length === 0 ? ' is-empty' : ''
      }`}
      role="img"
    >
      {slices.length > 0 && (
        <div aria-hidden="true" className="reports-v2-donut-graphic">
          <ResponsiveContainer height="100%" width="100%">
            <PieChart accessibilityLayer={false}>
              <Pie
                cx="50%"
                cy="50%"
                data={slices}
                dataKey="value"
                innerRadius="58%"
                isAnimationActive={false}
                outerRadius="96%"
                stroke="none"
              >
                {slices.map((slice) => (
                  <Cell fill={slice.color} key={slice.id} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
      <span>
        <small>{label}</small>
        <strong>{formatDisplayMoney(total)}</strong>
      </span>
    </div>
  )
}

function ReportModalView({
  modal,
  modalRef,
  mode,
  onClose,
  onOpenItem,
}: {
  modal: Exclude<ReportModal, null>
  modalRef: RefObject<HTMLElement | null>
  mode: ReportMode
  onClose: () => void
  onOpenItem: (
    direction: BudgetDirection,
    slice: ReportSlice,
    item: ReportItemSlice,
  ) => void
}) {
  const directionLabel = modal.direction === 'income' ? 'Income' : 'Spending'
  const modalTitleId = `report-${modal.kind}-title`

  if (modal.kind === 'breakdown') {
    return (
      <section
        aria-labelledby={modalTitleId}
        aria-modal="true"
        className="reports-v2-modal"
        ref={modalRef}
        role="dialog"
      >
        <header className="reports-v2-modal-head">
          <div>
            <p className="eyebrow">
              {directionLabel} / {modal.slice.label}
            </p>
            <h2 id={modalTitleId}>{modal.slice.label} budget items</h2>
          </div>
          <span>{formatDisplayMoney(modal.slice.value)}</span>
        </header>
        <div className="reports-v2-modal-body">
          <ReportDonut
            label={modal.slice.label}
            slices={modal.slice.items}
            total={modal.slice.value}
          />
          <div
            aria-label={`${modal.slice.label} budget-item slices`}
            className="reports-v2-legend"
          >
            <p>Budget-item slices</p>
            {modal.slice.items.length === 0 ? (
              <span className="reports-v2-empty">No budget items in this slice.</span>
            ) : (
              modal.slice.items.map((item, index) => {
                const semanticId = reportItemSemanticId(
                  modal.direction,
                  modal.slice.id,
                  item.id,
                )
                return (
                  <button
                    aria-disabled={mode === 'planned'}
                    aria-haspopup={mode === 'planned' ? undefined : 'dialog'}
                    className="reports-v2-slice-row"
                    data-report-autofocus={index === 0 ? 'true' : undefined}
                    data-semantic-id={semanticId}
                    data-semantic-kind="report-item"
                    data-semantic-region="workspace"
                    data-status-action={
                      mode === 'planned'
                        ? 'view allocation'
                        : 'open transactions'
                    }
                    data-status-label={`reports / ${modal.direction} / ${modal.slice.label.toLocaleLowerCase()} / ${item.label.toLocaleLowerCase()}`}
                    id={semanticId}
                    key={item.id}
                    type="button"
                    onClick={() =>
                      onOpenItem(modal.direction, modal.slice, item)
                    }
                  >
                    <i aria-hidden="true" style={{ background: item.color }} />
                    <span>{item.label}</span>
                    <strong>{formatDisplayMoney(item.value)}</strong>
                  </button>
                )
              })
            )}
          </div>
        </div>
        <footer className="reports-v2-modal-foot">
          <span>
            {modal.slice.items.length} budget item
            {modal.slice.items.length === 1 ? '' : 's'}
          </span>
          <button
            className="terminal-button"
            data-report-autofocus={
              modal.slice.items.length === 0 ? 'true' : undefined
            }
            data-semantic-id="report-breakdown-close"
            data-semantic-region="workspace"
            data-status-action="close"
            data-status-label="reports / breakdown"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </section>
    )
  }

  const transactions = modal.item?.transactions ?? modal.slice.transactions
  const sliceLabel = modal.item?.label ?? modal.slice.label
  const total = transactions.reduce(
    (sum, transaction) => sum + transaction.amount,
    0,
  )

  return (
    <section
      aria-labelledby={modalTitleId}
      aria-modal="true"
      className="reports-v2-modal"
      ref={modalRef}
      role="dialog"
    >
      <header className="reports-v2-modal-head">
        <div>
          <p className="eyebrow">
            {directionLabel} / {modal.slice.label}
            {modal.item ? ` / ${modal.item.label}` : ''}
          </p>
          <h2 id={modalTitleId}>
            {modal.slice.kind === 'uncategorized'
              ? 'Transactions needing review'
              : 'Transactions in this slice'}
          </h2>
        </div>
        <span>
          {transactions.length} transaction{transactions.length === 1 ? '' : 's'} /{' '}
          {formatDisplayMoney(total)}
        </span>
      </header>
      <div
        aria-label={`${sliceLabel} transactions`}
        className="reports-v2-transactions"
        role="list"
      >
        {transactions.length === 0 ? (
          <p className="reports-v2-empty">No included transactions in this slice.</p>
        ) : (
          transactions.map((transaction, index) => (
            <div
              aria-label={`${transaction.name}, ${formatDisplayMoney(transaction.amount)}`}
              className={`reports-v2-transaction-row is-${modal.direction}`}
              data-report-autofocus={index === 0 ? 'true' : undefined}
              data-semantic-id={`report-transaction-${transaction.id}`}
              data-semantic-kind="report-transaction"
              data-semantic-region="workspace"
              data-status-action="inspect"
              data-status-label={`reports / transaction / ${transaction.name.toLocaleLowerCase()}`}
              key={transaction.id}
              role="listitem"
              tabIndex={0}
            >
              <span>
                <strong>{transaction.name}</strong>
                <small>
                  {formatReportDate(transaction.transactionDate)} /{' '}
                  {transaction.accountName}
                </small>
              </span>
              <strong>
                {formatDisplayMoney(
                  modal.direction === 'income'
                    ? transaction.amount
                    : -transaction.amount,
                  'USD',
                  modal.direction === 'income',
                )}
              </strong>
            </div>
          ))
        )}
      </div>
      <footer className="reports-v2-modal-foot">
        <span className={modal.slice.kind === 'uncategorized' ? 'warning' : ''}>
          {modal.slice.kind === 'uncategorized'
            ? 'Category required'
            : 'Read-only / included activity'}
        </span>
        <button
          className="terminal-button"
          data-report-autofocus={transactions.length === 0 ? 'true' : undefined}
          data-semantic-id="report-transactions-close"
          data-semantic-region="workspace"
          data-status-action={modal.hasParent ? 'back' : 'close'}
          data-status-label="reports / transactions"
          type="button"
          onClick={onClose}
        >
          {modal.hasParent ? 'Back' : 'Close'}
        </button>
      </footer>
    </section>
  )
}

function formatReportDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T00:00:00`))
}

function VarianceRanking({
  direction,
  items,
}: {
  direction: 'over' | 'under'
  items: ReportVarianceItem[]
}) {
  const isOver = direction === 'over'

  return (
    <section className="reports-v2-variance">
      <header className="reports-v2-variance-head">
        <div>
          <p className="eyebrow">
            {isOver ? 'Needs attention' : 'Room remaining'}
          </p>
          <h2>{isOver ? 'Most over budget' : 'Most under budget'}</h2>
        </div>
        <span
          className={`terminal-pill ${
            isOver ? 'terminal-pill--danger' : 'terminal-pill--ok'
          }`}
        >
          {items.length} item{items.length === 1 ? '' : 's'}
        </span>
      </header>
      {items.length === 0 ? (
        <p className="reports-v2-variance-empty">
          No {direction}-budget spending items.
        </p>
      ) : (
        <ol className="reports-v2-variance-list">
          {items.map((item) => (
            <li
              data-semantic-id={`report-variance-${direction}-${item.id}`}
              data-semantic-kind="report-variance"
              data-semantic-region="workspace"
              data-status-action="view"
              data-status-label={`reports / ${direction} budget / ${item.name.toLocaleLowerCase()}`}
              key={item.id}
              tabIndex={0}
            >
              <strong>{item.name}</strong>
              <span>{item.groupName}</span>
              <small>
                {formatDisplayMoney(item.actual)} spent /{' '}
                {formatDisplayMoney(item.planned)} planned
              </small>
              <strong className={isOver ? 'is-over' : 'is-under'}>
                {isOver ? '+' : ''}
                {formatDisplayMoney(Math.abs(item.variance))}
              </strong>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
