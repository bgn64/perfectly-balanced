import type { Transaction } from './types.ts'

export function currentMonth(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function formatMonth(month: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${month}-01T00:00:00`))
}

export function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split('-').map(Number)
  const date = new Date(year, monthNumber - 1 + offset, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function monthKey(date: string): string {
  return date.slice(0, 7)
}

export function effectiveTransactionDate(
  transaction: Pick<Transaction, 'effective_transaction_date'>,
): string {
  return transaction.effective_transaction_date
}

export function parseCalendarDateInput(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!match) {
    return null
  }
  const month = Number(match[1])
  const day = Number(match[2])
  const year = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function formatCalendarDateInput(date: string): string {
  const [year, month, day] = date.split('-')
  return `${Number(month)}/${Number(day)}/${year}`
}

export function formatMoney(
  amount: number,
  currencyCode = 'USD',
  sign = false,
): string {
  const formatted = new Intl.NumberFormat(undefined, {
    currency: currencyCode,
    style: 'currency',
  }).format(amount)

  return sign && amount > 0 ? `+${formatted}` : formatted
}

export function formatDisplayMoney(
  amount: number,
  currencyCode = 'USD',
  sign = false,
): string {
  const formatted = new Intl.NumberFormat(undefined, {
    currency: currencyCode,
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    style: 'currency',
  }).format(amount)

  return sign && amount > 0 ? `+${formatted}` : formatted
}

export function parseMagnitude(value: string): number | null {
  const normalized = value.trim().replace(/[$,\s]/g, '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null
  }

  const amount = Number(normalized)
  return Number.isFinite(amount) ? amount : null
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  )
}

export function transactionDescription(transaction: Transaction): string {
  return (
    transaction.merchant_name ??
    transaction.transaction_name ??
    'Transaction'
  )
}
