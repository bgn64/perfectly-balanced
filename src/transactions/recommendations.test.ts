import { describe, expect, it } from 'vitest'
import {
  applicableTransactionRecommendation,
  computeTransactionRecommendations,
  type RecommendationTransaction,
} from './recommendations.ts'

function transaction(
  overrides: Partial<RecommendationTransaction> & { id: string },
): RecommendationTransaction {
  return {
    amount: -20,
    categoryIds: [],
    currencyCode: 'USD',
    effectiveDate: '2026-09-01',
    importedAt: '2026-09-01T12:00:00Z',
    isIgnored: false,
    isPending: false,
    merchantName: 'Corner Shop',
    transactionName: null,
    ...overrides,
  }
}

function recommendationFor(
  transactions: RecommendationTransaction[],
  transactionId = 'target',
) {
  return computeTransactionRecommendations(transactions).find(
    (recommendation) => recommendation.transactionId === transactionId,
  )
}

describe('transaction recommendations', () => {
  it('prefers the latest exact merchant and amount match', () => {
    const recommendation = recommendationFor([
      transaction({
        id: 'merchant-only',
        amount: -30,
        categoryIds: ['restaurants'],
        effectiveDate: '2026-09-05',
        isIgnored: false,
      }),
      transaction({
        id: 'exact',
        categoryIds: ['groceries'],
        effectiveDate: '2026-09-04',
        isIgnored: true,
      }),
      transaction({ id: 'target', effectiveDate: '2026-09-06' }),
    ])

    expect(recommendation).toMatchObject({
      category: {
        match: 'merchant-amount',
        sourceTransactionId: 'exact',
        value: 'groceries',
      },
      ignored: {
        match: 'merchant-amount',
        sourceTransactionId: 'exact',
        value: true,
      },
    })
  })

  it('falls back independently when an exact match has no single category', () => {
    const recommendation = recommendationFor([
      transaction({
        id: 'category-source',
        amount: -30,
        categoryIds: ['groceries'],
        effectiveDate: '2026-09-04',
      }),
      transaction({
        id: 'status-source',
        categoryIds: ['groceries', 'household'],
        effectiveDate: '2026-09-05',
        isIgnored: true,
      }),
      transaction({ id: 'target', effectiveDate: '2026-09-06' }),
    ])

    expect(recommendation?.category).toEqual({
      match: 'merchant',
      sourceTransactionId: 'category-source',
      value: 'groceries',
    })
    expect(recommendation?.ignored).toEqual({
      match: 'merchant-amount',
      sourceTransactionId: 'status-source',
      value: true,
    })
  })

  it('normalizes merchant casing and whitespace and falls back to transaction name', () => {
    const recommendation = recommendationFor([
      transaction({
        id: 'source',
        categoryIds: ['groceries'],
        merchantName: null,
        transactionName: '  CORNER   SHOP ',
      }),
      transaction({
        id: 'target',
        effectiveDate: '2026-09-02',
        merchantName: 'corner shop',
      }),
    ])

    expect(recommendation?.category?.sourceTransactionId).toBe('source')
  })

  it('does not group transactions without a merchant identity', () => {
    expect(
      recommendationFor([
        transaction({
          id: 'source',
          categoryIds: ['groceries'],
          merchantName: null,
          transactionName: null,
        }),
        transaction({
          id: 'target',
          merchantName: null,
          transactionName: null,
        }),
      ]),
    ).toBeUndefined()
  })

  it('uses transaction date, import time, and id as recency tie-breakers', () => {
    const recommendation = recommendationFor([
      transaction({
        id: 'older-date',
        categoryIds: ['older'],
        effectiveDate: '2026-08-31',
        importedAt: '2026-09-03T12:00:00Z',
      }),
      transaction({
        id: 'earlier-import',
        categoryIds: ['earlier'],
        importedAt: '2026-09-01T12:00:00Z',
      }),
      transaction({
        id: 'later-import-a',
        categoryIds: ['a'],
        importedAt: '2026-09-02T12:00:00Z',
      }),
      transaction({
        id: 'later-import-b',
        categoryIds: ['b'],
        importedAt: '2026-09-02T12:00:00Z',
      }),
      transaction({ id: 'target', effectiveDate: '2026-09-03' }),
    ])

    expect(recommendation?.category?.value).toBe('b')
  })

  it('requires the same signed amount and currency for an exact match', () => {
    const recommendations = computeTransactionRecommendations([
      transaction({
        id: 'usd-outflow',
        categoryIds: ['usd-outflow'],
        currencyCode: 'USD',
        effectiveDate: '2026-09-01',
      }),
      transaction({
        id: 'usd-inflow',
        amount: 20,
        categoryIds: ['usd-inflow'],
        currencyCode: 'USD',
        effectiveDate: '2026-09-03',
      }),
      transaction({
        id: 'cad-outflow',
        categoryIds: [],
        currencyCode: 'CAD',
        effectiveDate: '2026-09-04',
        isIgnored: true,
      }),
      transaction({
        id: 'target',
        effectiveDate: '2026-09-05',
      }),
    ])
    const recommendation = recommendations.find(
      (candidate) => candidate.transactionId === 'target',
    )

    expect(recommendation?.category).toMatchObject({
      match: 'merchant-amount',
      sourceTransactionId: 'usd-outflow',
    })
    expect(recommendation?.ignored).toMatchObject({
      match: 'merchant-amount',
      sourceTransactionId: 'usd-outflow',
    })
  })

  it('excludes pending transactions from sources and targets', () => {
    const recommendations = computeTransactionRecommendations([
      transaction({
        id: 'pending-source',
        categoryIds: ['pending'],
        effectiveDate: '2026-09-05',
        isPending: true,
      }),
      transaction({
        id: 'posted-source',
        categoryIds: ['posted'],
        effectiveDate: '2026-09-04',
      }),
      transaction({ id: 'target', effectiveDate: '2026-09-06' }),
      transaction({
        id: 'pending-target',
        effectiveDate: '2026-09-07',
        isPending: true,
      }),
    ])

    expect(
      recommendations.find(
        (recommendation) => recommendation.transactionId === 'target',
      )?.category?.value,
    ).toBe('posted')
    expect(
      recommendations.some(
        (recommendation) => recommendation.transactionId === 'pending-target',
      ),
    ).toBe(false)
  })

  it('returns Included as a valid engine recommendation', () => {
    const recommendation = recommendationFor([
      transaction({ id: 'source', isIgnored: false }),
      transaction({
        id: 'target',
        effectiveDate: '2026-09-02',
        isIgnored: true,
      }),
    ])

    expect(recommendation?.ignored?.value).toBe(false)
  })

  it('surfaces only recommendations that match the manual UI policy', () => {
    const recommendation = recommendationFor([
      transaction({
        id: 'source',
        categoryIds: ['groceries'],
        isIgnored: true,
      }),
      transaction({ id: 'target', effectiveDate: '2026-09-02' }),
    ])

    expect(
      applicableTransactionRecommendation(recommendation, {
        categoryCount: 0,
        currencyCode: 'USD',
        isIgnored: false,
      }),
    ).toMatchObject({
      category: { value: 'groceries' },
      ignored: { value: true },
    })
    expect(
      applicableTransactionRecommendation(recommendation, {
        categoryCount: 1,
        currencyCode: 'USD',
        isIgnored: true,
      }),
    ).toEqual({ category: null, ignored: null })
  })
})
