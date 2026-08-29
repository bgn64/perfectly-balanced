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

export function transactionDescription(transaction: Transaction): string {
  return (
    transaction.merchant_name ??
    transaction.transaction_name ??
    'Transaction'
  )
}
