import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { getSupabaseClient } from '../lib/supabase.ts'

interface Budget {
  id: string
  month: string
}

interface BudgetSubsection {
  id: string
  name: string
  position: number
}

interface BudgetAllocation {
  allocation_id: string
  category_id: string
  category_name: string
  subsection_id: string | null
  position: number
  budgeted_amount: number
  actual_amount: number
}

interface Category {
  id: string
  name: string
}

interface BudgetData {
  budget: Budget | null
  subsections: BudgetSubsection[]
  allocations: BudgetAllocation[]
  categories: Category[]
}

function currentMonth(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function formatMonth(month: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${month}-01T00:00:00`))
}

function formatAmount(amount: number): string {
  const formatted = new Intl.NumberFormat(undefined, {
    currency: 'USD',
    style: 'currency',
  }).format(amount)

  return amount > 0 ? `+${formatted}` : formatted
}

function parseAmount(value: string): number | null {
  const normalized = value.trim()
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null
  }

  const amount = Number(normalized)
  return Number.isFinite(amount) ? amount : null
}

async function queryBudget(month: string): Promise<BudgetData> {
  const client = getSupabaseClient()
  const [budgetResult, categoriesResult] = await Promise.all([
    client
      .from('budgets')
      .select('id, month')
      .eq('month', `${month}-01`)
      .maybeSingle(),
    client.from('categories').select('id, name').order('name'),
  ])

  if (budgetResult.error) {
    throw new Error(budgetResult.error.message)
  }

  if (categoriesResult.error) {
    throw new Error(categoriesResult.error.message)
  }

  if (!budgetResult.data) {
    return {
      budget: null,
      subsections: [],
      allocations: [],
      categories: categoriesResult.data ?? [],
    }
  }

  const [subsectionsResult, allocationsResult] = await Promise.all([
    client
      .from('budget_subsections')
      .select('id, name, position')
      .eq('budget_id', budgetResult.data.id)
      .order('position'),
    client
      .from('budget_category_activity')
      .select(
        'allocation_id, category_id, category_name, subsection_id, position, budgeted_amount, actual_amount',
      )
      .eq('budget_id', budgetResult.data.id)
      .order('position'),
  ])

  if (subsectionsResult.error) {
    throw new Error(subsectionsResult.error.message)
  }

  if (allocationsResult.error) {
    throw new Error(allocationsResult.error.message)
  }

  return {
    budget: budgetResult.data,
    subsections: subsectionsResult.data ?? [],
    allocations: (allocationsResult.data ?? []).map((allocation) => ({
      ...allocation,
      budgeted_amount: Number(allocation.budgeted_amount),
      actual_amount: Number(allocation.actual_amount),
    })),
    categories: categoriesResult.data ?? [],
  }
}

export function BudgetPanel({
  categoriesRevision,
  activityRevision,
}: {
  categoriesRevision: number
  activityRevision: number
}) {
  const initialMonth = currentMonth()
  const [selectedMonth, setSelectedMonth] = useState(initialMonth)
  const [monthInput, setMonthInput] = useState(initialMonth)
  const [budget, setBudget] = useState<Budget | null>(null)
  const [subsections, setSubsections] = useState<BudgetSubsection[]>([])
  const [allocations, setAllocations] = useState<BudgetAllocation[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [subsectionName, setSubsectionName] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [allocationAmount, setAllocationAmount] = useState('')
  const [allocationSubsectionId, setAllocationSubsectionId] = useState('')
  const [editingAllocationId, setEditingAllocationId] = useState<string | null>(
    null,
  )
  const [editingAmount, setEditingAmount] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const selectedMonthRef = useRef(selectedMonth)

  const loadBudget = useCallback(async () => {
    const generation = ++requestGeneration.current
    try {
      const data = await queryBudget(selectedMonth)
      if (
        generation !== requestGeneration.current ||
        selectedMonth !== selectedMonthRef.current
      ) {
        return
      }

      setBudget(data.budget)
      setSubsections(data.subsections)
      setAllocations(data.allocations)
      setCategories(data.categories)
      setErrorMessage(null)
    } catch (error) {
      if (
        generation !== requestGeneration.current ||
        selectedMonth !== selectedMonthRef.current
      ) {
        return
      }

      setErrorMessage(
        error instanceof Error ? error.message : 'We could not load this budget.',
      )
    } finally {
      if (
        generation === requestGeneration.current &&
        selectedMonth === selectedMonthRef.current
      ) {
        setIsLoading(false)
      }
    }
  }, [selectedMonth])

  useEffect(() => {
    const generation = ++requestGeneration.current

    void queryBudget(selectedMonth)
      .then((data) => {
        if (
          generation !== requestGeneration.current ||
          selectedMonth !== selectedMonthRef.current
        ) {
          return
        }

        setBudget(data.budget)
        setSubsections(data.subsections)
        setAllocations(data.allocations)
        setCategories(data.categories)
        setErrorMessage(null)
      })
      .catch((error: unknown) => {
        if (
          generation === requestGeneration.current &&
          selectedMonth === selectedMonthRef.current
        ) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'We could not load this budget.',
          )
        }
      })
      .finally(() => {
        if (
          generation === requestGeneration.current &&
          selectedMonth === selectedMonthRef.current
        ) {
          setIsLoading(false)
        }
      })
  }, [activityRevision, categoriesRevision, selectedMonth])

  const allocatedCategoryIds = new Set(
    allocations.map((allocation) => allocation.category_id),
  )
  const availableCategories = categories.filter(
    (category) => !allocatedCategoryIds.has(category.id),
  )
  const selectedCategoryId = availableCategories.some(
    (category) => category.id === categoryId,
  )
    ? categoryId
    : (availableCategories[0]?.id ?? '')
  const selectedSubsectionId = subsections.some(
    (subsection) => subsection.id === allocationSubsectionId,
  )
    ? allocationSubsectionId
    : ''

  async function runMutation(
    id: string,
    mutation: () => PromiseLike<{ error: { message: string } | null }>,
  ) {
    setBusyId(id)
    setErrorMessage(null)
    const { error } = await mutation()
    setBusyId(null)

    if (error) {
      setErrorMessage(error.message)
      return false
    }

    if (selectedMonth === selectedMonthRef.current) {
      await loadBudget()
    }
    return true
  }

  async function createBudget() {
    await runMutation('create-budget', () =>
      getSupabaseClient().rpc('create_monthly_budget', {
        p_month: `${selectedMonth}-01`,
      }),
    )
  }

  async function addSubsection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = subsectionName.trim()
    if (!budget || !name) {
      setErrorMessage('Enter a subsection name.')
      return
    }

    if (
      await runMutation('add-subsection', () =>
        getSupabaseClient().rpc('add_budget_subsection', {
          p_budget_id: budget.id,
          p_name: name,
        }),
      )
    ) {
      setSubsectionName('')
    }
  }

  async function addAllocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const amount = parseAmount(allocationAmount)
    if (!budget || !selectedCategoryId) {
      setErrorMessage('Choose a category to add.')
      return
    }

    if (amount === null) {
      setErrorMessage(
        'Enter a signed amount with no more than two decimal places.',
      )
      return
    }

    if (
      await runMutation('add-allocation', () =>
        getSupabaseClient().rpc('add_budget_category_allocation', {
          p_budget_id: budget.id,
          p_category_id: selectedCategoryId,
          p_subsection_id: selectedSubsectionId || null,
          p_amount: amount,
        }),
      )
    ) {
      setAllocationAmount('')
    }
  }

  async function saveAllocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const amount = parseAmount(editingAmount)
    if (!editingAllocationId || amount === null) {
      setErrorMessage(
        'Enter a signed amount with no more than two decimal places.',
      )
      return
    }

    if (
      await runMutation(editingAllocationId, () =>
        getSupabaseClient().rpc('update_budget_allocation_amount', {
          p_allocation_id: editingAllocationId,
          p_amount: amount,
        }),
      )
    ) {
      setEditingAllocationId(null)
      setEditingAmount('')
    }
  }

  async function deleteSubsection(subsection: BudgetSubsection) {
    if (
      !window.confirm(
        `Delete ${subsection.name}? Its categories will move to Unsectioned.`,
      )
    ) {
      return
    }

    await runMutation(subsection.id, () =>
      getSupabaseClient().rpc('delete_budget_subsection', {
        p_subsection_id: subsection.id,
      }),
    )
  }

  function renderAllocation(
    allocation: BudgetAllocation,
    index: number,
    count: number,
  ) {
    const isEditing = editingAllocationId === allocation.allocation_id
    const isInflow = allocation.budgeted_amount > 0
    const isOutflow = allocation.budgeted_amount < 0

    return (
      <li
        className={`budget-allocation${
          isEditing ? ' budget-allocation--editing' : ''
        }`}
        key={allocation.allocation_id}
      >
        <div>
          <h4>{allocation.category_name}</h4>
          <p>
            {isEditing
              ? `Editing planned ${isInflow ? 'income' : isOutflow ? 'spending' : 'amount'}`
              : isInflow
                ? 'Planned income'
                : isOutflow
                  ? 'Planned spending'
                  : 'Tracked without a planned amount'}
          </p>
        </div>
        {isEditing ? (
          <form className="budget-allocation__edit-form" onSubmit={saveAllocation}>
            <label>
              Budgeted amount
              <input
                type="text"
                inputMode="decimal"
                value={editingAmount}
                onChange={(event) => setEditingAmount(event.target.value)}
                disabled={busyId === allocation.allocation_id}
                autoFocus
              />
            </label>
            <div>
              <button
                className="text-button"
                type="submit"
                disabled={busyId === allocation.allocation_id}
              >
                {busyId === allocation.allocation_id ? 'Saving...' : 'Save'}
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => setEditingAllocationId(null)}
                disabled={busyId === allocation.allocation_id}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <dl className="budget-allocation__amounts">
            <div>
              <dt>Budgeted</dt>
              <dd
                className={
                  isInflow ? 'amount--inflow' : isOutflow ? 'amount--outflow' : ''
                }
              >
                {formatAmount(allocation.budgeted_amount)}
              </dd>
            </div>
            <div>
              <dt>
                {isInflow
                  ? 'Received so far'
                  : isOutflow
                    ? 'Spent so far'
                    : 'Activity so far'}
              </dt>
              <dd
                className={
                  allocation.actual_amount > 0
                    ? 'amount--inflow'
                    : allocation.actual_amount < 0
                      ? 'amount--outflow'
                      : ''
                }
              >
                {formatAmount(allocation.actual_amount)}
              </dd>
            </div>
          </dl>
        )}
        <div className="budget-allocation__actions">
          {!isEditing && (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setEditingAllocationId(allocation.allocation_id)
                setEditingAmount(allocation.budgeted_amount.toFixed(2))
                setErrorMessage(null)
              }}
            >
              Edit amount
            </button>
          )}
          {index > 0 && (
            <button
              className="text-button"
              type="button"
              onClick={() =>
                void runMutation(allocation.allocation_id, () =>
                  getSupabaseClient().rpc('move_budget_allocation', {
                    p_allocation_id: allocation.allocation_id,
                    p_direction: -1,
                  }),
                )
              }
              disabled={busyId === allocation.allocation_id}
            >
              Move up
            </button>
          )}
          {index < count - 1 && (
            <button
              className="text-button"
              type="button"
              onClick={() =>
                void runMutation(allocation.allocation_id, () =>
                  getSupabaseClient().rpc('move_budget_allocation', {
                    p_allocation_id: allocation.allocation_id,
                    p_direction: 1,
                  }),
                )
              }
              disabled={busyId === allocation.allocation_id}
            >
              Move down
            </button>
          )}
          <button
            className="text-button text-button--danger"
            type="button"
            onClick={() =>
              void runMutation(allocation.allocation_id, () =>
                getSupabaseClient().rpc('remove_budget_allocation', {
                  p_allocation_id: allocation.allocation_id,
                }),
              )
            }
            disabled={busyId === allocation.allocation_id}
          >
            {busyId === allocation.allocation_id ? 'Removing...' : 'Remove'}
          </button>
        </div>
      </li>
    )
  }

  const monthLabel = formatMonth(selectedMonth)

  return (
    <section
      className="app-shell__content budget-panel"
      aria-labelledby="budget-title"
      aria-busy={isLoading}
    >
      <div className="budget-panel__header">
        <div>
          <p className="eyebrow">Monthly budget</p>
          <h2 id="budget-title">
            {budget ? `${monthLabel} budget` : monthLabel}
          </h2>
          <p>
            {budget
              ? 'Budgeted amounts use positive numbers for planned income and negative numbers for planned spending.'
              : 'No budget has been created for this month yet.'}
          </p>
        </div>
        <form
          className="month-picker"
          onSubmit={(event) => {
            event.preventDefault()
            if (monthInput) {
              requestGeneration.current += 1
              setIsLoading(true)
              if (monthInput === selectedMonth) {
                void loadBudget()
              } else {
                selectedMonthRef.current = monthInput
                setBudget(null)
                setSubsections([])
                setAllocations([])
                setEditingAllocationId(null)
                setSelectedMonth(monthInput)
              }
            }
          }}
        >
          <label htmlFor="budget-month">Budget month</label>
          <div className="month-picker__controls">
            <input
              id="budget-month"
              type="month"
              value={monthInput}
              onChange={(event) => setMonthInput(event.target.value)}
              required
            />
            <button className="button button--secondary" type="submit">
              View month
            </button>
          </div>
        </form>
      </div>

      {errorMessage && (
        <p className="form-message form-message--error" role="alert">
          {errorMessage}
        </p>
      )}

      {isLoading ? (
        <p className="transactions-panel__status" aria-live="polite">
          Loading budget...
        </p>
      ) : !budget ? (
        <div className="budget-empty-state">
          <h3>Create the {monthLabel} budget</h3>
          <p>
            Start with an empty monthly budget. Categories and subsections can
            be added after it is created.
          </p>
          <button
            className="button"
            type="button"
            onClick={() => void createBudget()}
            disabled={busyId === 'create-budget'}
          >
            {busyId === 'create-budget' ? 'Creating budget...' : 'Create budget'}
          </button>
        </div>
      ) : (
        <>
          <div className="budget-editors">
            <form className="budget-editor-card" onSubmit={addSubsection}>
              <h3>Add subsection</h3>
              <label htmlFor="subsection-name">Subsection name</label>
              <div className="budget-editor-card__controls">
                <input
                  id="subsection-name"
                  placeholder="e.g. Essentials"
                  type="text"
                  maxLength={100}
                  value={subsectionName}
                  onChange={(event) => setSubsectionName(event.target.value)}
                  disabled={busyId === 'add-subsection'}
                />
                <button
                  className="button"
                  type="submit"
                  disabled={busyId === 'add-subsection'}
                >
                  {busyId === 'add-subsection' ? 'Adding...' : 'Add subsection'}
                </button>
              </div>
            </form>

            <form className="budget-editor-card" onSubmit={addAllocation}>
              <h3>Add category</h3>
              <div className="budget-allocation-fields">
                <label>
                  Category
                  <select
                    value={selectedCategoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                    disabled={availableCategories.length === 0}
                  >
                    {availableCategories.length === 0 ? (
                      <option value="">All categories are budgeted</option>
                    ) : (
                      availableCategories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label>
                  Budgeted amount
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="-150.00"
                    value={allocationAmount}
                    onChange={(event) => setAllocationAmount(event.target.value)}
                  />
                </label>
                <label>
                  Location
                  <select
                    value={selectedSubsectionId}
                    onChange={(event) =>
                      setAllocationSubsectionId(event.target.value)
                    }
                  >
                    <option value="">Unsectioned</option>
                    {subsections.map((subsection) => (
                      <option key={subsection.id} value={subsection.id}>
                        {subsection.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                className="button"
                type="submit"
                disabled={
                  busyId === 'add-allocation' || availableCategories.length === 0
                }
              >
                {busyId === 'add-allocation' ? 'Adding...' : 'Add to budget'}
              </button>
            </form>
          </div>

          <div className="budget-groups">
            <BudgetGroup
              label="Budget root"
              name="Unsectioned"
              allocations={allocations.filter(
                (allocation) => allocation.subsection_id === null,
              )}
              renderAllocation={renderAllocation}
            />
            {subsections.map((subsection, subsectionIndex) => (
              <BudgetGroup
                key={subsection.id}
                label="Subsection"
                name={subsection.name}
                allocations={allocations.filter(
                  (allocation) =>
                    allocation.subsection_id === subsection.id,
                )}
                actions={
                  <>
                    {subsectionIndex > 0 && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() =>
                          void runMutation(subsection.id, () =>
                            getSupabaseClient().rpc('move_budget_subsection', {
                              p_subsection_id: subsection.id,
                              p_direction: -1,
                            }),
                          )
                        }
                        disabled={busyId === subsection.id}
                      >
                        Move up
                      </button>
                    )}
                    {subsectionIndex < subsections.length - 1 && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() =>
                          void runMutation(subsection.id, () =>
                            getSupabaseClient().rpc('move_budget_subsection', {
                              p_subsection_id: subsection.id,
                              p_direction: 1,
                            }),
                          )
                        }
                        disabled={busyId === subsection.id}
                      >
                        Move down
                      </button>
                    )}
                    <button
                      className="text-button text-button--danger"
                      type="button"
                      onClick={() => void deleteSubsection(subsection)}
                      disabled={busyId === subsection.id}
                    >
                      {busyId === subsection.id
                        ? 'Deleting...'
                        : 'Delete subsection'}
                    </button>
                  </>
                }
                renderAllocation={renderAllocation}
              />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function BudgetGroup({
  label,
  name,
  allocations,
  actions,
  renderAllocation,
}: {
  label: string
  name: string
  allocations: BudgetAllocation[]
  actions?: ReactNode
  renderAllocation: (
    allocation: BudgetAllocation,
    index: number,
    count: number,
  ) => ReactNode
}) {
  return (
    <section className="budget-group">
      <div className="budget-group__header">
        <div>
          <p className="budget-group__label">{label}</p>
          <h3>{name}</h3>
        </div>
        {actions && <div className="budget-group__actions">{actions}</div>}
      </div>
      {allocations.length > 0 && (
        <ul className="budget-allocation-list">
          {allocations.map((allocation, index) =>
            renderAllocation(allocation, index, allocations.length),
          )}
        </ul>
      )}
    </section>
  )
}
