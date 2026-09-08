export type TransactionTimeRange =
  | 'current-month'
  | 'last-3-months'
  | 'last-6-months'
  | 'last-year'
  | 'all-time'

export const transactionTimeRanges: ReadonlyArray<{
  value: TransactionTimeRange
  label: string
}> = [
  { value: 'current-month', label: 'Current month' },
  { value: 'last-3-months', label: 'Last 3 months' },
  { value: 'last-6-months', label: 'Last 6 months' },
  { value: 'last-year', label: 'Last year' },
  { value: 'all-time', label: 'All time' },
]

const rangeStartOffsets: Record<Exclude<TransactionTimeRange, 'all-time'>, number> = {
  'current-month': 0,
  'last-3-months': -2,
  'last-6-months': -5,
  'last-year': -11,
}

function monthDate(month: string): Date {
  return new Date(`${month}-01T00:00:00Z`)
}

export function shiftTransactionMonth(month: string, offset: number): string {
  const date = monthDate(month)
  date.setUTCMonth(date.getUTCMonth() + offset)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function isInTransactionTimeRange(
  transactionMonth: string,
  selectedMonth: string,
  timeRange: TransactionTimeRange,
): boolean {
  if (timeRange === 'all-time') {
    return true
  }
  const firstMonth = shiftTransactionMonth(
    selectedMonth,
    rangeStartOffsets[timeRange],
  )
  return transactionMonth >= firstMonth && transactionMonth <= selectedMonth
}

function formatMonth(month: string, includeYear: boolean): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    timeZone: 'UTC',
    year: includeYear ? 'numeric' : undefined,
  }).format(monthDate(month))
}

export function transactionTimeRangeDescription(
  selectedMonth: string,
  timeRange: TransactionTimeRange,
): string {
  if (timeRange === 'all-time') {
    return 'All imported months'
  }
  const firstMonth = shiftTransactionMonth(
    selectedMonth,
    rangeStartOffsets[timeRange],
  )
  if (firstMonth === selectedMonth) {
    return formatMonth(selectedMonth, true)
  }
  const sameYear = firstMonth.slice(0, 4) === selectedMonth.slice(0, 4)
  return `${formatMonth(firstMonth, !sameYear)}–${formatMonth(selectedMonth, true)}`
}