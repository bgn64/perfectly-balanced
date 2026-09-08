export const transactionRecommendationEngineVersion = 'merchant-recency-v1'

export type TransactionRecommendationMatch = 'merchant-amount' | 'merchant'

export interface RecommendationTransaction {
  id: string
  amount: number
  categoryIds: readonly string[]
  currencyCode: string | null
  effectiveDate: string
  importedAt: string
  isIgnored: boolean
  isPending: boolean
  merchantName: string | null
  transactionName: string | null
}

export interface RecommendedAction<T> {
  match: TransactionRecommendationMatch
  sourceTransactionId: string
  value: T
}

export interface TransactionRecommendation {
  category: RecommendedAction<string> | null
  engineVersion: string
  ignored: RecommendedAction<boolean> | null
  transactionId: string
}

export interface ApplicableTransactionRecommendation {
  category: RecommendedAction<string> | null
  ignored: RecommendedAction<true> | null
}

export function applicableTransactionRecommendation(
  recommendation: TransactionRecommendation | undefined,
  target: {
    categoryCount: number
    currencyCode: string | null
    isIgnored: boolean
  },
): ApplicableTransactionRecommendation {
  const category =
    target.categoryCount === 0 && target.currencyCode === 'USD'
      ? recommendation?.category ?? null
      : null
  const ignored =
    !target.isIgnored && recommendation?.ignored?.value === true
      ? {
          ...recommendation.ignored,
          value: true as const,
        }
      : null
  return { category, ignored }
}

function normalizedMerchant(
  transaction: Pick<
    RecommendationTransaction,
    'merchantName' | 'transactionName'
  >,
): string | null {
  const merchant = (
    transaction.merchantName ?? transaction.transactionName
  )
    ?.trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US')
  return merchant || null
}

function compareByRecency(
  left: RecommendationTransaction,
  right: RecommendationTransaction,
): number {
  return (
    right.effectiveDate.localeCompare(left.effectiveDate) ||
    right.importedAt.localeCompare(left.importedAt) ||
    right.id.localeCompare(left.id)
  )
}

function amountKey(
  merchant: string,
  transaction: Pick<RecommendationTransaction, 'amount' | 'currencyCode'>,
): string {
  const amount = Object.is(transaction.amount, -0) ? 0 : transaction.amount
  return `${merchant}\u0000${transaction.currencyCode ?? ''}\u0000${amount}`
}

function firstCandidate(
  candidates: readonly RecommendationTransaction[],
  transactionId: string,
  eligible: (candidate: RecommendationTransaction) => boolean,
): RecommendationTransaction | null {
  return (
    candidates.find(
      (candidate) => candidate.id !== transactionId && eligible(candidate),
    ) ?? null
  )
}

function recommendedAction<T>(
  exactCandidates: readonly RecommendationTransaction[],
  merchantCandidates: readonly RecommendationTransaction[],
  transactionId: string,
  eligible: (candidate: RecommendationTransaction) => boolean,
  value: (candidate: RecommendationTransaction) => T,
): RecommendedAction<T> | null {
  const exact = firstCandidate(exactCandidates, transactionId, eligible)
  if (exact) {
    return {
      match: 'merchant-amount',
      sourceTransactionId: exact.id,
      value: value(exact),
    }
  }
  const merchant = firstCandidate(
    merchantCandidates,
    transactionId,
    eligible,
  )
  return merchant
    ? {
        match: 'merchant',
        sourceTransactionId: merchant.id,
        value: value(merchant),
      }
    : null
}

export function computeTransactionRecommendations(
  transactions: readonly RecommendationTransaction[],
): TransactionRecommendation[] {
  const postedTransactions = transactions
    .filter((transaction) => !transaction.isPending)
    .sort(compareByRecency)
  const byMerchant = new Map<string, RecommendationTransaction[]>()
  const byMerchantAmount = new Map<string, RecommendationTransaction[]>()

  for (const transaction of postedTransactions) {
    const merchant = normalizedMerchant(transaction)
    if (!merchant) {
      continue
    }
    const merchantHistory = byMerchant.get(merchant) ?? []
    merchantHistory.push(transaction)
    byMerchant.set(merchant, merchantHistory)

    const exactKey = amountKey(merchant, transaction)
    const exactHistory = byMerchantAmount.get(exactKey) ?? []
    exactHistory.push(transaction)
    byMerchantAmount.set(exactKey, exactHistory)
  }

  const recommendations: TransactionRecommendation[] = []
  for (const transaction of postedTransactions) {
    const merchant = normalizedMerchant(transaction)
    if (!merchant) {
      continue
    }
    const merchantCandidates = byMerchant.get(merchant) ?? []
    const exactCandidates =
      byMerchantAmount.get(amountKey(merchant, transaction)) ?? []
    const category =
      transaction.currencyCode === 'USD'
        ? recommendedAction(
            exactCandidates,
            merchantCandidates,
            transaction.id,
            (candidate) =>
              candidate.currencyCode === 'USD' &&
              candidate.categoryIds.length === 1,
            (candidate) => candidate.categoryIds[0],
          )
        : null
    const ignored = recommendedAction(
      exactCandidates,
      merchantCandidates,
      transaction.id,
      () => true,
      (candidate) => candidate.isIgnored,
    )

    if (category || ignored) {
      recommendations.push({
        category,
        engineVersion: transactionRecommendationEngineVersion,
        ignored,
        transactionId: transaction.id,
      })
    }
  }
  return recommendations
}
