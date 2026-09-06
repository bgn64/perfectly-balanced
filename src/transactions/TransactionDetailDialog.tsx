import {
  useCallback,
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
  effectiveTransactionDate,
  formatCalendarDateInput,
  formatMoney,
  parseCalendarDateInput,
  transactionDescription,
} from '../finance/utils.ts'
import { focusWithScrollComfort } from '../navigation/focus.ts'
import type { TransactionDetailInteraction } from '../navigation/status.ts'
import {
  createTransactionSplitDrafts,
  formatSplitAmountInput,
  parseTransactionSplitAmount,
  validateTransactionSplitDrafts,
  type TransactionSplitDraft,
  type TransactionSplitPayload,
} from './model.ts'

function formatCalendarDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${date}T00:00:00`))
}

function formatImportedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function focusableControls(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((control) => !control.closest('[aria-hidden="true"]'))
}

function splitDraftsMatch(
  left: TransactionSplitDraft[],
  right: TransactionSplitDraft[],
  transactionAmount: number,
): boolean {
  if (left.length !== right.length) {
    return false
  }
  const signature = (drafts: TransactionSplitDraft[]) =>
    drafts
      .map((draft) => ({
        amount: parseTransactionSplitAmount(
          draft.amountInput,
          transactionAmount,
        ),
        categoryId: draft.categoryId,
      }))
      .sort((first, second) =>
        (first.categoryId ?? '').localeCompare(second.categoryId ?? ''),
      )
  return JSON.stringify(signature(left)) === JSON.stringify(signature(right))
}

export function TransactionDetailDialog({
  categories,
  onClose,
  onCreateCategory,
  onInteractionChange,
  onSaveDate,
  onSaveSplits,
  onToggleIgnored,
  splits,
  transaction,
}: {
  categories: Category[]
  onClose: () => void
  onCreateCategory: (name: string) => Promise<Category>
  onInteractionChange: (
    interaction: TransactionDetailInteraction | null,
  ) => void
  onSaveDate: (date: string) => Promise<void>
  onSaveSplits: (splits: TransactionSplitPayload[]) => Promise<void>
  onToggleIgnored: () => void
  splits: TransactionSplit[]
  transaction: Transaction
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const dateInputRef = useRef<HTMLInputElement>(null)
  const amountInputRef = useRef<HTMLInputElement>(null)
  const splitRowRefs = useRef(new Map<string, HTMLDivElement>())
  const savingRef = useRef(false)
  const nextDraftKey = useRef(0)
  const previousTransactionIdRef = useRef(transaction.id)
  const persistedDrafts = useMemo(
    () => createTransactionSplitDrafts(splits),
    [splits],
  )
  const [drafts, setDrafts] =
    useState<TransactionSplitDraft[]>(persistedDrafts)
  const [isSplitDraftDirty, setIsSplitDraftDirty] = useState(false)
  const [focusedSplitKey, setFocusedSplitKey] = useState<string | null>(null)
  const [amountEditKey, setAmountEditKey] = useState<string | null>(null)
  const [amountInput, setAmountInput] = useState('')
  const [categoryEditKey, setCategoryEditKey] = useState<string | null>(null)
  const [newSplitKey, setNewSplitKey] = useState<string | null>(null)
  const [isDateEditing, setIsDateEditing] = useState(false)
  const [dateInput, setDateInput] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const validation = useMemo(
    () => validateTransactionSplitDrafts(transaction.amount, drafts),
    [drafts, transaction.amount],
  )
  const categoriesById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  )
  const focusedSplit =
    drafts.find((draft) => draft.key === focusedSplitKey) ?? null
  const isUsd = transaction.currency_code === 'USD'

  useEffect(() => {
    const didChangeTransaction =
      previousTransactionIdRef.current !== transaction.id
    previousTransactionIdRef.current = transaction.id
    if (didChangeTransaction || !isSplitDraftDirty) {
      // oxlint-disable-next-line react/set-state-in-effect -- Persisted split refreshes synchronize an editor that has no local changes.
      setDrafts(persistedDrafts)
      if (isSplitDraftDirty) {
        // oxlint-disable-next-line react/set-state-in-effect -- The refreshed database state has replaced the local draft.
        setIsSplitDraftDirty(false)
      }
      return
    }
    if (splitDraftsMatch(drafts, persistedDrafts, transaction.amount)) {
      // oxlint-disable-next-line react/set-state-in-effect -- Matching persisted values confirm the pending draft has finished saving.
      setIsSplitDraftDirty(false)
    }
  }, [
    drafts,
    isSplitDraftDirty,
    persistedDrafts,
    transaction.amount,
    transaction.id,
  ])

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const mode: TransactionDetailInteraction['mode'] = isSaving
      ? 'saving'
      : isDateEditing
        ? 'date'
        : categoryEditKey
          ? 'category'
          : amountEditKey
            ? 'amount'
            : focusedSplit
              ? 'split'
              : 'detail'
    const splitCategory = focusedSplit?.categoryId
      ? categoriesById.get(focusedSplit.categoryId)?.name
      : null
    onInteractionChange({
      hasUnsavedChanges: isSplitDraftDirty,
      mode,
      label:
        mode === 'split' || mode === 'amount' || mode === 'category'
          ? `transaction / ${transactionDescription(transaction)} / ${
              splitCategory ?? 'new split'
            }`
          : `transaction / ${transactionDescription(transaction)}`,
    })
    return () => onInteractionChange(null)
  }, [
    amountEditKey,
    categoriesById,
    categoryEditKey,
    focusedSplit,
    isDateEditing,
    isSaving,
    isSplitDraftDirty,
    onInteractionChange,
    transaction,
  ])

  const focusSplit = useCallback((key: string | null) => {
    setFocusedSplitKey(key)
    if (!key) {
      return
    }
    window.requestAnimationFrame(() => {
      const row = splitRowRefs.current.get(key)
      if (row) {
        focusWithScrollComfort(row)
      }
    })
  }, [])

  const persistIfValid = useCallback(
    async (nextDrafts: TransactionSplitDraft[]) => {
      const nextValidation = validateTransactionSplitDrafts(
        transaction.amount,
        nextDrafts,
      )
      setErrorMessage(nextValidation.error)
      if (!nextValidation.payload) {
        return false
      }
      if (savingRef.current) {
        return false
      }
      savingRef.current = true
      setIsSaving(true)
      try {
        await onSaveSplits(nextValidation.payload)
        setErrorMessage(null)
        return true
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'The transaction splits could not be saved.',
        )
        return false
      } finally {
        savingRef.current = false
        setIsSaving(false)
      }
    },
    [onSaveSplits, transaction.amount],
  )

  function beginAmountEdit(key: string) {
    if (isSaving) {
      return
    }
    const draft = drafts.find((candidate) => candidate.key === key)
    if (!draft) {
      return
    }
    setFocusedSplitKey(key)
    setAmountEditKey(key)
    setCategoryEditKey(null)
    setAmountInput(draft.amountInput)
    setErrorMessage(null)
    window.requestAnimationFrame(() => {
      amountInputRef.current?.focus({ preventScroll: true })
      amountInputRef.current?.select()
    })
  }

  async function commitAmountEdit() {
    if (!amountEditKey) {
      return
    }
    if (
      parseTransactionSplitAmount(amountInput, transaction.amount) === null
    ) {
      setErrorMessage(
        'Enter a nonzero amount with the same sign as the transaction.',
      )
      return
    }
    const key = amountEditKey
    const nextDrafts = drafts.map((draft) =>
      draft.key === key ? { ...draft, amountInput } : draft,
    )
    setDrafts(nextDrafts)
    setIsSplitDraftDirty(
      !splitDraftsMatch(nextDrafts, persistedDrafts, transaction.amount),
    )
    setAmountEditKey(null)
    await persistIfValid(nextDrafts)
    focusSplit(key)
  }

  function cancelAmountEdit() {
    const key = amountEditKey
    setAmountEditKey(null)
    setErrorMessage(null)
    focusSplit(key)
  }

  function beginCategoryEdit(key: string, isNew = false) {
    if (isSaving) {
      return
    }
    setFocusedSplitKey(key)
    setCategoryEditKey(key)
    setAmountEditKey(null)
    setNewSplitKey(isNew ? key : null)
    setErrorMessage(null)
  }

  async function chooseCategory(key: string, category: Category) {
    const nextDrafts = drafts.map((draft) =>
      draft.key === key
        ? { ...draft, key: category.id, categoryId: category.id }
        : draft,
    )
    setDrafts(nextDrafts)
    setIsSplitDraftDirty(
      !splitDraftsMatch(nextDrafts, persistedDrafts, transaction.amount),
    )
    setCategoryEditKey(null)
    setNewSplitKey(null)
    await persistIfValid(nextDrafts)
    focusSplit(category.id)
  }

  function cancelCategoryEdit() {
    const key = categoryEditKey
    if (key && key === newSplitKey) {
      const nextDrafts = drafts.filter((draft) => draft.key !== key)
      setDrafts(nextDrafts)
      setIsSplitDraftDirty(
        !splitDraftsMatch(nextDrafts, persistedDrafts, transaction.amount),
      )
      const nextFocus = nextDrafts.at(-1)?.key ?? null
      window.requestAnimationFrame(() => {
        if (nextFocus) {
          focusSplit(nextFocus)
        } else {
          dialogRef.current?.focus({ preventScroll: true })
        }
      })
    } else {
      focusSplit(key)
    }
    setCategoryEditKey(null)
    setNewSplitKey(null)
    setErrorMessage(null)
  }

  function addSplit() {
    if (!isUsd || isSaving) {
      return
    }
    const key = `new-${nextDraftKey.current++}`
    const remainingMagnitude = Math.abs(validation.remainingAmount)
    const nextDrafts = [
      ...drafts,
      {
        key,
        categoryId: null,
        amountInput:
          remainingMagnitude > 0
            ? formatSplitAmountInput(validation.remainingAmount)
            : '',
      },
    ]
    setDrafts(nextDrafts)
    setIsSplitDraftDirty(true)
    setFocusedSplitKey(key)
    beginCategoryEdit(key, true)
  }

  async function deleteFocusedSplit() {
    if (!focusedSplitKey || isSaving) {
      return
    }
    const currentIndex = drafts.findIndex(
      (draft) => draft.key === focusedSplitKey,
    )
    const nextDrafts = drafts.filter(
      (draft) => draft.key !== focusedSplitKey,
    )
    setDrafts(nextDrafts)
    setIsSplitDraftDirty(
      !splitDraftsMatch(nextDrafts, persistedDrafts, transaction.amount),
    )
    const nextFocus =
      nextDrafts[Math.min(currentIndex, nextDrafts.length - 1)]?.key ?? null
    await persistIfValid(nextDrafts)
    focusSplit(nextFocus)
  }

  function beginDateEdit() {
    if (isSaving) {
      return
    }
    setFocusedSplitKey(null)
    setIsDateEditing(true)
    setAmountEditKey(null)
    setCategoryEditKey(null)
    setDateInput(
      formatCalendarDateInput(effectiveTransactionDate(transaction)),
    )
    setErrorMessage(null)
    window.requestAnimationFrame(() => {
      dateInputRef.current?.focus({ preventScroll: true })
      dateInputRef.current?.select()
    })
  }

  async function commitDateEdit() {
    if (savingRef.current) {
      return
    }
    const parsedDate = parseCalendarDateInput(dateInput)
    if (!parsedDate) {
      setErrorMessage('Enter a valid date, for example 1/5/2022.')
      return
    }
    savingRef.current = true
    setIsSaving(true)
    try {
      await onSaveDate(parsedDate)
      setIsDateEditing(false)
      setErrorMessage(null)
      dialogRef.current?.focus({ preventScroll: true })
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'The transaction date could not be saved.',
      )
    } finally {
      savingRef.current = false
      setIsSaving(false)
    }
  }

  function cancelDateEdit() {
    setIsDateEditing(false)
    setErrorMessage(null)
    dialogRef.current?.focus({ preventScroll: true })
  }

  function discardSplitChanges() {
    setDrafts(persistedDrafts)
    setIsSplitDraftDirty(false)
    setAmountEditKey(null)
    setCategoryEditKey(null)
    setNewSplitKey(null)
    setFocusedSplitKey(null)
    setErrorMessage(null)
    window.requestAnimationFrame(() => {
      dialogRef.current?.focus({ preventScroll: true })
    })
  }

  function requestClose() {
    if (isSplitDraftDirty) {
      discardSplitChanges()
      return
    }
    onClose()
  }

  function moveSplitFocus(direction: 1 | -1) {
    if (drafts.length === 0) {
      return
    }
    const currentIndex = focusedSplitKey
      ? drafts.findIndex((draft) => draft.key === focusedSplitKey)
      : direction === 1
        ? -1
        : 0
    const nextIndex =
      (currentIndex + direction + drafts.length) % drafts.length
    focusSplit(drafts[nextIndex].key)
  }

  function trapFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') {
      return
    }
    const controls = focusableControls(event.currentTarget)
    if (controls.length === 0) {
      return
    }
    const currentIndex = controls.indexOf(document.activeElement as HTMLElement)
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + (event.shiftKey ? -1 : 1) + controls.length) %
          controls.length
    event.preventDefault()
    controls[nextIndex]?.focus()
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    trapFocus(event)
    if (event.defaultPrevented || event.altKey || event.metaKey) {
      return
    }
    if (isSaving) {
      event.preventDefault()
      return
    }
    if (event.target instanceof HTMLInputElement) {
      return
    }
    const key = event.key.toLocaleLowerCase()
    if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
      return
    }
    if (key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      moveSplitFocus(1)
      return
    }
    if (key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveSplitFocus(-1)
      return
    }
    if (key === 'n') {
      event.preventDefault()
      addSplit()
      return
    }
    if (key === 'e') {
      event.preventDefault()
      beginDateEdit()
      return
    }
    if (key === 't') {
      event.preventDefault()
      onToggleIgnored()
      return
    }
    if (!focusedSplitKey) {
      return
    }
    if (key === 'a') {
      event.preventDefault()
      beginAmountEdit(focusedSplitKey)
    } else if (key === 'c') {
      event.preventDefault()
      beginCategoryEdit(focusedSplitKey)
    } else if (key === 'd') {
      event.preventDefault()
      void deleteFocusedSplit()
    }
  }

  const effectiveDate = effectiveTransactionDate(transaction)
  const importedStatus = transaction.is_pending ? 'Pending' : 'Posted'
  const assignedAmount = validation.assignedAmount
  const remainingAmount = validation.remainingAmount
  const splitValidationMessage = isSplitDraftDirty
    ? validation.error ?? 'Unsaved split changes.'
    : null
  const displayedError = errorMessage ?? splitValidationMessage

  return (
    <div className="transaction-control-layer">
      <section
        aria-labelledby="transaction-detail-title"
        aria-modal="true"
        className={`transaction-control-dialog transaction-detail-dialog${
          categoryEditKey ? ' transaction-detail-dialog--picker' : ''
        }`}
        data-semantic-id={`transaction-detail-${transaction.id}`}
        data-semantic-kind="transaction-detail"
        data-semantic-region="workspace"
        data-status-action="close"
        data-status-label={`transaction / ${transactionDescription(transaction)}`}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="transaction-dialog-head transaction-detail-dialog__head">
          <div>
            <p className="eyebrow">Transaction details</p>
            <h2 id="transaction-detail-title">
              {transactionDescription(transaction)}
            </h2>
            <p>
              {transaction.account_name} · {importedStatus}
            </p>
          </div>
          <div className="transaction-detail-heading-actions">
            <strong
              className={transaction.amount >= 0 ? 'positive' : 'negative'}
            >
              {formatMoney(
                transaction.amount,
                transaction.currency_code ?? 'USD',
              )}
            </strong>
            <button
              aria-label="Close transaction details"
              className="transaction-detail-close"
              disabled={isSaving || isSplitDraftDirty}
              type="button"
              onFocus={() => setFocusedSplitKey(null)}
              onClick={requestClose}
            >
              ×
            </button>
          </div>
        </header>

        <div className="transaction-detail-dialog__body">
          <div className="transaction-detail-primary">
            <section className="transaction-detail-section">
              <header className="transaction-detail-section__head">
                <div>
                  <p className="eyebrow">Budget attribution</p>
                  <h3>
                    {new Intl.DateTimeFormat(undefined, {
                      month: 'long',
                      year: 'numeric',
                    }).format(new Date(`${effectiveDate}T00:00:00`))}
                  </h3>
                </div>
                <button
                  className={`transaction-state-button${
                    transaction.is_ignored ? ' is-ignored' : ''
                  }`}
                  disabled={isSaving}
                  type="button"
                  onFocus={() => setFocusedSplitKey(null)}
                  onClick={onToggleIgnored}
                >
                  {transaction.is_ignored ? 'Ignored' : 'Included'}
                </button>
              </header>
              <div className="transaction-date-summary">
                {isDateEditing ? (
                  <label className="transaction-detail-field transaction-detail-field--editing">
                    <span>
                      Budget date
                      <small>Month/day/year, for example 1/5/2022</small>
                    </span>
                    <input
                      aria-invalid={errorMessage ? 'true' : undefined}
                      disabled={isSaving}
                      ref={dateInputRef}
                      value={dateInput}
                      onChange={(event) => {
                        setDateInput(event.target.value)
                        setErrorMessage(null)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void commitDateEdit()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelDateEdit()
                        }
                      }}
                    />
                  </label>
                ) : (
                  <button
                    className="transaction-detail-field transaction-detail-field--editable"
                    data-semantic-id={`transaction-detail-date-${transaction.id}`}
                    data-semantic-kind="transaction-detail-date"
                    data-semantic-region="workspace"
                    data-status-action="edit date"
                    data-status-label={`transaction / ${transactionDescription(transaction)} / date`}
                    type="button"
                    onFocus={() => setFocusedSplitKey(null)}
                    onClick={beginDateEdit}
                  >
                    <span>
                      Budget date
                      <small>
                        Used by budgets, reports, filters, and sorting
                      </small>
                    </span>
                    <strong>{formatCalendarDate(effectiveDate)}</strong>
                  </button>
                )}
                <div className="transaction-detail-field">
                  <span>
                    Original date
                    <small>Imported value · never overwritten</small>
                  </span>
                  <strong>{formatCalendarDate(transaction.transaction_date)}</strong>
                </div>
              </div>
              {isDateEditing && errorMessage && (
                <p
                  className="form-message form-message--error transaction-date-error"
                  role="alert"
                >
                  {errorMessage}
                </p>
              )}
            </section>

            <section className="transaction-detail-section">
              <header className="transaction-detail-section__head">
                <div>
                  <p className="eyebrow">Category allocation</p>
                  <h3>
                    {drafts.length === 0
                      ? 'Uncategorized'
                      : `${drafts.length} ${
                          drafts.length === 1 ? 'category' : 'category splits'
                        }`}
                  </h3>
                </div>
                <button
                  className="terminal-button transaction-detail-add"
                  disabled={!isUsd || isSaving}
                  type="button"
                  onFocus={() => setFocusedSplitKey(null)}
                  onClick={addSplit}
                >
                  + New split
                </button>
              </header>
              {!isUsd ? (
                <p className="transaction-detail-note">
                  Only USD transactions can be categorized.
                </p>
              ) : (
                <>
                  <div className="transaction-split-head" aria-hidden="true">
                    <span>Category</span>
                    <span>Amount</span>
                  </div>
                  <div className="transaction-split-list">
                    {drafts.map((draft) => {
                      const category = draft.categoryId
                        ? categoriesById.get(draft.categoryId) ?? null
                        : null
                      const isFocused = draft.key === focusedSplitKey
                      const isEditingAmount = draft.key === amountEditKey
                      const isEditingCategory = draft.key === categoryEditKey
                      return (
                        <div
                          className={`transaction-split-row${
                            isFocused ? ' is-focused' : ''
                          }${
                            isEditingAmount
                              ? ' transaction-split-row--amount-edit'
                              : ''
                          }${
                            isEditingCategory
                              ? ' transaction-split-row--editing'
                              : ''
                          }`}
                          data-semantic-id={`transaction-split-${draft.key}`}
                          data-semantic-kind="transaction-split"
                          data-semantic-region="workspace"
                          data-status-action="edit split"
                          data-status-label={`transaction / ${transactionDescription(transaction)} / ${
                            category?.name ?? 'new split'
                          }`}
                          key={draft.key}
                          ref={(row) => {
                            if (row) {
                              splitRowRefs.current.set(draft.key, row)
                            } else {
                              splitRowRefs.current.delete(draft.key)
                            }
                          }}
                          tabIndex={isEditingCategory || isEditingAmount ? -1 : 0}
                          onClick={(event) => {
                            if (
                              (event.target as HTMLElement).closest(
                                'button, input, [role="combobox"]',
                              )
                            ) {
                              return
                            }
                            focusSplit(draft.key)
                          }}
                          onFocus={(event) => {
                            if (event.currentTarget === event.target) {
                              setFocusedSplitKey(draft.key)
                            }
                          }}
                        >
                          {isEditingCategory ? (
                            <CategoryCombobox
                              autoFocus
                              categories={categories}
                              className="transaction-split-category-editor"
                              disabled={isSaving}
                              excludedCategoryIds={drafts
                                .filter(
                                  (candidate) =>
                                    candidate.key !== draft.key &&
                                    candidate.categoryId,
                                )
                                .map(
                                  (candidate) =>
                                    candidate.categoryId as string,
                                )}
                              label={`Choose a split category for ${transactionDescription(transaction)}`}
                              placeholder="Search categories"
                              semanticContext={{
                                createAction: 'create transaction category',
                                idPrefix: `transaction-detail-category-${draft.key}`,
                                inputAction: 'search categories',
                                optionAction: 'select category',
                                statusLabel: `transaction / ${transactionDescription(transaction)} / split category`,
                              }}
                              selectedCategory={category ?? undefined}
                              onCancel={cancelCategoryEdit}
                              onCreate={onCreateCategory}
                              onSelect={(selectedCategory) =>
                                chooseCategory(draft.key, selectedCategory)
                              }
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                focusSplit(draft.key)
                              }}
                            >
                              <span className="transaction-split-caret">›</span>
                              <span>
                                <strong>{category?.name ?? 'Choose category'}</strong>
                              </span>
                            </button>
                          )}
                          {isEditingAmount ? (
                            <label className="transaction-split-amount">
                              <span className="sr-only">Split amount</span>
                              <input
                                aria-invalid={errorMessage ? 'true' : undefined}
                                ref={amountInputRef}
                                value={amountInput}
                                onChange={(event) => {
                                  setAmountInput(event.target.value)
                                  setErrorMessage(null)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    void commitAmountEdit()
                                  } else if (event.key === 'Escape') {
                                    event.preventDefault()
                                    cancelAmountEdit()
                                  }
                                }}
                              />
                            </label>
                          ) : (
                            <button
                              aria-label={`Edit split amount for ${
                                category?.name ?? 'new split'
                              }`}
                              className="transaction-split-amount-button"
                              disabled={isSaving}
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                beginAmountEdit(draft.key)
                              }}
                            >
                              {parseTransactionSplitAmount(
                                draft.amountInput,
                                transaction.amount,
                              ) === null
                                ? draft.amountInput || '—'
                                : formatMoney(
                                    parseTransactionSplitAmount(
                                      draft.amountInput,
                                      transaction.amount,
                                    ) as number,
                                    transaction.currency_code ?? 'USD',
                                  )}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <div
                    className={`transaction-split-total${
                      validation.error ? ' transaction-split-total--pending' : ''
                    }`}
                  >
                    <span>
                      Assigned{' '}
                      <strong>
                        {formatMoney(
                          assignedAmount,
                          transaction.currency_code ?? 'USD',
                        )}
                      </strong>
                    </span>
                    <span className={remainingAmount === 0 ? 'available' : 'warning'}>
                      Remaining{' '}
                      <strong>
                        {formatMoney(
                          remainingAmount,
                          transaction.currency_code ?? 'USD',
                        )}
                      </strong>
                    </span>
                  </div>
                  {!isDateEditing && displayedError && (
                    <p className="transaction-split-error" role="alert">
                      {displayedError}
                    </p>
                  )}
                </>
              )}
            </section>
          </div>

          <aside className="transaction-import-details">
            <div>
              <p className="eyebrow">Imported details</p>
              <h3>Source record</h3>
            </div>
            <dl>
              <div>
                <dt>Merchant</dt>
                <dd>{transaction.merchant_name ?? 'Not provided'}</dd>
              </div>
              <div>
                <dt>Original description</dt>
                <dd>{transaction.transaction_name ?? 'Not provided'}</dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{transaction.account_name}</dd>
              </div>
              <div>
                <dt>Connection</dt>
                <dd>{transaction.institution_name ?? 'Previous import'}</dd>
              </div>
              <div>
                <dt>Bank category</dt>
                <dd>{transaction.category ?? 'Not provided'}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{importedStatus}</dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{transaction.currency_code ?? 'Not provided'}</dd>
              </div>
              <div>
                <dt>Imported</dt>
                <dd>{formatImportedAt(transaction.imported_at)}</dd>
              </div>
              <div>
                <dt>Source transaction ID</dt>
                <dd>
                  <code>{transaction.source_transaction_id}</code>
                </dd>
              </div>
              {transaction.plaid_account_id && (
                <div>
                  <dt>Source account ID</dt>
                  <dd>
                    <code>{transaction.plaid_account_id}</code>
                  </dd>
                </div>
              )}
            </dl>
            <p className="transaction-detail-note">
              Edits change budgeting behavior only. Imported source values remain
              available here.
            </p>
          </aside>
        </div>

        <footer className="transaction-dialog-actions transaction-detail-dialog__actions">
          <span
            className={`transaction-detail-save-state${
              displayedError ? ' transaction-detail-save-state--pending' : ''
            }`}
          >
            {isSaving
              ? 'Saving changes...'
              : displayedError
                ? displayedError
                : 'All changes saved'}
          </span>
          <span />
          <button
            className="terminal-button"
            disabled={isSaving}
            type="button"
            onClick={requestClose}
          >
            {isSplitDraftDirty ? 'Discard changes' : 'Close'}
          </button>
        </footer>
      </section>
    </div>
  )
}
