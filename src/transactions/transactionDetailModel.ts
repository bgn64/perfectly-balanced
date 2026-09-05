import type { Transaction, TransactionSplit } from '../finance/types.ts'

export interface TransactionSplitDraft {
  id: string
  categoryId: string | null
  amountCents: number
}

export interface TransactionBudgetingDraft {
  budgetMonthOverride: string | null
  isIgnored: boolean
  splits: TransactionSplitDraft[]
}

export interface TransactionDraftValidation {
  assignedCents: number
  remainingCents: number
  errors: string[]
  isValid: boolean
}

export function amountToCents(amount: number): number {
  return Math.round(Math.abs(amount) * 100)
}

export function centsToSignedAmount(cents: number, transactionAmount: number) {
  return (transactionAmount < 0 ? -1 : 1) * (cents / 100)
}

export function transactionMonth(transactionDate: string): string {
  return transactionDate.slice(0, 7)
}

export function effectiveBudgetMonth(transaction: Transaction): string {
  return (
    transaction.budget_month_override ??
    transaction.effective_budget_month ??
    transactionMonth(transaction.transaction_date)
  ).slice(0, 7)
}

export function createTransactionBudgetingDraft(
  transaction: Transaction,
  splits: TransactionSplit[],
): TransactionBudgetingDraft {
  return {
    budgetMonthOverride: transaction.budget_month_override?.slice(0, 7) ?? null,
    isIgnored: transaction.is_ignored,
    splits: splits.map((split) => ({
      id: split.id,
      categoryId: split.category_id,
      amountCents: amountToCents(split.amount),
    })),
  }
}

export function validateTransactionDraft(
  transactionAmount: number,
  draft: TransactionBudgetingDraft,
): TransactionDraftValidation {
  const totalCents = amountToCents(transactionAmount)
  const assignedCents = draft.splits.reduce(
    (sum, split) => sum + split.amountCents,
    0,
  )
  const errors: string[] = []

  if (draft.splits.length > 0) {
    if (draft.splits.some((split) => !split.categoryId)) {
      errors.push('Every split requires a category.')
    }
    if (draft.splits.some((split) => split.amountCents <= 0)) {
      errors.push('Every split requires an amount greater than zero.')
    }
    const categoryIds = draft.splits
      .map((split) => split.categoryId)
      .filter((categoryId): categoryId is string => Boolean(categoryId))
    if (new Set(categoryIds).size !== categoryIds.length) {
      errors.push('A category can appear only once in a transaction split.')
    }
    if (assignedCents !== totalCents) {
      errors.push('Split amounts must add up to the transaction total.')
    }
  }

  return {
    assignedCents,
    remainingCents: totalCents - assignedCents,
    errors,
    isValid: errors.length === 0,
  }
}

export function isTransactionDraftDirty(
  original: TransactionBudgetingDraft,
  draft: TransactionBudgetingDraft,
): boolean {
  if (
    original.budgetMonthOverride !== draft.budgetMonthOverride ||
    original.isIgnored !== draft.isIgnored ||
    original.splits.length !== draft.splits.length
  ) {
    return true
  }

  const normalize = (splits: TransactionSplitDraft[]) =>
    splits
      .map((split) => `${split.categoryId ?? ''}:${split.amountCents}`)
      .sort()

  return normalize(original.splits).some(
    (value, index) => value !== normalize(draft.splits)[index],
  )
}

export function rpcSplits(
  draft: TransactionBudgetingDraft,
  transactionAmount: number,
) {
  return draft.splits.map((split) => ({
    category_id: split.categoryId,
    amount: centsToSignedAmount(split.amountCents, transactionAmount),
  }))
}