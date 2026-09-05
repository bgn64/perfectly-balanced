import type {
  BudgetAllocation,
  BudgetDirection,
  BudgetSubsection,
  Category,
  Transaction,
  TransactionSplit,
} from '../finance/types.ts'
import { transactionDescription } from '../finance/utils.ts'

export type ReportMode = 'all' | 'planned' | 'categorized'

export interface ReportTransactionContribution {
  id: string
  transactionId: string
  name: string
  accountName: string
  transactionDate: string
  amount: number
}

export interface ReportItemSlice {
  id: string
  label: string
  value: number
  color: string
  transactions: ReportTransactionContribution[]
}

export interface ReportSlice {
  id: string
  label: string
  value: number
  color: string
  kind: 'categorized' | 'uncategorized'
  items: ReportItemSlice[]
  transactions: ReportTransactionContribution[]
}

export interface ReportChartModel {
  direction: BudgetDirection
  total: number
  slices: ReportSlice[]
}

export interface ReportVarianceItem {
  id: string
  name: string
  groupName: string
  planned: number
  actual: number
  variance: number
}

export interface ReportTotals {
  plannedIncome: number
  categorizedIncome: number
  totalIncome: number
  plannedSpending: number
  categorizedSpending: number
  totalSpending: number
}

export interface ReportModel {
  income: ReportChartModel
  spending: ReportChartModel
  totals: ReportTotals
  overBudget: ReportVarianceItem[]
  underBudget: ReportVarianceItem[]
}

export interface ReportModelInput {
  mode: ReportMode
  allocations: BudgetAllocation[]
  subsections: BudgetSubsection[]
  categories: Category[]
  transactions: Transaction[]
  splits: TransactionSplit[]
}

const chartColors = [
  '#7aa2f7',
  '#9ece6a',
  '#bb9af7',
  '#e0af68',
  '#7dcfff',
  '#f7768e',
]

interface MutableItemSlice extends ReportItemSlice {
  transactionValues: Map<string, ReportTransactionContribution>
}

interface MutableReportSlice extends ReportSlice {
  itemValues: Map<string, MutableItemSlice>
  transactionValues: Map<string, ReportTransactionContribution>
}

function stableColor(id: string): string {
  let hash = 0
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0
  }
  return chartColors[Math.abs(hash) % chartColors.length]
}

function directionMatches(amount: number, direction: BudgetDirection): boolean {
  return direction === 'income' ? amount > 0 : amount < 0
}

function groupId(allocation: BudgetAllocation | undefined): string {
  if (!allocation) {
    return 'not-budgeted'
  }
  return allocation.subsection_id
    ? `subsection:${allocation.subsection_id}`
    : 'unsectioned'
}

function groupLabel(
  allocation: BudgetAllocation | undefined,
  subsectionNames: Map<string, string>,
): string {
  if (!allocation) {
    return 'Not budgeted'
  }
  return allocation.subsection_id
    ? subsectionNames.get(allocation.subsection_id) ?? 'Subsection'
    : 'Unsectioned'
}

function addContribution(
  values: Map<string, ReportTransactionContribution>,
  contribution: ReportTransactionContribution,
) {
  const current = values.get(contribution.transactionId)
  values.set(contribution.transactionId, {
    ...contribution,
    amount: (current?.amount ?? 0) + contribution.amount,
  })
}

function getOrCreateSlice(
  slices: Map<string, MutableReportSlice>,
  id: string,
  label: string,
  kind: ReportSlice['kind'] = 'categorized',
): MutableReportSlice {
  const current = slices.get(id)
  if (current) {
    return current
  }
  const next: MutableReportSlice = {
    id,
    label,
    value: 0,
    color: stableColor(id),
    kind,
    items: [],
    transactions: [],
    itemValues: new Map(),
    transactionValues: new Map(),
  }
  slices.set(id, next)
  return next
}

function getOrCreateItem(
  parent: MutableReportSlice,
  id: string,
  label: string,
): MutableItemSlice {
  const current = parent.itemValues.get(id)
  if (current) {
    return current
  }
  const next: MutableItemSlice = {
    id,
    label,
    value: 0,
    color: stableColor(id),
    transactions: [],
    transactionValues: new Map(),
  }
  parent.itemValues.set(id, next)
  return next
}

function finishSlices(values: Map<string, MutableReportSlice>): ReportSlice[] {
  return Array.from(values.values())
    .map((slice) => ({
      id: slice.id,
      label: slice.label,
      value: slice.value,
      color: slice.color,
      kind: slice.kind,
      items: Array.from(slice.itemValues.values())
        .map((item) => ({
          id: item.id,
          label: item.label,
          value: item.value,
          color: item.color,
          transactions: Array.from(item.transactionValues.values()).sort(
            (left, right) =>
              right.transactionDate.localeCompare(left.transactionDate),
          ),
        }))
        .sort((left, right) => right.value - left.value),
      transactions: Array.from(slice.transactionValues.values()).sort(
        (left, right) =>
          right.transactionDate.localeCompare(left.transactionDate),
      ),
    }))
    .filter((slice) => slice.value > 0)
    .sort((left, right) => right.value - left.value)
}

function buildPlannedSlices(
  direction: BudgetDirection,
  allocations: BudgetAllocation[],
  subsectionNames: Map<string, string>,
): ReportSlice[] {
  const values = new Map<string, MutableReportSlice>()
  for (const allocation of allocations) {
    if (allocation.direction !== direction) {
      continue
    }
    const parent = getOrCreateSlice(
      values,
      groupId(allocation),
      groupLabel(allocation, subsectionNames),
    )
    const amount = Math.abs(allocation.budgeted_amount)
    const item = getOrCreateItem(
      parent,
      `category:${allocation.category_id}`,
      allocation.category_name,
    )
    parent.value += amount
    item.value += amount
  }
  return finishSlices(values)
}

function buildActualSlices({
  direction,
  includeUncategorized,
  allocationsByCategory,
  categoriesById,
  subsectionNames,
  transactions,
  splits,
}: {
  direction: BudgetDirection
  includeUncategorized: boolean
  allocationsByCategory: Map<string, BudgetAllocation>
  categoriesById: Map<string, Category>
  subsectionNames: Map<string, string>
  transactions: Transaction[]
  splits: TransactionSplit[]
}): ReportSlice[] {
  const values = new Map<string, MutableReportSlice>()
  const transactionsById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  )
  const categorizedTransactionIds = new Set(
    splits.map((split) => split.transaction_id),
  )

  for (const split of splits) {
    const transaction = transactionsById.get(split.transaction_id)
    const allocation = allocationsByCategory.get(split.category_id)
    const splitMatchesDirection = allocation
      ? allocation.direction === direction
      : directionMatches(split.amount, direction)
    if (!transaction || !splitMatchesDirection) {
      continue
    }
    const parent = getOrCreateSlice(
      values,
      groupId(allocation),
      groupLabel(allocation, subsectionNames),
    )
    const category = categoriesById.get(split.category_id)
    const item = getOrCreateItem(
      parent,
      `category:${split.category_id}`,
      allocation?.category_name ?? category?.name ?? 'Unknown category',
    )
    const amount = direction === 'income' ? split.amount : -split.amount
    const contribution: ReportTransactionContribution = {
      id: `${split.id}:${direction}`,
      transactionId: transaction.id,
      name: transactionDescription(transaction),
      accountName: transaction.account_name,
      transactionDate: transaction.transaction_date,
      amount,
    }
    parent.value += amount
    item.value += amount
    addContribution(parent.transactionValues, contribution)
    addContribution(item.transactionValues, contribution)
  }

  if (includeUncategorized) {
    for (const transaction of transactions) {
      if (
        categorizedTransactionIds.has(transaction.id) ||
        !directionMatches(transaction.amount, direction)
      ) {
        continue
      }
      const amount = Math.abs(transaction.amount)
      const parent = getOrCreateSlice(
        values,
        'uncategorized',
        'Uncategorized',
        'uncategorized',
      )
      const contribution: ReportTransactionContribution = {
        id: `${transaction.id}:${direction}`,
        transactionId: transaction.id,
        name: transactionDescription(transaction),
        accountName: transaction.account_name,
        transactionDate: transaction.transaction_date,
        amount,
      }
      parent.value += amount
      addContribution(parent.transactionValues, contribution)
    }
  }

  return finishSlices(values)
}

function chartTotal(slices: ReportSlice[]): number {
  return slices.reduce((sum, slice) => sum + slice.value, 0)
}

export function buildReportModel(input: ReportModelInput): ReportModel {
  const activeTransactions = input.transactions.filter(
    (transaction) => !transaction.is_ignored,
  )
  const activeTransactionIds = new Set(
    activeTransactions.map((transaction) => transaction.id),
  )
  const activeSplits = input.splits.filter((split) =>
    activeTransactionIds.has(split.transaction_id),
  )
  const allocationsByCategory = new Map(
    input.allocations.map((allocation) => [allocation.category_id, allocation]),
  )
  const categoriesById = new Map(
    input.categories.map((category) => [category.id, category]),
  )
  const subsectionNames = new Map(
    input.subsections.map((subsection) => [subsection.id, subsection.name]),
  )

  const plannedIncomeSlices = buildPlannedSlices(
    'income',
    input.allocations,
    subsectionNames,
  )
  const plannedSpendingSlices = buildPlannedSlices(
    'spending',
    input.allocations,
    subsectionNames,
  )
  const categorizedIncomeSlices = buildActualSlices({
    direction: 'income',
    includeUncategorized: false,
    allocationsByCategory,
    categoriesById,
    subsectionNames,
    transactions: activeTransactions,
    splits: activeSplits,
  })
  const categorizedSpendingSlices = buildActualSlices({
    direction: 'spending',
    includeUncategorized: false,
    allocationsByCategory,
    categoriesById,
    subsectionNames,
    transactions: activeTransactions,
    splits: activeSplits,
  })
  const allIncomeSlices = buildActualSlices({
    direction: 'income',
    includeUncategorized: true,
    allocationsByCategory,
    categoriesById,
    subsectionNames,
    transactions: activeTransactions,
    splits: activeSplits,
  })
  const allSpendingSlices = buildActualSlices({
    direction: 'spending',
    includeUncategorized: true,
    allocationsByCategory,
    categoriesById,
    subsectionNames,
    transactions: activeTransactions,
    splits: activeSplits,
  })

  const slicesByMode = {
    planned: {
      income: plannedIncomeSlices,
      spending: plannedSpendingSlices,
    },
    categorized: {
      income: categorizedIncomeSlices,
      spending: categorizedSpendingSlices,
    },
    all: {
      income: allIncomeSlices,
      spending: allSpendingSlices,
    },
  }
  const selectedSlices = slicesByMode[input.mode]

  const varianceItems = input.allocations
    .filter((allocation) => allocation.direction === 'spending')
    .map<ReportVarianceItem>((allocation) => {
      const planned = Math.abs(allocation.budgeted_amount)
      const actual = Math.max(0, -allocation.actual_amount)
      return {
        id: allocation.allocation_id,
        name: allocation.category_name,
        groupName: groupLabel(allocation, subsectionNames),
        planned,
        actual,
        variance: actual - planned,
      }
    })

  return {
    income: {
      direction: 'income',
      total: chartTotal(selectedSlices.income),
      slices: selectedSlices.income,
    },
    spending: {
      direction: 'spending',
      total: chartTotal(selectedSlices.spending),
      slices: selectedSlices.spending,
    },
    totals: {
      plannedIncome: chartTotal(plannedIncomeSlices),
      categorizedIncome: chartTotal(categorizedIncomeSlices),
      totalIncome: chartTotal(allIncomeSlices),
      plannedSpending: chartTotal(plannedSpendingSlices),
      categorizedSpending: chartTotal(categorizedSpendingSlices),
      totalSpending: chartTotal(allSpendingSlices),
    },
    overBudget: varianceItems
      .filter((item) => item.variance > 0)
      .sort((left, right) => right.variance - left.variance)
      .slice(0, 3),
    underBudget: varianceItems
      .filter((item) => item.variance < 0)
      .sort((left, right) => left.variance - right.variance)
      .slice(0, 3),
  }
}