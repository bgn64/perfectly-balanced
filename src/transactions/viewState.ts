import type { TransactionTimeRange } from './timeRange.ts'

export type TransactionSort =
  | 'newest'
  | 'oldest'
  | 'merchant'
  | 'amount-high'
  | 'amount-low'

export type TransactionFilter =
  | 'categorized'
  | 'uncategorized'
  | 'included'
  | 'ignored'

export interface TransactionViewState {
  timeRange: TransactionTimeRange
  filters: TransactionFilter[]
  sort: TransactionSort
}

export function createDefaultTransactionViewState(): TransactionViewState {
  return {
    timeRange: 'current-month',
    filters: [],
    sort: 'newest',
  }
}