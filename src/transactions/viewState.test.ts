import { describe, expect, it } from 'vitest'
import { createDefaultTransactionViewState } from './viewState.ts'

describe('transaction view state', () => {
  it('creates the session defaults', () => {
    expect(createDefaultTransactionViewState()).toEqual({
      timeRange: 'current-month',
      filters: [],
      sort: 'newest',
    })
  })

  it('does not share mutable filters between authenticated shells', () => {
    const first = createDefaultTransactionViewState()
    const second = createDefaultTransactionViewState()
    first.filters.push('uncategorized')
    expect(second.filters).toEqual([])
  })
})