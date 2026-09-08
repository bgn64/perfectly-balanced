import { describe, expect, it } from 'vitest'
import {
  isInTransactionTimeRange,
  transactionTimeRangeDescription,
  transactionTimeRanges,
} from './timeRange.ts'

describe('transaction time ranges', () => {
  it('exposes the approved range choices', () => {
    expect(transactionTimeRanges).toEqual([
      { value: 'current-month', label: 'Current month' },
      { value: 'last-3-months', label: 'Last 3 months' },
      { value: 'last-6-months', label: 'Last 6 months' },
      { value: 'last-year', label: 'Last year' },
      { value: 'all-time', label: 'All time' },
    ])
  })

  it('uses inclusive ranges ending at the selected month', () => {
    expect(isInTransactionTimeRange('2026-09', '2026-09', 'current-month')).toBe(true)
    expect(isInTransactionTimeRange('2026-08', '2026-09', 'current-month')).toBe(false)

    expect(isInTransactionTimeRange('2026-07', '2026-09', 'last-3-months')).toBe(true)
    expect(isInTransactionTimeRange('2026-06', '2026-09', 'last-3-months')).toBe(false)

    expect(isInTransactionTimeRange('2026-04', '2026-09', 'last-6-months')).toBe(true)
    expect(isInTransactionTimeRange('2026-03', '2026-09', 'last-6-months')).toBe(false)
  })

  it('treats Last year as the selected month plus its previous 11 months', () => {
    expect(isInTransactionTimeRange('2025-10', '2026-09', 'last-year')).toBe(true)
    expect(isInTransactionTimeRange('2025-09', '2026-09', 'last-year')).toBe(false)
    expect(isInTransactionTimeRange('2026-10', '2026-09', 'last-year')).toBe(false)
  })

  it('includes every month in All time', () => {
    expect(isInTransactionTimeRange('2020-01', '2026-09', 'all-time')).toBe(true)
    expect(isInTransactionTimeRange('2027-01', '2026-09', 'all-time')).toBe(true)
  })

  it('describes each range with concrete month boundaries', () => {
    expect(transactionTimeRangeDescription('2026-09', 'current-month')).toBe(
      'September 2026',
    )
    expect(transactionTimeRangeDescription('2026-09', 'last-3-months')).toBe(
      'July–September 2026',
    )
    expect(transactionTimeRangeDescription('2026-09', 'last-6-months')).toBe(
      'April–September 2026',
    )
    expect(transactionTimeRangeDescription('2026-09', 'last-year')).toBe(
      'October 2025–September 2026',
    )
    expect(transactionTimeRangeDescription('2026-09', 'all-time')).toBe(
      'All imported months',
    )
  })
})