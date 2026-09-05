import {
  useId,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { CategoryCombobox } from '../finance/CategoryCombobox.tsx'
import type {
  Category,
  Transaction,
  TransactionSplit,
} from '../finance/types.ts'
import {
  formatDisplayMoney,
  formatMonth,
  isTextEntryTarget,
  shiftMonth,
  transactionDescription,
} from '../finance/utils.ts'
import { getSupabaseClient } from '../lib/supabase.ts'
import { AppModal } from '../navigation/AppModal.tsx'
import {
  createTransactionBudgetingDraft,
  effectiveBudgetMonth,
  isTransactionDraftDirty,
  rpcSplits,
  transactionMonth,
  validateTransactionDraft,
  type TransactionBudgetingDraft,
} from './transactionDetailModel.ts'

interface TransactionDetailModalProps {
  budgetMonths: string[]
  categories: Category[]
  createCategory: (name: string) => Promise<Category>
  initialFocus?: 'category' | 'month'
  onClose: () => void
  onSaved: () => Promise<void>
  splits: TransactionSplit[]
  transaction: Transaction
}

interface SplitEdit {
  field: 'amount' | 'category'
  id: string
  originalAmountCents?: number
}

function formatPostedDate(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${date}T00:00:00`))
}

function parseAmountCents(value: string): number | null {
  const normalized = value.trim().replace(/[$,\s]/g, '')
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) {
    return null
  }
  return Math.round(Number(normalized) * 100)
}

export function TransactionDetailModal({
  budgetMonths,
  categories,
  createCategory,
  initialFocus = 'month',
  onClose,
  onSaved,
  splits,
  transaction,
}: TransactionDetailModalProps) {
  const titleId = useId()
  const monthTriggerRef = useRef<HTMLButtonElement>(null)
  const monthMenuRef = useRef<HTMLDivElement>(null)
  const addSplitButtonRef = useRef<HTMLButtonElement>(null)
  const splitRowRefs = useRef(new Map<string, HTMLDivElement>())
  const pendingSplitFocusRef = useRef<string | null | undefined>(undefined)
  const original = useMemo(
    () => createTransactionBudgetingDraft(transaction, splits),
    [splits, transaction],
  )
  const [draft, setDraft] = useState<TransactionBudgetingDraft>(original)
  const [amountInputs, setAmountInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      original.splits.map((split) => [
        split.id,
        (split.amountCents / 100).toFixed(2),
      ]),
    ),
  )
  const [splitEdit, setSplitEdit] = useState<SplitEdit | null>(null)
  const [isMonthMenuOpen, setIsMonthMenuOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const postedMonth = transactionMonth(transaction.transaction_date)
  const selectedMonth =
    draft.budgetMonthOverride ?? effectiveBudgetMonth(transaction)
  const isUsd = transaction.currency_code === 'USD'
  const validation = validateTransactionDraft(transaction.amount, draft)
  const hasInvalidAmount = draft.splits.some(
    (split) => parseAmountCents(amountInputs[split.id] ?? '') === null,
  )
  const isDirty = isTransactionDraftDirty(original, draft)
  const monthOptions = useMemo(() => {
    const months = new Set(budgetMonths.map((month) => month.slice(0, 7)))
    months.add(postedMonth)
    months.add(selectedMonth)
    for (let offset = -12; offset <= 12; offset += 1) {
      months.add(shiftMonth(postedMonth, offset))
    }
    return [...months].sort().reverse()
  }, [budgetMonths, postedMonth, selectedMonth])

  useEffect(() => {
    if (!isMonthMenuOpen) {
      return
    }
    const animationFrame = window.requestAnimationFrame(() => {
      const menu = monthMenuRef.current
      const selected = menu?.querySelector<HTMLElement>('[aria-selected="true"]')
      if (menu && selected) {
        menu.scrollTop =
          selected.offsetTop - (menu.clientHeight - selected.offsetHeight) / 2
      }
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [isMonthMenuOpen])

  useEffect(() => {
    if (splitEdit?.field !== 'amount') {
      return
    }
    const input = document.querySelector<HTMLInputElement>(
      `[data-split-id="${splitEdit.id}"] input[inputmode="decimal"]`,
    )
    input?.focus()
    input?.select()
  }, [splitEdit])

  useEffect(() => {
    if (splitEdit || pendingSplitFocusRef.current === undefined) {
      return
    }
    const splitId = pendingSplitFocusRef.current
    pendingSplitFocusRef.current = undefined
    if (splitId) {
      splitRowRefs.current.get(splitId)?.focus()
    } else {
      addSplitButtonRef.current?.focus()
    }
  }, [draft.splits, splitEdit])

  function updateDraft(update: (current: TransactionBudgetingDraft) => TransactionBudgetingDraft) {
    setDraft(update)
    setSaveError(null)
  }

  function finishSplitEdit(id: string, restoreFocus = true) {
    if (restoreFocus) {
      pendingSplitFocusRef.current = id
    }
    setSplitEdit(null)
  }

  function startCategoryEdit(id: string) {
    setSplitEdit({ field: 'category', id })
  }

  function startAmountEdit(id: string) {
    const split = draft.splits.find((candidate) => candidate.id === id)
    if (!split) {
      return
    }
    setSplitEdit({
      field: 'amount',
      id,
      originalAmountCents: split.amountCents,
    })
  }

  function cancelAmountEdit(id: string) {
    if (splitEdit?.field !== 'amount' || splitEdit.id !== id) {
      return
    }
    const amountCents = splitEdit.originalAmountCents ?? 0
    setAmountInputs((current) => ({
      ...current,
      [id]: (amountCents / 100).toFixed(2),
    }))
    updateDraft((current) => ({
      ...current,
      splits: current.splits.map((candidate) =>
        candidate.id === id ? { ...candidate, amountCents } : candidate,
      ),
    }))
    finishSplitEdit(id)
  }

  function addSplit() {
    if (!isUsd) {
      return
    }
    const id = crypto.randomUUID()
    const amountCents = Math.max(0, validation.remainingCents)
    updateDraft((current) => ({
      ...current,
      splits: [...current.splits, { amountCents, categoryId: null, id }],
    }))
    setAmountInputs((current) => ({
      ...current,
      [id]: (amountCents / 100).toFixed(2),
    }))
    pendingSplitFocusRef.current = id
    setSplitEdit(null)
  }

  function removeSplit(id: string) {
    const splitIndex = draft.splits.findIndex((split) => split.id === id)
    const nextSplitId =
      draft.splits[splitIndex + 1]?.id ?? draft.splits[splitIndex - 1]?.id ?? null
    updateDraft((current) => ({
      ...current,
      splits: current.splits.filter((split) => split.id !== id),
    }))
    setAmountInputs((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setSplitEdit((current) => (current?.id === id ? null : current))
    pendingSplitFocusRef.current = nextSplitId
  }

  async function save() {
    if (!isDirty || !validation.isValid || hasInvalidAmount || isSaving) {
      return
    }
    setIsSaving(true)
    setSaveError(null)
    try {
      const { error } = await getSupabaseClient().rpc(
        'update_transaction_budgeting',
        {
          p_budget_month_override: draft.budgetMonthOverride
            ? `${draft.budgetMonthOverride}-01`
            : null,
          p_is_ignored: draft.isIgnored,
          p_splits: rpcSplits(draft, transaction.amount),
          p_transaction_id: transaction.id,
        },
      )
      if (error) {
        throw new Error(error.message)
      }
      await onSaved()
      onClose()
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : 'The transaction changes could not be saved.',
      )
    } finally {
      setIsSaving(false)
    }
  }

  function handleModalKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && isMonthMenuOpen) {
      event.preventDefault()
      setIsMonthMenuOpen(false)
      window.requestAnimationFrame(() => monthTriggerRef.current?.focus())
      return
    }
    if (isTextEntryTarget(event.target)) {
      return
    }
    const key = event.key.toLocaleLowerCase()
    const focusedSplitRow =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-split-row]')
        : null
    const focusedSplitId = focusedSplitRow?.dataset.splitId
    if (key === 'a' && focusedSplitId) {
      event.preventDefault()
      startAmountEdit(focusedSplitId)
    } else if (key === 'd' && focusedSplitId) {
      event.preventDefault()
      removeSplit(focusedSplitId)
    } else if (key === 'c' && isUsd && focusedSplitId) {
      event.preventDefault()
      startCategoryEdit(focusedSplitId)
    } else if (key === 'm' && isUsd) {
      event.preventDefault()
      setIsMonthMenuOpen(true)
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            '.transaction-month-menu [aria-selected="true"]',
          )
          ?.focus()
      })
    } else if (key === 't') {
      event.preventDefault()
      updateDraft((current) => ({
        ...current,
        isIgnored: !current.isIgnored,
      }))
    }
  }

  const currencyCode = transaction.currency_code ?? 'USD'
  const description = transactionDescription(transaction)
  const transactionIdSuffix = transaction.source_transaction_id.slice(-8)

  return (
    <AppModal
      ariaLabelledBy={titleId}
      className="app-modal--transaction"
      initialFocusSelector={
        initialFocus === 'category'
          ? original.splits.length > 0
            ? '.split-editor-row--navigate'
            : '.transaction-detail-add'
          : '[data-transaction-month]'
      }
      onClose={onClose}
      onKeyDown={handleModalKeyDown}
      statusLabel={`transaction / ${description}`}
    >
      <header className="app-modal__head">
        <div>
          <p className="eyebrow">Transaction details</p>
          <h2 id={titleId}>{description}</h2>
        </div>
        <strong className={transaction.amount < 0 ? 'negative' : 'positive'}>
          {formatDisplayMoney(transaction.amount, currencyCode, true)}
        </strong>
      </header>
      <div className="app-modal__body transaction-detail-body transaction-detail-form">
        <div className="transaction-detail-summary">
          <span
            className={`terminal-pill ${
              transaction.is_pending
                ? 'terminal-pill--warning'
                : 'terminal-pill--ok'
            }`}
          >
            {transaction.is_pending ? 'Pending' : 'Posted'}
          </span>
          <span>{formatPostedDate(transaction.transaction_date)}</span>
          <span>{transaction.account_name}</span>
          {transaction.institution_name && <span>{transaction.institution_name}</span>}
        </div>

        <dl className="transaction-detail-grid transaction-detail-grid--plain">
          <div>
            <dt>Bank description</dt>
            <dd>{transaction.transaction_name ?? description}</dd>
          </div>
          <div>
            <dt>Currency</dt>
            <dd>{transaction.currency_code ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{transaction.plaid_item_id ? 'Plaid import' : 'Imported'}</dd>
          </div>
          <div>
            <dt>Transaction ID</dt>
            <dd>{transactionIdSuffix ? `...${transactionIdSuffix}` : 'Unknown'}</dd>
          </div>
        </dl>

        <div className="transaction-inline-fields">
          <div className="transaction-inline-field">
            <span>
              <strong>Budget month</strong>
              <small>Where it appears in Budget and Reports</small>
            </span>
            <button
              aria-expanded={isMonthMenuOpen}
              className="transaction-month-trigger"
              data-status-action="open month menu"
              data-status-label={`Budget month: ${formatMonth(selectedMonth)}`}
              data-transaction-month
              disabled={!isUsd}
              ref={monthTriggerRef}
              type="button"
              onClick={() => setIsMonthMenuOpen((current) => !current)}
            >
              {formatMonth(selectedMonth)} <span>{isMonthMenuOpen ? '^' : 'v'}</span>
            </button>
            {isMonthMenuOpen && (
              <div
                aria-label="Budget month"
                className="transaction-month-menu"
                ref={monthMenuRef}
                role="listbox"
              >
                {monthOptions.map((month) => {
                  const isSelected = month === selectedMonth
                  const hasBudget = budgetMonths.some(
                    (budgetMonth) => budgetMonth.slice(0, 7) === month,
                  )
                  return (
                    <button
                      aria-selected={isSelected}
                      className={isSelected ? 'is-selected' : ''}
                      key={month}
                      role="option"
                      type="button"
                      onClick={() => {
                        updateDraft((current) => ({
                          ...current,
                          budgetMonthOverride:
                            month === postedMonth ? null : month,
                        }))
                        setIsMonthMenuOpen(false)
                        window.requestAnimationFrame(() =>
                          monthTriggerRef.current?.focus(),
                        )
                      }}
                    >
                      <span>
                        <strong>{formatMonth(month)}</strong>
                        <small>
                          {month === postedMonth
                            ? 'Posted month - reset to default'
                            : hasBudget
                              ? 'Existing budget'
                              : 'No budget yet'}
                        </small>
                      </span>
                      {isSelected && <span aria-hidden="true">x</span>}
                    </button>
                  )
                })}
              </div>
            )}
            {!isUsd && (
              <small className="inline-error">
                Budget month assignment is available for USD transactions.
              </small>
            )}
          </div>

          <div className="transaction-inline-field">
            <span>
              <strong>Inclusion</strong>
              <small>Whether it contributes to totals</small>
            </span>
            <div
              aria-label="Transaction inclusion"
              className="transaction-inclusion-control"
              role="group"
            >
              <button
                className={!draft.isIgnored ? 'is-selected' : ''}
                type="button"
                onClick={() =>
                  updateDraft((current) => ({ ...current, isIgnored: false }))
                }
              >
                Included
              </button>
              <button
                className={draft.isIgnored ? 'is-selected' : ''}
                type="button"
                onClick={() =>
                  updateDraft((current) => ({ ...current, isIgnored: true }))
                }
              >
                Ignored
              </button>
            </div>
          </div>
        </div>

        <section className="transaction-detail-section transaction-allocation-section">
          <header>
            <div>
              <p className="eyebrow">Category allocation</p>
              <h3>Split total across categories</h3>
            </div>
            <button
              className="transaction-detail-add"
              disabled={!isUsd}
              ref={addSplitButtonRef}
              type="button"
              onClick={addSplit}
            >
              + Add split
            </button>
          </header>
          <div className="transaction-split-editor">
            {draft.splits.length > 0 && (
              <div className="split-editor-head" aria-hidden="true">
                <span>Category</span>
                <span>Amount</span>
                <span />
              </div>
            )}
            {draft.splits.map((split, index) => {
              const selectedCategory = categories.find(
                (category) => category.id === split.categoryId,
              )
              const isEditingCategory =
                splitEdit?.id === split.id && splitEdit.field === 'category'
              const isEditingAmount =
                splitEdit?.id === split.id && splitEdit.field === 'amount'
              const categoryLabel = selectedCategory?.name ?? 'Choose category'
              return (
                <div
                  aria-label={`${categoryLabel} split, ${formatDisplayMoney(
                    split.amountCents / 100,
                    currencyCode,
                  )}`}
                  aria-keyshortcuts="a c d"
                  className={`split-editor-row${
                    isEditingCategory || isEditingAmount
                      ? ' split-editor-row--editing'
                      : ' split-editor-row--navigate'
                  }`}
                  data-split-row
                  data-split-id={split.id}
                  data-status-action={
                    isEditingAmount ? 'save amount' : 'edit split'
                  }
                  data-status-label={`transaction / ${description} / ${categoryLabel}`}
                  key={split.id}
                  ref={(row) => {
                    if (row) {
                      splitRowRefs.current.set(split.id, row)
                    } else {
                      splitRowRefs.current.delete(split.id)
                    }
                  }}
                  tabIndex={isEditingCategory || isEditingAmount ? -1 : 0}
                  role="group"
                  onClick={(event) => {
                    if (!isEditingCategory && !isEditingAmount) {
                      event.currentTarget.focus()
                    }
                  }}
                >
                  {isEditingCategory ? (
                    <CategoryCombobox
                      autoFocus
                      categories={categories}
                      disabled={!isUsd}
                      excludedCategoryIds={draft.splits
                        .filter((candidate) => candidate.id !== split.id)
                        .map((candidate) => candidate.categoryId)
                        .filter((categoryId): categoryId is string => Boolean(categoryId))}
                      key={`${split.id}-${split.categoryId ?? 'empty'}`}
                      label={`Split ${index + 1} category`}
                      placeholder="Choose category..."
                      selectedCategory={selectedCategory}
                      semanticContext={{
                        createAction: 'create category',
                        idPrefix: `transaction-split-category-${split.id}`,
                        inputAction: 'search categories',
                        optionAction: 'select category',
                        statusLabel: `transaction / ${description} / ${categoryLabel}`,
                      }}
                      onCancel={() => finishSplitEdit(split.id)}
                      onCreate={createCategory}
                      onSelect={(category) => {
                        updateDraft((current) => ({
                          ...current,
                          splits: current.splits.map((candidate) =>
                            candidate.id === split.id
                              ? { ...candidate, categoryId: category.id }
                              : candidate,
                          ),
                        }))
                        finishSplitEdit(split.id)
                      }}
                    />
                  ) : (
                    <span className="split-category-value">{categoryLabel}</span>
                  )}
                  {isEditingAmount ? (
                    <label>
                      <span className="sr-only">Split {index + 1} amount</span>
                      <input
                        aria-invalid={
                          parseAmountCents(amountInputs[split.id] ?? '') === null
                        }
                        disabled={!isUsd}
                        inputMode="decimal"
                        value={amountInputs[split.id] ?? ''}
                        onChange={(event) => {
                          const value = event.target.value
                          const amountCents = parseAmountCents(value)
                          setAmountInputs((current) => ({
                            ...current,
                            [split.id]: value,
                          }))
                          if (amountCents !== null) {
                            updateDraft((current) => ({
                              ...current,
                              splits: current.splits.map((candidate) =>
                                candidate.id === split.id
                                  ? { ...candidate, amountCents }
                                  : candidate,
                              ),
                            }))
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            const amountCents = parseAmountCents(
                              event.currentTarget.value,
                            )
                            if (amountCents !== null) {
                              event.preventDefault()
                              setAmountInputs((current) => ({
                                ...current,
                                [split.id]: (amountCents / 100).toFixed(2),
                              }))
                              finishSplitEdit(split.id)
                            }
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelAmountEdit(split.id)
                          }
                        }}
                      />
                    </label>
                  ) : (
                    <strong className="split-amount-value">
                      {formatDisplayMoney(
                        split.amountCents / 100,
                        currencyCode,
                      )}
                    </strong>
                  )}
                  <span aria-hidden="true" className="split-row-marker">
                    &gt;
                  </span>
                </div>
              )
            })}
            {draft.splits.length === 0 && (
              <p className="transaction-split-empty">
                This transaction is uncategorized.
              </p>
            )}
            <div className="split-editor-total">
              <span>Assigned</span>
              <strong>
                {formatDisplayMoney(validation.assignedCents / 100, currencyCode)}
              </strong>
              <span>Remaining</span>
              <strong className={validation.remainingCents === 0 ? 'available' : 'negative'}>
                {formatDisplayMoney(validation.remainingCents / 100, currencyCode)}
              </strong>
            </div>
            {(validation.errors.length > 0 || hasInvalidAmount) && (
              <div className="transaction-detail-errors" role="alert">
                {hasInvalidAmount && <span>Enter valid split amounts.</span>}
                {validation.errors.map((error) => (
                  <span key={error}>{error}</span>
                ))}
              </div>
            )}
          </div>
        </section>
        {saveError && (
          <p className="inline-error transaction-detail-save-error" role="alert">
            {saveError}
          </p>
        )}
      </div>
      <footer className="app-modal__foot">
        <span>Imported transaction - bank date unchanged</span>
        <div>
          <button className="terminal-button" type="button" onClick={onClose}>
            Close
          </button>
          <button
            className="terminal-button terminal-button--primary"
            disabled={!isDirty || !validation.isValid || hasInvalidAmount || isSaving}
            type="button"
            onClick={() => void save()}
          >
            {isSaving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </footer>
    </AppModal>
  )
}