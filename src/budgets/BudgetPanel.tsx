import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
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
}: {
  categoriesRevision: number
  activityRevision: number
  onCategoriesChanged: () => void
  selectedMonth: string
  onMonthChange: (month: string) => void
}) {
  const { user } = useAuth()
  const [budget, setBudget] = useState<Budget | null>(null)
  const [subsections, setSubsections] = useState<BudgetSubsection[]>([])
  const [allocations, setAllocations] = useState<BudgetAllocation[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [uncategorizedCount, setUncategorizedCount] = useState(0)
  const [selectedAllocationId, setSelectedAllocationId] = useState<string | null>(
    null,
  )
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
      setSelectedAllocationId((current) =>
        current &&
        data.allocations.some(
          (allocation) => allocation.allocation_id === current,
        )
          ? current
          : (data.allocations[0]?.allocation_id ?? null),
      )
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

  async function runMutation(
    id: string,
    mutation: () => PromiseLike<{ error: { message: string } | null }>,
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
      await loadBudget()
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
    return runMutation(allocation.allocation_id, () =>
      getSupabaseClient().rpc('update_budget_category_allocation', {
        p_allocation_id: allocation.allocation_id,
        p_magnitude: magnitude,
        p_direction: direction,
      }),
    )
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
            data-status-action="previous month"
            data-status-label="budget / previous month"
            disabled={busyId !== null}
            type="button"
            onClick={() => onMonthChange(shiftMonth(selectedMonth, -1))}
          >
            ← Previous
          </button>
          <button
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
                busy={busyId !== null}
                editingAllocationId={editingAllocationId}
                name="Unsectioned"
                onEdit={setEditingAllocationId}
                onSelect={setSelectedAllocationId}
                onUpdate={updateAllocation}
                selectedAllocationId={selectedAllocationId}
              />
            )}
            {subsections.map((subsection) => (
              <BudgetGroup
                allocations={allocations.filter(
                  (allocation) => allocation.subsection_id === subsection.id,
                )}
                busy={busyId !== null}
                editingAllocationId={editingAllocationId}
                key={subsection.id}
                name={subsection.name}
                onEdit={setEditingAllocationId}
                onSelect={setSelectedAllocationId}
                onUpdate={updateAllocation}
                selectedAllocationId={selectedAllocationId}
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
  busy,
  editingAllocationId,
  name,
  onEdit,
  onSelect,
  onUpdate,
  selectedAllocationId,
}: {
  allocations: BudgetAllocation[]
  busy: boolean
  editingAllocationId: string | null
  name: string
  onEdit: (allocationId: string | null) => void
  onSelect: (allocationId: string) => void
  onUpdate: (
    allocation: BudgetAllocation,
    magnitude: number,
    direction: BudgetDirection,
  ) => Promise<boolean>
  selectedAllocationId: string | null
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
        const spentAmount =
          allocation.direction === 'spending'
            ? Math.max(0, -allocation.actual_amount)
            : Math.max(0, allocation.actual_amount)
        const remaining = plannedAmount - spentAmount
        const isSelected = allocation.allocation_id === selectedAllocationId
        return (
          <div key={allocation.allocation_id}>
            <button
              aria-pressed={isSelected}
              className={`budget-row${isSelected ? ' is-selected' : ''}`}
              data-status-action="edit"
              data-status-label={`budget / ${allocation.category_name.toLocaleLowerCase()}`}
              disabled={busy}
              type="button"
              onClick={() => {
                onSelect(allocation.allocation_id)
                onEdit(allocation.allocation_id)
              }}
            >
              <span className="category-name">
                {isSelected ? <i className="selection-caret">›</i> : null}
                {allocation.category_name}
              </span>
              <span>{formatDisplayMoney(plannedAmount)}</span>
              <span className="spent">{formatDisplayMoney(spentAmount)}</span>
              <span className={remaining < 0 ? 'spent' : 'available'}>
                {formatDisplayMoney(remaining)}
              </span>
            </button>
            {editingAllocationId === allocation.allocation_id && (
              <BudgetAllocationEditor
                allocation={allocation}
                busy={busy}
                onClose={() => onEdit(null)}
                onUpdate={onUpdate}
              />
            )}
          </div>
        )
      })}
    </section>
  )
}

function BudgetAllocationEditor({
  allocation,
  busy,
  onClose,
  onUpdate,
}: {
  allocation: BudgetAllocation
  busy: boolean
  onClose: () => void
  onUpdate: (
    allocation: BudgetAllocation,
    magnitude: number,
    direction: BudgetDirection,
  ) => Promise<boolean>
}) {
  const [magnitude, setMagnitude] = useState(
    Math.abs(allocation.budgeted_amount).toFixed(2),
  )
  const [direction, setDirection] = useState<BudgetDirection>(allocation.direction)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = parseMagnitude(magnitude)
    if (parsed === null) {
      setErrorMessage('Enter an amount with no more than two decimal places.')
      return
    }
    const didSave = await onUpdate(allocation, parsed, direction)
    if (didSave) {
      onClose()
    }
  }

  return (
    <form className="budget-row-editor" onSubmit={handleSubmit}>
      <label>
        Planned amount
        <input
          autoFocus
          data-status-action="edit amount"
          data-status-label={`budget / ${allocation.category_name.toLocaleLowerCase()}`}
          disabled={busy}
          inputMode="decimal"
          type="text"
          value={magnitude}
          onChange={(event) => {
            setMagnitude(event.target.value)
            setErrorMessage(null)
          }}
        />
      </label>
      <label>
        Direction
        <select
          data-status-action="change direction"
          data-status-label={`budget / ${allocation.category_name.toLocaleLowerCase()}`}
          disabled={busy}
          value={direction}
          onChange={(event) => setDirection(event.target.value as BudgetDirection)}
        >
          <option value="spending">Spending</option>
          <option value="income">Income</option>
        </select>
      </label>
      <button
        data-status-action="save"
        data-status-label={`budget / ${allocation.category_name.toLocaleLowerCase()}`}
        disabled={busy}
        type="submit"
      >
        Save
      </button>
      <button
        data-status-action="cancel"
        data-status-label={`budget / ${allocation.category_name.toLocaleLowerCase()}`}
        disabled={busy}
        type="button"
        onClick={onClose}
      >
        Cancel
      </button>
      {errorMessage && <p role="alert">{errorMessage}</p>}
    </form>
  )
}
