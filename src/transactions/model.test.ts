import { describe, expect, it } from 'vitest'
import type { Transaction } from '../finance/types.ts'
import {
  createTransactionSplitDrafts,
  parseTransactionSplitAmount,
  validateTransactionSplitDrafts,
} from './model.ts'

const transaction: Transaction = {
  id: 'transaction',
  plaid_item_id: null,
  plaid_account_id: null,
  source_transaction_id: 'source',
  transaction_date: '2026-08-31',
  transaction_date_override: '2026-09-01',
  effective_transaction_date: '2026-09-01',
  merchant_name: 'Cedar Cafe',
  transaction_name: null,
  amount: -42,
  currency_code: 'USD',
  is_pending: false,
  is_ignored: false,
  category: 'Food and Drink',
  account_name: 'Credit Card',
  institution_name: 'Northstar Bank',
  imported_at: '2026-09-01T12:00:00Z',
}

describe('transaction split model', () => {
  it('creates editable drafts from persisted splits', () => {
    expect(
      createTransactionSplitDrafts([
        {
          id: 'split',
          transaction_id: transaction.id,
          category_id: 'restaurants',
          amount: -24,
        },
      ]),
    ).toEqual([
      {
        key: 'restaurants',
        categoryId: 'restaurants',
        amountInput: '24.00',
      },
    ])
  })

  it('parses magnitudes using the transaction sign', () => {
    expect(parseTransactionSplitAmount(' $12.50 ', -42)).toBe(-12.5)
    expect(parseTransactionSplitAmount('-12.50', -42)).toBe(-12.5)
    expect(parseTransactionSplitAmount('+12.50', -42)).toBeNull()
  })

  it('requires unique categories and an exact cent total', () => {
    expect(
      validateTransactionSplitDrafts(-42, [
        { key: 'one', categoryId: 'restaurants', amountInput: '24' },
        { key: 'two', categoryId: 'groceries', amountInput: '18' },
      ]),
    ).toEqual({
      payload: [
        { category_id: 'restaurants', amount: -24 },
        { category_id: 'groceries', amount: -18 },
      ],
      assignedAmount: -42,
      remainingAmount: 0,
      error: null,
    })

    expect(
      validateTransactionSplitDrafts(-42, [
        { key: 'one', categoryId: 'restaurants', amountInput: '24' },
        { key: 'two', categoryId: 'restaurants', amountInput: '18' },
      ]).error,
    ).toBe('A category can appear only once in a transaction split.')

    expect(
      validateTransactionSplitDrafts(-42, [
        { key: 'one', categoryId: 'restaurants', amountInput: '20' },
      ]),
    ).toMatchObject({
      payload: null,
      assignedAmount: -20,
      remainingAmount: -22,
      error: 'Split amounts must add up to the transaction amount.',
    })
  })

  it('allows deleting every split to make a transaction uncategorized', () => {
    expect(validateTransactionSplitDrafts(-42, [])).toEqual({
      payload: [],
      assignedAmount: 0,
      remainingAmount: -42,
      error: null,
    })
  })
})
