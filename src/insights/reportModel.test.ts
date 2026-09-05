import { describe, expect, it } from 'vitest'
import type {
  BudgetAllocation,
  BudgetSubsection,
  Category,
  Transaction,
  TransactionSplit,
} from '../finance/types.ts'
import { buildReportModel, type ReportMode } from './reportModel.ts'

const subsections: BudgetSubsection[] = [
  { id: 'employment', name: 'Employment', position: 0 },
  { id: 'food', name: 'Food', position: 1 },
]

const categories: Category[] = [
  { id: 'salary', name: 'Salary' },
  { id: 'groceries', name: 'Groceries' },
  { id: 'books', name: 'Books' },
]

const allocations: BudgetAllocation[] = [
  {
    allocation_id: 'salary-allocation',
    category_id: 'salary',
    category_name: 'Salary',
    subsection_id: 'employment',
    subsection_name: 'Employment',
    position: 0,
    direction: 'income',
    budgeted_amount: 1000,
    actual_amount: 1200,
  },
  {
    allocation_id: 'groceries-allocation',
    category_id: 'groceries',
    category_name: 'Groceries',
    subsection_id: 'food',
    subsection_name: 'Food',
    position: 0,
    direction: 'spending',
    budgeted_amount: -400,
    actual_amount: -450,
  },
]

const transactions: Transaction[] = [
  transaction('salary-transaction', 1200, 'Employer'),
  transaction('gift-transaction', 50, 'Gift'),
  transaction('grocery-transaction', -450, 'Greenway Foods'),
  transaction('books-transaction', -80, 'Bookshop'),
  transaction('parking-transaction', -20, 'Parking'),
  { ...transaction('ignored-transaction', -99, 'Ignored'), is_ignored: true },
]

const splits: TransactionSplit[] = [
  split('salary-split', 'salary-transaction', 'salary', 1200),
  split('grocery-split', 'grocery-transaction', 'groceries', -450),
  split('books-split', 'books-transaction', 'books', -80),
]

function transaction(
  id: string,
  amount: number,
  merchantName: string,
): Transaction {
  return {
    id,
    plaid_item_id: null,
    transaction_date: '2026-09-15',
    merchant_name: merchantName,
    transaction_name: null,
    amount,
    currency_code: 'USD',
    is_pending: false,
    is_ignored: false,
    account_name: 'Checking',
  }
}

function split(
  id: string,
  transactionId: string,
  categoryId: string,
  amount: number,
): TransactionSplit {
  return {
    id,
    transaction_id: transactionId,
    category_id: categoryId,
    amount,
  }
}

function report(mode: ReportMode) {
  return buildReportModel({
    mode,
    allocations,
    subsections,
    categories,
    transactions,
    splits,
  })
}

function representedAmounts(model: ReturnType<typeof buildReportModel>) {
  const amounts = new Map<string, number>()
  for (const chart of [model.income, model.spending]) {
    const multiplier = chart.direction === 'income' ? 1 : -1
    for (const slice of chart.slices) {
      for (const contribution of slice.transactions) {
        amounts.set(
          contribution.transactionId,
          (amounts.get(contribution.transactionId) ?? 0) +
            contribution.amount * multiplier,
        )
      }
    }
  }
  return Object.fromEntries(
    Array.from(amounts.entries()).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  )
}

describe('buildReportModel', () => {
  it('includes categorized and uncategorized activity in All mode', () => {
    const model = report('all')

    expect(model.totals).toEqual({
      plannedIncome: 1000,
      categorizedIncome: 1200,
      totalIncome: 1250,
      plannedSpending: 400,
      categorizedSpending: 530,
      totalSpending: 550,
    })
    expect(model.income.total).toBe(1250)
    expect(model.spending.total).toBe(550)
    expect(
      model.spending.slices.find((slice) => slice.id === 'uncategorized'),
    ).toMatchObject({ value: 20, transactions: [{ amount: 20 }] })
    expect(
      model.spending.slices.find((slice) => slice.id === 'not-budgeted'),
    ).toMatchObject({
      value: 80,
      items: [{ label: 'Books', value: 80 }],
    })
  })

  it('uses allocations in Planned mode without transaction drilldowns', () => {
    const model = report('planned')

    expect(model.income.total).toBe(1000)
    expect(model.spending.total).toBe(400)
    expect(model.spending.slices).toMatchObject([
      {
        label: 'Food',
        value: 400,
        items: [{ label: 'Groceries', value: 400, transactions: [] }],
        transactions: [],
      },
    ])
  })

  it('omits uncategorized activity in Categorized mode', () => {
    const model = report('categorized')

    expect(model.income.total).toBe(1200)
    expect(model.spending.total).toBe(530)
    expect(
      model.spending.slices.some((slice) => slice.kind === 'uncategorized'),
    ).toBe(false)
  })

  it('represents every included transaction in All and only categorized transactions in Categorized', () => {
    expect(representedAmounts(report('all'))).toEqual({
      'books-transaction': -80,
      'gift-transaction': 50,
      'grocery-transaction': -450,
      'parking-transaction': -20,
      'salary-transaction': 1200,
    })
    expect(representedAmounts(report('categorized'))).toEqual({
      'books-transaction': -80,
      'grocery-transaction': -450,
      'salary-transaction': 1200,
    })
  })

  it('places categorized activity by budget direction and nets by sign', () => {
    const model = buildReportModel({
      mode: 'categorized',
      allocations,
      subsections,
      categories,
      transactions: [
        transaction('spending-outflow', -200, 'Groceries'),
        transaction('spending-inflow', 125, 'Grocery refund'),
        transaction('income-inflow', 200, 'Employer'),
        transaction('income-outflow', -75, 'Payroll correction'),
      ],
      splits: [
        split(
          'spending-outflow-split',
          'spending-outflow',
          'groceries',
          -200,
        ),
        split('spending-inflow-split', 'spending-inflow', 'groceries', 125),
        split('income-inflow-split', 'income-inflow', 'salary', 200),
        split('income-outflow-split', 'income-outflow', 'salary', -75),
      ],
    })

    expect(model.spending).toMatchObject({
      total: 75,
      slices: [
        {
          label: 'Food',
          value: 75,
          transactions: expect.arrayContaining([
            expect.objectContaining({
              transactionId: 'spending-outflow',
              amount: 200,
            }),
            expect.objectContaining({
              transactionId: 'spending-inflow',
              amount: -125,
            }),
          ]),
        },
      ],
    })
    expect(model.income).toMatchObject({
      total: 125,
      slices: [
        {
          label: 'Employment',
          value: 125,
          transactions: expect.arrayContaining([
            expect.objectContaining({
              transactionId: 'income-inflow',
              amount: 200,
            }),
            expect.objectContaining({
              transactionId: 'income-outflow',
              amount: -75,
            }),
          ]),
        },
      ],
    })
  })

  it('ranks spending variance and excludes ignored activity', () => {
    const model = report('all')

    expect(model.overBudget).toMatchObject([
      {
        name: 'Groceries',
        groupName: 'Food',
        planned: 400,
        actual: 450,
        variance: 50,
      },
    ])
    expect(model.underBudget).toEqual([])
    expect(model.spending.total).not.toBe(649)
  })
})