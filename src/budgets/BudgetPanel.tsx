import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { CategoryCombobox } from '../finance/CategoryCombobox.tsx'
import { collectPages } from '../finance/query.ts'
import type {
  Budget,
  BudgetAllocation,
  BudgetDirection,
  BudgetSubsection,
  Category,
} from '../finance/types.ts'
import {
  formatDisplayMoney,
  formatMonth,
  parseMagnitude,
  shiftMonth,
} from '../finance/utils.ts'
import { getSupabaseClient } from '../lib/supabase.ts'
import { useAuth } from '../auth/useAuth.ts'

interface BudgetData {
  budgets: Budget[]
  budget: Budget | null
  subsections: BudgetSubsection[]
  allocations: BudgetAllocation[]
  categories: Category[]
  uncategorizedCount: number
}

interface AmountEditRequest {
  allocationId: string
  sequence: number
}

async function queryBudget(month: string): Promise<BudgetData> {
  const client = getSupabaseClient()
  const [budgetsResult, categoriesResult, transactions, splits] = await Promise.all([
    client.from('budgets').select('id, month').order('month', { ascending: false }),
    client.from('categories').select('id, name').order('name'),
    collectPages((afterId, limit) => {
      let query = client.from('transactions').select('id').order('id').limit(limit)
      if (afterId) {
        query = query.gt('id', afterId)
      }
      return query
    }),
    collectPages((afterId, limit) => {
      let query = client
        .from('transaction_category_splits')
        .select('id, transaction_id')
        .order('id')
        .limit(limit)
      if (afterId) {
        query = query.gt('id', afterId)
      }
      return query
    }),
  ])

  if (budgetsResult.error) {
    throw new Error(budgetsResult.error.message)
  }
  if (categoriesResult.error) {
    throw new Error(categoriesResult.error.message)
  }

  const budgets = budgetsResult.data ?? []
  const categorizedTransactionIds = new Set(
    splits.map((split) => split.transaction_id),
  )
  const uncategorizedCount = transactions.filter(
    (transaction) => !categorizedTransactionIds.has(transaction.id),
  ).length
  const budget =
    budgets.find((candidate) => candidate.month.slice(0, 7) === month) ?? null

  if (!budget) {
    return {
      budgets,
      budget: null,
      subsections: [],
      allocations: [],
      categories: categoriesResult.data ?? [],
      uncategorizedCount,
    }
  }

  const [subsectionsResult, allocationsResult] = await Promise.all([
    client
      .from('budget_subsections')
      .select('id, name, position')
      .eq('budget_id', budget.id)
      .order('position'),
    client
      .from('budget_category_activity')
      .select(
        'allocation_id, category_id, category_name, subsection_id, subsection_name, position, direction, budgeted_amount, actual_amount',
      )
      .eq('budget_id', budget.id)
      .order('position'),
  ])

  if (subsectionsResult.error) {
    throw new Error(subsectionsResult.error.message)
  }
  if (allocationsResult.error) {
    throw new Error(allocationsResult.error.message)
  }

  return {
    budgets,
    budget,
    subsections: subsectionsResult.data ?? [],
    allocations: (allocationsResult.data ?? []).map((allocation) => ({
      ...allocation,
      budgeted_amount: Number(allocation.budgeted_amount),
      actual_amount: Number(allocation.actual_amount),
    })),
    categories: categoriesResult.data ?? [],
    uncategorizedCount,
  }
}

export function BudgetPanel({
  categoriesRevision,
  activityRevision,
  onCategoriesChanged,
  selectedMonth,
  onMonthChange,
  focusedSemanticId,
  amountEditRequest,
  onAmountEditorClosed,
  onAmountEditorOpenChange,
}: {
  categoriesRevision: number
  activityRevision: number
  onCategoriesChanged: () => void
  selectedMonth: string
  onMonthChange: (month: string) => void
  focusedSemanticId: string | null
  amountEditRequest: AmountEditRequest | null
  onAmountEditorClosed: (allocationId: string) => void
  onAmountEditorOpenChange: (isOpen: boolean) => void
}) {
  const { user } = useAuth()
  const [budget, setBudget] = useState<Budget | null>(null)
  const [subsections, setSubsections] = useState<BudgetSubsection[]>([])
  const [allocations, setAllocations] = useState<BudgetAllocation[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [uncategorizedCount, setUncategorizedCount] = useState(0)
  const [editingAllocationId, setEditingAllocationId] = useState<string | null>(
    null,
  )
  const [isAddingCategory, setIsAddingCategory] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const mutationBusy = useRef(false)

  const loadBudget = useCallback(async () => {
    const generation = ++requestGeneration.current
    try {
      const data = await queryBudget(selectedMonth)
      if (generation !== requestGeneration.current) {
        return
      }
      setBudget(data.budget)
      setSubsections(data.subsections)
      setAllocations(data.allocations)
      setCategories(data.categories)
      setUncategorizedCount(data.uncategorizedCount)
      setEditingAllocationId(null)
      setErrorMessage(null)
    } catch (error) {
      if (generation === requestGeneration.current) {
        setErrorMessage(
          error instanceof Error ? error.message : 'We could not load this budget.',
        )
      }
    } finally {
      if (generation === requestGeneration.current) {
        setIsLoading(false)
      }
    }
  }, [selectedMonth])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect synchronizes the selected month with Supabase.
    void loadBudget()
    return () => {
      requestGeneration.current += 1
    }
  }, [activityRevision, categoriesRevision, loadBudget])

  useEffect(() => {
    if (
      amountEditRequest &&
      allocations.some(
        (allocation) => allocation.allocation_id === amountEditRequest.allocationId,
      )
    ) {
      // oxlint-disable-next-line react/set-state-in-effect -- A semantic navigation request opens the matching row editor.
      setEditingAllocationId(amountEditRequest.allocationId)
      onAmountEditorOpenChange(true)
    }
  }, [allocations, amountEditRequest, onAmountEditorOpenChange])

  async function runMutation(
    id: string,
    mutation: () => PromiseLike<{ error: { message: string } | null }>,
    refreshOnSuccess = true,
  ): Promise<boolean> {
    if (mutationBusy.current) {
      return false
    }
    mutationBusy.current = true
    setBusyId(id)
    setErrorMessage(null)
    try {
      const { error } = await mutation()
      if (error) {
        setErrorMessage(error.message)
        return false
      }
      if (refreshOnSuccess) {
        await loadBudget()
      }
      return true
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'The budget change could not be saved.',
      )
      return false
    } finally {
      mutationBusy.current = false
      setBusyId(null)
    }
  }

  async function createCategory(name: string): Promise<Category> {
    if (!user) {
      throw new Error('Authentication is required.')
    }
    const { data, error } = await getSupabaseClient()
      .from('categories')
      .insert({ name: name.trim(), user_id: user.id })
      .select('id, name')
      .single()
    if (error) {
      throw new Error(
        error.code === '23505' ? 'Category names must be unique.' : error.message,
      )
    }
    setCategories((current) =>
      [...current, data].sort((left, right) => left.name.localeCompare(right.name)),
    )
    onCategoriesChanged()
    return data
  }

  async function addRootAllocation(category: Category): Promise<void> {
    if (!budget) {
      throw new Error('Create this month before adding categories.')
    }
    const didSave = await runMutation('add-root', () =>
      getSupabaseClient().rpc('create_budget_category_allocation', {
        p_budget_id: budget.id,
        p_category_id: category.id,
        p_subsection_id: null,
        p_magnitude: 0,
        p_direction: 'spending',
      }),
    )
    if (!didSave) {
      throw new Error('The category could not be added to this budget.')
    }
  }

  async function updateAllocation(
    allocation: BudgetAllocation,
    magnitude: number,
    direction: BudgetDirection,
  ): Promise<boolean> {
    setAllocations((current) =>
      current.map((candidate) =>
        candidate.allocation_id === allocation.allocation_id
          ? {
              ...candidate,
              budgeted_amount: magnitude,
              direction,
            }
          : candidate,
      ),
    )
    const didSave = await runMutation(
      allocation.allocation_id,
      () =>
        getSupabaseClient().rpc('update_budget_category_allocation', {
          p_allocation_id: allocation.allocation_id,
          p_magnitude: magnitude,
          p_direction: direction,
        }),
      false,
    )
    if (!didSave) {
      setAllocations((current) =>
        current.map((candidate) =>
          candidate.allocation_id === allocation.allocation_id
            ? allocation
            : candidate,
        ),
      )
      return false
    }
    void loadBudget()
    return true
  }

  const spendingAllocations = allocations.filter(
    (allocation) => allocation.direction === 'spending',
  )
  const plannedSpending = spendingAllocations.reduce(
    (sum, allocation) => sum + Math.abs(allocation.budgeted_amount),
    0,
  )
  const spent = spendingAllocations.reduce(
    (sum, allocation) => sum + Math.max(0, -allocation.actual_amount),
    0,
  )
  const allocatedCategoryIds = allocations.map(
    (allocation) => allocation.category_id,
  )

  return (
    <>
      <header className="workspace-head">
        <div>
          <p className="eyebrow">Budget / {selectedMonth.replace('-', ' / ')}</p>
          <h1>{formatMonth(selectedMonth)}</h1>
          <p className="subtitle">Plan with the keyboard. Review with a glance.</p>
        </div>
        <div className="month-controls" aria-label="Month navigation">
          <button
            data-semantic-id="month-previous"
            data-semantic-region="workspace"
            data-status-action="previous month"
            data-status-label="budget / previous month"
            disabled={busyId !== null}
            type="button"
            onClick={() => onMonthChange(shiftMonth(selectedMonth, -1))}
          >
            ← Previous
          </button>
          <button
            data-semantic-id="month-next"
            data-semantic-region="workspace"
            data-status-action="next month"
            data-status-label="budget / next month"
            disabled={busyId !== null}
            type="button"
            onClick={() => onMonthChange(shiftMonth(selectedMonth, 1))}
          >
            Next →
          </button>
        </div>
      </header>

      {errorMessage && (
        <p className="form-message form-message--error" role="alert">
          {errorMessage}
        </p>
      )}

      {isLoading ? (
        <section className="budget-table empty-state" aria-live="polite">
          Loading budget...
        </section>
      ) : !budget ? (
        <section className="budget-table empty-state">
          <h2>Create the {formatMonth(selectedMonth)} budget</h2>
          <p>Start with an empty monthly budget, then add categories.</p>
          <button
            data-status-action="create budget"
            data-status-label="budget / empty month"
            type="button"
            disabled={busyId === 'create-budget'}
            onClick={() =>
              void runMutation('create-budget', () =>
                getSupabaseClient().rpc('create_monthly_budget', {
                  p_month: `${selectedMonth}-01`,
                }),
              )
            }
          >
            {busyId === 'create-budget' ? 'Creating month...' : 'Create this month'}
          </button>
        </section>
      ) : (
        <>
          <section className="summary" aria-label="Budget overview">
            <BudgetMetric
              label="Available"
              value={plannedSpending - spent}
              variant="available"
            />
            <BudgetMetric label="Planned" value={plannedSpending} />
            <BudgetMetric label="Spent" value={spent} variant="spent" />
            <div>
              <span>Uncategorized</span>
              <strong className="warning">
                {uncategorizedCount} transaction{uncategorizedCount === 1 ? '' : 's'}
              </strong>
            </div>
          </section>

          <section className="budget-table" aria-labelledby="budget-heading">
            <div className="table-head">
              <div>
                <p className="eyebrow">Monthly plan</p>
                <h2 id="budget-heading">Categories</h2>
              </div>
              <button
                id="add-category"
                className="new-category"
                data-semantic-id="add-category"
                data-semantic-region="workspace"
                data-status-action="add category"
                data-status-label="budget / categories"
                disabled={busyId !== null}
                type="button"
                onClick={() => setIsAddingCategory(true)}
              >
                <span>+</span> Add category
              </button>
            </div>
            {isAddingCategory && (
              <div className="category-create">
                <CategoryCombobox
                  autoFocus
                  cancelOnBlur
                  categories={categories}
                  disabled={busyId !== null}
                  excludedCategoryIds={allocatedCategoryIds}
                  label="Add or create a category"
                  onCancel={() => setIsAddingCategory(false)}
                  onCreate={createCategory}
                  onSelect={async (category) => {
                    await addRootAllocation(category)
                    setIsAddingCategory(false)
                  }}
                />
              </div>
            )}
            <div className="column-head" aria-hidden="true">
              <span>Category</span>
              <span>Planned</span>
              <span>Spent</span>
              <span>Remaining</span>
            </div>
            {allocations.some((allocation) => allocation.subsection_id === null) && (
              <BudgetGroup
                allocations={allocations.filter(
                  (allocation) => allocation.subsection_id === null,
                )}
                busyId={busyId}
                editingAllocationId={editingAllocationId}
                focusedSemanticId={focusedSemanticId}
                name="Unsectioned"
                onEdit={setEditingAllocationId}
                onAmountEditorClosed={onAmountEditorClosed}
                onAmountEditorOpenChange={onAmountEditorOpenChange}
                onUpdate={updateAllocation}
              />
            )}
            {subsections.map((subsection) => (
              <BudgetGroup
                allocations={allocations.filter(
                  (allocation) => allocation.subsection_id === subsection.id,
                )}
                busyId={busyId}
                editingAllocationId={editingAllocationId}
                focusedSemanticId={focusedSemanticId}
                key={subsection.id}
                name={subsection.name}
                onEdit={setEditingAllocationId}
                onAmountEditorClosed={onAmountEditorClosed}
                onAmountEditorOpenChange={onAmountEditorOpenChange}
                onUpdate={updateAllocation}
              />
            ))}
          </section>
        </>
      )}
    </>
  )
}

function BudgetMetric({
  label,
  value,
  variant,
}: {
  label: string
  value: number
  variant?: 'available' | 'spent'
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={variant}>
        {formatDisplayMoney(value)}
      </strong>
    </div>
  )
}

function BudgetGroup({
  allocations,
  busyId,
  editingAllocationId,
  focusedSemanticId,
  name,
  onEdit,
  onAmountEditorClosed,
  onAmountEditorOpenChange,
  onUpdate,
}: {
  allocations: BudgetAllocation[]
  busyId: string | null
  editingAllocationId: string | null
  focusedSemanticId: string | null
  name: string
  onEdit: (allocationId: string | null) => void
  onAmountEditorClosed: (allocationId: string) => void
  onAmountEditorOpenChange: (isOpen: boolean) => void
  onUpdate: (
    allocation: BudgetAllocation,
    magnitude: number,
    direction: BudgetDirection,
  ) => Promise<boolean>
}) {
  const planned = allocations.reduce(
    (sum, allocation) => sum + Math.abs(allocation.budgeted_amount),
    0,
  )

  return (
    <section className="budget-group">
      <header>
        <h3><span>⌄</span> {name}</h3>
        <strong>{formatDisplayMoney(planned)}</strong>
      </header>
      {allocations.map((allocation) => {
        const plannedAmount = Math.abs(allocation.budgeted_amount)
        const isBusy = busyId === allocation.allocation_id
        const spentAmount =
          allocation.direction === 'spending'
            ? Math.max(0, -allocation.actual_amount)
            : Math.max(0, allocation.actual_amount)
        const remaining = plannedAmount - spentAmount
        const isSelected =
          focusedSemanticId === `budget-row-${allocation.allocation_id}`
        return (
          <div key={allocation.allocation_id}>
            <div
              aria-current={isSelected ? 'true' : undefined}
              className={`budget-row${isSelected ? ' is-selected' : ''}`}
              data-allocation-id={allocation.allocation_id}
              data-semantic-id={`budget-row-${allocation.allocation_id}`}
              data-semantic-kind="budget-row"
              data-semantic-region="workspace"
              data-status-action="amount"
              data-status-label={`budget / ${allocation.category_name.toLocaleLowerCase()}`}
              id={`budget-row-${allocation.allocation_id}`}
              tabIndex={0}
            >
              <span className="category-name">
                {isSelected ? <i className="selection-caret">›</i> : null}
                {allocation.category_name}
                <button
                  aria-label={`Toggle ${allocation.category_name} between spending and income`}
                  className="direction-tag"
                  data-status-action="toggle direction"
                  data-status-label={`budget / ${allocation.category_name.toLocaleLowerCase()}`}
                  disabled={isBusy}
                  id={`direction-toggle-${allocation.allocation_id}`}
                  type="button"
                  onClick={() => {
                    onEdit(null)
                    onAmountEditorOpenChange(false)
                    void onUpdate(
                      allocation,
                      plannedAmount,
                      allocation.direction === 'spending' ? 'income' : 'spending',
                    )
                  }}
                >
                  {allocation.direction === 'spending' ? 'Spending' : 'Income'}
                </button>
              </span>
              {editingAllocationId === allocation.allocation_id ? (
                <InlineBudgetAmount
                  allocation={allocation}
                  busy={isBusy}
                  onCancel={() => {
                    onEdit(null)
                    onAmountEditorOpenChange(false)
                    onAmountEditorClosed(allocation.allocation_id)
                  }}
                  onUpdate={onUpdate}
                />
              ) : (
                <button
                  className="amount-cell"
                  data-status-action="edit amount"
                  data-status-label={`budget / ${allocation.category_name.toLocaleLowerCase()}`}
                  disabled={isBusy}
                  type="button"
                  onClick={() => {
                    onEdit(allocation.allocation_id)
                    onAmountEditorOpenChange(true)
                  }}
                >
                  {formatDisplayMoney(plannedAmount)}
                </button>
              )}
              <span className="spent">{formatDisplayMoney(spentAmount)}</span>
              <span className={remaining < 0 ? 'spent' : 'available'}>
                {formatDisplayMoney(remaining)}
              </span>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function InlineBudgetAmount({
  allocation,
  busy,
  onCancel,
  onUpdate,
}: {
  allocation: BudgetAllocation
  busy: boolean
  onCancel: () => void
  onUpdate: (
    allocation: BudgetAllocation,
    magnitude: number,
    direction: BudgetDirection,
  ) => Promise<boolean>
}) {
  const [magnitude, setMagnitude] = useState(
    Math.abs(allocation.budgeted_amount).toFixed(2),
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const amountInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    amountInputRef.current?.focus()
    amountInputRef.current?.select()
  }, [])

  function saveAmount() {
    const parsed = parseMagnitude(magnitude)
    if (parsed === null) {
      setErrorMessage('Enter an amount with no more than two decimal places.')
      return
    }
    onCancel()
    void onUpdate(allocation, parsed, allocation.direction)
  }

  return (
    <div className="inline-amount-editor">
      <input
        autoFocus
        aria-invalid={errorMessage ? 'true' : undefined}
        className="amount-cell amount-cell--editing"
        data-status-action="save amount"
        data-status-label={`budget / ${allocation.category_name.toLocaleLowerCase()}`}
        disabled={busy}
        inputMode="decimal"
        ref={amountInputRef}
        type="text"
        value={magnitude}
        onChange={(event) => {
          setMagnitude(event.target.value)
          setErrorMessage(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void saveAmount()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      {errorMessage && <span className="inline-error" role="alert">{errorMessage}</span>}
    </div>
  )
}
