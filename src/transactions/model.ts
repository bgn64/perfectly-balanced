import type { TransactionSplit } from '../finance/types.ts'

export interface TransactionSplitDraft {
  key: string
  categoryId: string | null
  amountInput: string
}

export interface TransactionSplitPayload {
  category_id: string
  amount: number
}

export interface TransactionSplitValidation {
  payload: TransactionSplitPayload[] | null
  assignedAmount: number
  remainingAmount: number
  error: string | null
}

function toCents(amount: number): number {
  return Math.round(amount * 100)
}

function fromCents(cents: number): number {
  return cents / 100
}

export function formatSplitAmountInput(amount: number): string {
  return Math.abs(amount).toFixed(2)
}

export function createTransactionSplitDrafts(
  splits: TransactionSplit[],
): TransactionSplitDraft[] {
  return splits.map((split) => ({
    key: split.category_id,
    categoryId: split.category_id,
    amountInput: formatSplitAmountInput(split.amount),
  }))
}

export function parseTransactionSplitAmount(
  value: string,
  transactionAmount: number,
): number | null {
  const normalized = value.trim().replace(/[$,\s]/g, '')
  const match = normalized.match(/^([+-])?(\d+(?:\.\d{1,2})?)$/)
  if (!match) {
    return null
  }
  const magnitude = Number(match[2])
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return null
  }
  const transactionSign = Math.sign(transactionAmount)
  const explicitSign = match[1] === '-' ? -1 : match[1] === '+' ? 1 : null
  if (explicitSign !== null && explicitSign !== transactionSign) {
    return null
  }
  return fromCents(toCents(magnitude) * transactionSign)
}

export function validateTransactionSplitDrafts(
  transactionAmount: number,
  drafts: TransactionSplitDraft[],
): TransactionSplitValidation {
  if (drafts.length === 0) {
    return {
      payload: [],
      assignedAmount: 0,
      remainingAmount: transactionAmount,
      error: null,
    }
  }
  if (transactionAmount === 0) {
    return {
      payload: null,
      assignedAmount: 0,
      remainingAmount: 0,
      error: 'Zero-amount transactions cannot be split.',
    }
  }

  const categoryIds = new Set<string>()
  const payload: TransactionSplitPayload[] = []
  let assignedCents = 0
  for (const draft of drafts) {
    if (!draft.categoryId) {
      return {
        payload: null,
        assignedAmount: fromCents(assignedCents),
        remainingAmount: fromCents(
          toCents(transactionAmount) - assignedCents,
        ),
        error: 'Every split needs a category.',
      }
    }
    if (categoryIds.has(draft.categoryId)) {
      return {
        payload: null,
        assignedAmount: fromCents(assignedCents),
        remainingAmount: fromCents(
          toCents(transactionAmount) - assignedCents,
        ),
        error: 'A category can appear only once in a transaction split.',
      }
    }
    const amount = parseTransactionSplitAmount(
      draft.amountInput,
      transactionAmount,
    )
    if (amount === null) {
      return {
        payload: null,
        assignedAmount: fromCents(assignedCents),
        remainingAmount: fromCents(
          toCents(transactionAmount) - assignedCents,
        ),
        error: 'Every split needs a nonzero amount with the transaction sign.',
      }
    }
    categoryIds.add(draft.categoryId)
    payload.push({ category_id: draft.categoryId, amount })
    assignedCents += toCents(amount)
  }

  const transactionCents = toCents(transactionAmount)
  const remainingCents = transactionCents - assignedCents
  return {
    payload: remainingCents === 0 ? payload : null,
    assignedAmount: fromCents(assignedCents),
    remainingAmount: fromCents(remainingCents),
    error:
      remainingCents === 0
        ? null
        : 'Split amounts must add up to the transaction amount.',
  }
}
