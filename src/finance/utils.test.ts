import { describe, expect, it } from 'vitest'
import type { Transaction } from './types.ts'
import {
  effectiveTransactionDate,
  formatCalendarDateInput,
  parseCalendarDateInput,
} from './utils.ts'

function transaction(
  transactionDate: string,
  override: string | null,
): Transaction {
  return {
    id: 'transaction',
    plaid_item_id: null,
    plaid_account_id: null,
    source_transaction_id: 'source',
    transaction_date: transactionDate,
    transaction_date_override: override,
    effective_transaction_date: override ?? transactionDate,
    merchant_name: 'Merchant',
    transaction_name: null,
    amount: -10,
    currency_code: 'USD',
    is_pending: false,
    is_ignored: false,
    category: null,
    account_name: 'Checking',
    institution_name: null,
    imported_at: '2026-09-01T12:00:00Z',
  }
}

describe('transaction date helpers', () => {
  it('uses the generated effective transaction date', () => {
    expect(effectiveTransactionDate(transaction('2026-08-31', null))).toBe(
      '2026-08-31',
    )
    expect(
      effectiveTransactionDate(transaction('2026-08-31', '2026-09-01')),
    ).toBe('2026-09-01')
  })

  it('parses valid month/day/year dates strictly', () => {
    expect(parseCalendarDateInput('1/5/2022')).toBe('2022-01-05')
    expect(parseCalendarDateInput(' 02/29/2024 ')).toBe('2024-02-29')
    expect(parseCalendarDateInput('2/29/2023')).toBeNull()
    expect(parseCalendarDateInput('9/31/2026')).toBeNull()
    expect(parseCalendarDateInput('2026-09-01')).toBeNull()
  })

  it('formats ISO calendar dates for editing', () => {
    expect(formatCalendarDateInput('2026-09-01')).toBe('9/1/2026')
  })
})
