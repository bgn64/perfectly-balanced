import { describe, expect, it } from 'vitest'
import type { Transaction, TransactionSplit } from '../finance/types.ts'
import {
  createTransactionBudgetingDraft,
  effectiveBudgetMonth,
  isTransactionDraftDirty,
  rpcSplits,
  validateTransactionDraft,
} from './transactionDetailModel.ts'

const transaction: Transaction = {
  id: 'transaction-1',
  plaid_item_id: null,
  source_transaction_id: 'source-1',
  transaction_date: '2026-09-29',
  budget_month_override: null,
  effective_budget_month: '2026-09-01',
  merchant_name: 'Northstar Market',
  transaction_name: null,
  amount: -425.8,
  currency_code: 'USD',
  is_pending: false,
  is_ignored: false,
  account_name: 'Local Checking',
  institution_name: 'Local Bank',
  imported_at: '2026-09-30T00:00:00Z',
}

const splits: TransactionSplit[] = [
  {
    id: 'split-1',
    transaction_id: transaction.id,
    category_id: 'groceries',
    amount: -300,
  },
  {
    id: 'split-2',
    transaction_id: transaction.id,
    category_id: 'home',
    amount: -125.8,
  },
]

describe('transaction detail model', () => {
  it('uses the override or posted month as the effective budget month', () => {
    expect(effectiveBudgetMonth(transaction)).toBe('2026-09')
    expect(
      effectiveBudgetMonth({
        ...transaction,
        budget_month_override: '2026-08-01',
        effective_budget_month: '2026-08-01',
      }),
    ).toBe('2026-08')
  })

  it('creates a balanced cents-based draft from signed splits', () => {
    const draft = createTransactionBudgetingDraft(transaction, splits)

    expect(draft.splits.map((split) => split.amountCents)).toEqual([
      30_000,
      12_580,
    ])
    expect(validateTransactionDraft(transaction.amount, draft)).toEqual({
      assignedCents: 42_580,
      remainingCents: 0,
      errors: [],
      isValid: true,
    })
  })

  it('reports missing, duplicate, nonpositive, and unbalanced splits', () => {
    const validation = validateTransactionDraft(transaction.amount, {
      budgetMonthOverride: '2026-08',
      isIgnored: false,
      splits: [
        { id: 'one', categoryId: 'groceries', amountCents: 20_000 },
        { id: 'two', categoryId: 'groceries', amountCents: 0 },
        { id: 'three', categoryId: null, amountCents: 1_000 },
      ],
    })

    expect(validation.isValid).toBe(false)
    expect(validation.remainingCents).toBe(21_580)
    expect(validation.errors).toHaveLength(4)
  })

  it('allows an intentionally uncategorized transaction', () => {
    expect(
      validateTransactionDraft(transaction.amount, {
        budgetMonthOverride: null,
        isIgnored: false,
        splits: [],
      }).isValid,
    ).toBe(true)
  })

  it('tracks normalized changes and restores split signs for the RPC', () => {
    const original = createTransactionBudgetingDraft(transaction, splits)
    expect(isTransactionDraftDirty(original, original)).toBe(false)
    expect(
      isTransactionDraftDirty(original, {
        ...original,
        budgetMonthOverride: '2026-08',
      }),
    ).toBe(true)
    expect(rpcSplits(original, transaction.amount)).toEqual([
      { category_id: 'groceries', amount: -300 },
      { category_id: 'home', amount: -125.8 },
    ])
  })
})