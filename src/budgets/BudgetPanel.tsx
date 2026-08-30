import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react'
import { useAuth } from '../auth/useAuth.ts'
import { CategoryCombobox } from '../finance/CategoryCombobox.tsx'
import type {
  Budget,
  BudgetAllocation,
  BudgetDirection,
  BudgetSubsection,
  Category,
} from '../finance/types.ts'
import {
  currentMonth,
  formatDisplayMoney,
  formatMonth,
  isTextEntryTarget,
  parseMagnitude,
  shiftMonth,
} from '../finance/utils.ts'
import { getSupabaseClient } from '../lib/supabase.ts'

interface BudgetData {
  budgets: Budget[]
  budget: Budget | null
  subsections: BudgetSubsection[]
  allocations: BudgetAllocation[]
  categories: Category[]
}

interface DraggedBudgetItem {
  id: string
  type: 'subsection' | 'allocation'
}

interface AddCategoryRequest {
  groupKey: string
  id: number
}

const budgetDragType = 'application/x-perfectly-balanced-budget-item'
const rootGroupKey = 'root'

async function queryBudget(month: string): Promise<BudgetData> {
  const client = getSupabaseClient()
  const [budgetsResult, categoriesResult] = await Promise.all([
    client.from('budgets').select('id, month').order('month', { ascending: false }),
    client.from('categories').select('id, name').order('name'),
  ])

  if (budgetsResult.error) {
    throw new Error(budgetsResult.error.message)
  }
  if (categoriesResult.error) {
    throw new Error(categoriesResult.error.message)
  }

  const budgets = budgetsResult.data ?? []
  const budget =
    budgets.find((candidate) => candidate.month.slice(0, 7) === month) ?? null

  if (!budget) {
    return {
      budgets,
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
  }
}

export function BudgetPanel({
  categoriesRevision,
  activityRevision,
  onCategoriesChanged,
}: {
  categoriesRevision: number
  activityRevision: number
  onCategoriesChanged: () => void
}) {
  const { user } = useAuth()
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [budget, setBudget] = useState<Budget | null>(null)
  const [subsections, setSubsections] = useState<BudgetSubsection[]>([])
  const [allocations, setAllocations] = useState<BudgetAllocation[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [subsectionName, setSubsectionName] = useState('')
  const [isAddingSubsection, setIsAddingSubsection] = useState(false)
  const [draggedItem, setDraggedItem] = useState<DraggedBudgetItem | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [selectedAllocationId, setSelectedAllocationId] = useState<string | null>(
    null,
  )
  const [addCategoryRequest, setAddCategoryRequest] =
    useState<AddCategoryRequest | null>(null)
  const requestGeneration = useRef(0)
  const mutationBusy = useRef(false)
  const allocationRowRefs = useRef(new Map<string, HTMLDivElement>())
  const amountInputRefs = useRef(new Map<string, HTMLInputElement>())

  const loadBudget = useCallback(async () => {
    const generation = ++requestGeneration.current
    try {
      const data = await queryBudget(selectedMonth)
      if (generation !== requestGeneration.current) {
        return
      }
      setBudgets(data.budgets)
      setBudget(data.budget)
      setSubsections(data.subsections)
      setAllocations(data.allocations)
      setCategories(data.categories)
      setSelectedAllocationId((current) =>
        current &&
        data.allocations.some(
          (allocation) => allocation.allocation_id === current,
        )
          ? current
          : (data.allocations[0]?.allocation_id ?? null),
      )
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

  async function addAllocation(
    category: Category,
    subsectionId: string | null,
  ): Promise<void> {
    if (!budget) {
      throw new Error('Create this month before adding categories.')
    }
    const didSave = await runMutation(`add-${subsectionId ?? 'root'}`, () =>
      getSupabaseClient().rpc('create_budget_category_allocation', {
        p_budget_id: budget.id,
        p_category_id: category.id,
        p_subsection_id: subsectionId,
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
    direction = allocation.direction,
  ): Promise<boolean> {
    return runMutation(allocation.allocation_id, () =>
      getSupabaseClient().rpc('update_budget_category_allocation', {
        p_allocation_id: allocation.allocation_id,
        p_magnitude: magnitude,
        p_direction: direction,
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
      setIsAddingSubsection(false)
    }
  }

  function readDraggedItem(event: DragEvent): DraggedBudgetItem | null {
    try {
      return JSON.parse(
        event.dataTransfer.getData(budgetDragType),
      ) as DraggedBudgetItem
    } catch {
      return null
    }
  }

  async function dropSubsection(event: DragEvent, targetGap: number) {
    event.preventDefault()
    const dragged = readDraggedItem(event)
    if (!dragged || dragged.type !== 'subsection') {
      return
    }
    if (!subsections.some((item) => item.id === dragged.id)) {
      return
    }
    const sourcePosition = subsections.findIndex(
      (subsection) => subsection.id === dragged.id,
    )
    const targetPosition =
      sourcePosition < targetGap ? targetGap - 1 : targetGap
    setDraggedItem(null)
    await runMutation(dragged.id, () =>
      getSupabaseClient().rpc('place_budget_subsection', {
        p_subsection_id: dragged.id,
        p_position: targetPosition,
      }),
    )
  }

  async function dropAllocation(
    event: DragEvent,
    subsectionId: string | null,
    targetPosition: number,
  ) {
    event.preventDefault()
    const dragged = readDraggedItem(event)
    if (!dragged || dragged.type !== 'allocation') {
      return
    }
    const source = allocations.find(
      (item) => item.allocation_id === dragged.id,
    )
    if (!source) {
      return
    }
    const normalizedPosition =
      source.subsection_id === subsectionId &&
      source.position < targetPosition
        ? targetPosition - 1
        : targetPosition
    setDraggedItem(null)
    await runMutation(dragged.id, () =>
      getSupabaseClient().rpc('place_budget_category_allocation', {
        p_allocation_id: dragged.id,
        p_subsection_id: subsectionId,
        p_position: normalizedPosition,
      }),
    )
  }

  const allocatedCategoryIds = allocations.map(
    (allocation) => allocation.category_id,
  )
  const spendingAllocations = allocations.filter(
    (allocation) => allocation.direction === 'spending',
  )
  const incomeAllocations = allocations.filter(
    (allocation) => allocation.direction === 'income',
  )
  const plannedSpending = spendingAllocations.reduce(
    (sum, allocation) => sum + Math.abs(allocation.budgeted_amount),
    0,
  )
  const spent = spendingAllocations.reduce(
    (sum, allocation) => sum + Math.max(0, -allocation.actual_amount),
    0,
  )
  const plannedIncome = incomeAllocations.reduce(
    (sum, allocation) => sum + allocation.budgeted_amount,
    0,
  )
  const received = incomeAllocations.reduce(
    (sum, allocation) => sum + Math.max(0, allocation.actual_amount),
    0,
  )
  const monthLabel = formatMonth(selectedMonth)
  const selectorMonths = Array.from(
    new Set([selectedMonth, ...budgets.map((item) => item.month.slice(0, 7))]),
  ).sort((left, right) => right.localeCompare(left))
  const keyboardAllocations = useMemo(
    () => [
      ...allocations.filter((allocation) => allocation.subsection_id === null),
      ...subsections.flatMap((subsection) =>
        allocations.filter(
          (allocation) => allocation.subsection_id === subsection.id,
        ),
      ),
    ],
    [allocations, subsections],
  )
  const changeMonth = useCallback((month: string) => {
    setSubsectionName('')
    setIsAddingSubsection(false)
    setDraggedItem(null)
    setAddCategoryRequest(null)
    setIsLoading(true)
    setSelectedMonth(month)
  }, [])

  const focusAllocation = useCallback((allocationId: string) => {
    window.requestAnimationFrame(() => {
      const row = allocationRowRefs.current.get(allocationId)
      row?.focus({ preventScroll: true })
      row?.scrollIntoView({ block: 'nearest' })
    })
  }, [])

  const registerAllocationRow = useCallback(
    (allocationId: string, row: HTMLDivElement | null) => {
      if (row) {
        allocationRowRefs.current.set(allocationId, row)
      } else {
        allocationRowRefs.current.delete(allocationId)
      }
    },
    [],
  )

  const registerAmountInput = useCallback(
    (allocationId: string, input: HTMLInputElement | null) => {
      if (input) {
        amountInputRefs.current.set(allocationId, input)
      } else {
        amountInputRefs.current.delete(allocationId)
      }
    },
    [],
  )

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isTextEntryTarget(event.target)
      ) {
        return
      }

      const key = event.key.toLocaleLowerCase()
      if ((key === 'h' || key === 'l') && busyId === null) {
        event.preventDefault()
        changeMonth(shiftMonth(selectedMonth, key === 'h' ? -1 : 1))
        return
      }

      if (key === 'j' || key === 'k') {
        if (keyboardAllocations.length === 0) {
          return
        }
        event.preventDefault()
        const currentIndex = keyboardAllocations.findIndex(
          (allocation) => allocation.allocation_id === selectedAllocationId,
        )
        const nextIndex =
          currentIndex === -1
            ? key === 'j'
              ? 0
              : keyboardAllocations.length - 1
            : (currentIndex +
                (key === 'j' ? 1 : -1) +
                keyboardAllocations.length) %
              keyboardAllocations.length
        const nextAllocation = keyboardAllocations[nextIndex]
        setSelectedAllocationId(nextAllocation.allocation_id)
        focusAllocation(nextAllocation.allocation_id)
        return
      }

      const selectedAllocation = allocations.find(
        (allocation) => allocation.allocation_id === selectedAllocationId,
      )
      if (!selectedAllocation) {
        return
      }

      if (key === 'e') {
        const amountInput = amountInputRefs.current.get(
          selectedAllocation.allocation_id,
        )
        if (!amountInput || amountInput.disabled) {
          return
        }
        event.preventDefault()
        amountInput.focus()
        amountInput.select()
        return
      }

      if (key === 'a' && busyId === null) {
        event.preventDefault()
        setAddCategoryRequest((current) => ({
          groupKey: selectedAllocation.subsection_id ?? rootGroupKey,
          id: (current?.id ?? 0) + 1,
        }))
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    allocations,
    busyId,
    changeMonth,
    focusAllocation,
    keyboardAllocations,
    selectedAllocationId,
    selectedMonth,
  ])

  return (
    <main className="page budget-page" aria-busy={isLoading}>
      <div className="page-head">
        <div>
          <p className="eyebrow">Budget / {selectedMonth.replace('-', ' / ')}</p>
          <h1>{monthLabel}</h1>
          <p className="subtle">
            Plan with the keyboard. Review actual activity at a glance.
          </p>
        </div>
        <div className="toolbar-group month-toolbar">
          <button
            aria-label="Previous month"
            className="icon-button"
            disabled={busyId !== null}
            type="button"
            onClick={() => changeMonth(shiftMonth(selectedMonth, -1))}
          >
            <span aria-hidden="true">&larr;</span> <kbd>h</kbd>
          </button>
          <label className="sr-only" htmlFor="budget-month-selector">
            Budget month
          </label>
          <select
            className="pill-select"
            disabled={busyId !== null}
            id="budget-month-selector"
            value={selectedMonth}
            onChange={(event) => changeMonth(event.target.value)}
          >
            {selectorMonths.map((month) => (
              <option key={month} value={month}>
                {formatMonth(month)}
                {budgets.some((item) => item.month.slice(0, 7) === month)
                  ? ''
                  : ' (not created)'}
              </option>
            ))}
          </select>
          <button
            aria-label="Next month"
            className="icon-button"
            disabled={busyId !== null}
            type="button"
            onClick={() => changeMonth(shiftMonth(selectedMonth, 1))}
          >
            <kbd>l</kbd> <span aria-hidden="true">&rarr;</span>
          </button>
        </div>
      </div>

      {errorMessage && (
        <p className="form-message form-message--error" role="alert">
          {errorMessage}
        </p>
      )}

      {isLoading ? (
        <section className="panel empty-state" aria-live="polite">
          Loading budget...
        </section>
      ) : !budget ? (
        <section className="panel empty-state">
          <h2>Create the {monthLabel} budget</h2>
          <p className="subtle">
            Start with an empty monthly budget, then add subsections and categories.
          </p>
          <button
            className="button"
            disabled={busyId === 'create-budget'}
            type="button"
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
          <section className="panel summary-strip" aria-label="Budget overview">
            <BudgetMetric label="Planned spending" value={plannedSpending} />
            <BudgetMetric label="Spent so far" value={spent} />
            <BudgetMetric label="Planned income" value={plannedIncome} />
            <BudgetMetric label="Received so far" value={received} />
          </section>
          <p className="interactive-hint">
            Use j/k to select a category, e to edit its amount, and a to add a
            category in the selected group.
          </p>
          <section className="panel budget-sheet">
            {allocations.some(
              (allocation) => allocation.subsection_id === null,
            ) && (
              <BudgetGroup
                key={`${budget.id}:root`}
                addCategoryRequestId={
                  addCategoryRequest?.groupKey === rootGroupKey
                    ? addCategoryRequest.id
                    : undefined
                }
                name="Unsectioned"
                subsectionId={null}
                allocations={allocations.filter(
                  (allocation) => allocation.subsection_id === null,
                )}
                categories={categories}
                allocatedCategoryIds={allocatedCategoryIds}
                busyId={busyId}
                draggedItem={draggedItem}
                onAddAllocation={addAllocation}
                onCreateCategory={createCategory}
                onDropAllocation={dropAllocation}
                onDragEnd={() => setDraggedItem(null)}
                onDragStart={setDraggedItem}
                onAmountInputRef={registerAmountInput}
                onAllocationRowRef={registerAllocationRow}
                onSelectAllocation={setSelectedAllocationId}
                onUpdateAllocation={updateAllocation}
                selectedAllocationId={selectedAllocationId}
              />
            )}
            {subsections.map((subsection, index) => {
              const groupAllocations = allocations.filter(
                (allocation) => allocation.subsection_id === subsection.id,
              )
              return (
                <div className="budget-group-slot" key={subsection.id}>
                  {draggedItem?.type === 'subsection' && (
                    <BudgetDropTarget
                      onDrop={(event) => void dropSubsection(event, index)}
                    />
                  )}
                  <section
                    className="budget-group"
                    draggable={busyId === null}
                    onDragEnd={() => setDraggedItem(null)}
                    onDragStart={(event) => {
                      const item: DraggedBudgetItem = {
                        id: subsection.id,
                        type: 'subsection',
                      }
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData(
                        budgetDragType,
                        JSON.stringify(item),
                      )
                      setDraggedItem(item)
                    }}
                  >
                    <BudgetGroup
                      addCategoryRequestId={
                        addCategoryRequest?.groupKey === subsection.id
                          ? addCategoryRequest.id
                          : undefined
                      }
                      name={subsection.name}
                      subsectionId={subsection.id}
                      allocations={groupAllocations}
                      categories={categories}
                      allocatedCategoryIds={allocatedCategoryIds}
                      busyId={busyId}
                      draggedItem={draggedItem}
                      onAddAllocation={addAllocation}
                      onCreateCategory={createCategory}
                      onDropAllocation={dropAllocation}
                      onDragEnd={() => setDraggedItem(null)}
                      onDragStart={setDraggedItem}
                      onAmountInputRef={registerAmountInput}
                      onAllocationRowRef={registerAllocationRow}
                      onSelectAllocation={setSelectedAllocationId}
                      onUpdateAllocation={updateAllocation}
                      isNested
                      selectedAllocationId={selectedAllocationId}
                    />
                  </section>
                </div>
              )
            })}
            {draggedItem?.type === 'subsection' && (
              <BudgetDropTarget
                onDrop={(event) =>
                  void dropSubsection(event, subsections.length)
                }
              />
            )}
            <div className="subsection-create-flow">
              <button
                className="inline-create-trigger"
                disabled={busyId !== null}
                type="button"
                onClick={() => setIsAddingSubsection(true)}
              >
                ＋ Add subsection at the end
              </button>
              {isAddingSubsection && (
                <section className="budget-group provisional-subsection">
                  <form
                    className="group-head provisional-subsection__head"
                    onBlur={(event) => {
                      if (
                        !event.currentTarget.contains(event.relatedTarget) &&
                        !subsectionName.trim()
                      ) {
                        setIsAddingSubsection(false)
                      }
                    }}
                    onSubmit={addSubsection}
                  >
                    <span className="drag" aria-hidden="true">⠿</span>
                    <label className="sr-only" htmlFor="subsection-name">
                      New subsection name
                    </label>
                    <input
                      autoFocus
                      disabled={busyId !== null}
                      id="subsection-name"
                      maxLength={100}
                      placeholder="Subsection name..."
                      type="text"
                      value={subsectionName}
                      onChange={(event) => setSubsectionName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setSubsectionName('')
                          setIsAddingSubsection(false)
                        }
                      }}
                    />
                    <span className="subtle">$0 planned · $0 spent</span>
                  </form>
                  <button
                    className="inline-create-trigger"
                    disabled
                    type="button"
                  >
                    ＋ Add or create category
                  </button>
                </section>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  )
}

function BudgetMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{formatDisplayMoney(value)}</strong>
    </div>
  )
}

function BudgetGroup({
  addCategoryRequestId,
  name,
  subsectionId,
  allocations,
  categories,
  allocatedCategoryIds,
  busyId,
  draggedItem,
  isNested = false,
  onAddAllocation,
  onCreateCategory,
  onDropAllocation,
  onDragEnd,
  onDragStart,
  onAmountInputRef,
  onAllocationRowRef,
  onSelectAllocation,
  onUpdateAllocation,
  selectedAllocationId,
}: {
  addCategoryRequestId?: number
  name: string
  subsectionId: string | null
  allocations: BudgetAllocation[]
  categories: Category[]
  allocatedCategoryIds: string[]
  busyId: string | null
  draggedItem: DraggedBudgetItem | null
  isNested?: boolean
  onAddAllocation: (
    category: Category,
    subsectionId: string | null,
  ) => Promise<void>
  onCreateCategory: (name: string) => Promise<Category>
  onDropAllocation: (
    event: DragEvent,
    subsectionId: string | null,
    targetPosition: number,
  ) => Promise<void>
  onDragEnd: () => void
  onDragStart: (item: DraggedBudgetItem) => void
  onAmountInputRef: (
    allocationId: string,
    input: HTMLInputElement | null,
  ) => void
  onAllocationRowRef: (
    allocationId: string,
    row: HTMLDivElement | null,
  ) => void
  onSelectAllocation: (allocationId: string) => void
  onUpdateAllocation: (
    allocation: BudgetAllocation,
    magnitude: number,
    direction?: BudgetDirection,
  ) => Promise<boolean>
  selectedAllocationId: string | null
}) {
  const [isAddingCategory, setIsAddingCategory] = useState(false)
  useEffect(() => {
    if (addCategoryRequestId !== undefined) {
      // oxlint-disable-next-line react/set-state-in-effect -- A keyboard request opens this group-owned combobox.
      setIsAddingCategory(true)
    }
  }, [addCategoryRequestId])
  const planned = allocations.reduce(
    (sum, allocation) => sum + Math.abs(allocation.budgeted_amount),
    0,
  )
  const activity = allocations.reduce(
    (sum, allocation) => sum + Math.abs(allocation.actual_amount),
    0,
  )
  const activityLabel = allocations.every(
    (allocation) => allocation.direction === 'income',
  )
    ? 'received'
    : allocations.every((allocation) => allocation.direction === 'spending')
      ? 'spent'
      : 'activity'
  const content = (
    <>
      <div className="group-head">
        <div className="row-main">
          {isNested && <span className="drag hover-reveal" aria-hidden="true">⠿</span>}
          <div>
            <h2>{name}</h2>
            <p className="subtle">
              {formatDisplayMoney(planned)} planned ·{' '}
              {formatDisplayMoney(activity)} {activityLabel}
            </p>
          </div>
        </div>
      </div>
      {allocations.map((allocation, index) => (
        <div className="budget-allocation-slot" key={allocation.allocation_id}>
          {draggedItem?.type === 'allocation' && (
            <BudgetDropTarget
              onDrop={(event) =>
                void onDropAllocation(event, subsectionId, index)
              }
            />
          )}
          <BudgetAllocationRow
            allocation={allocation}
            busy={busyId !== null}
            key={`${allocation.allocation_id}-${allocation.budgeted_amount}-${allocation.direction}`}
            onDragEnd={onDragEnd}
            onDragStart={onDragStart}
            onAmountInputRef={onAmountInputRef}
            onAllocationRowRef={onAllocationRowRef}
            onSelect={onSelectAllocation}
            onUpdate={onUpdateAllocation}
            selected={allocation.allocation_id === selectedAllocationId}
          />
        </div>
      ))}
      {draggedItem?.type === 'allocation' && (
        <BudgetDropTarget
          onDrop={(event) =>
            void onDropAllocation(event, subsectionId, allocations.length)
          }
        />
      )}
      <div className="inline-create-flow">
        <button
          className="inline-create-trigger"
          disabled={busyId !== null}
          type="button"
          onClick={() => setIsAddingCategory(true)}
        >
          ＋ Add or create category
        </button>
        {isAddingCategory && (
          <div className="budget-item provisional-budget-item">
            <div className="row-main">
              <span className="drag" aria-hidden="true">⠿</span>
              <CategoryCombobox
                autoFocus
                cancelOnBlur
                categories={categories}
                disabled={busyId !== null}
                excludedCategoryIds={allocatedCategoryIds}
                label={`Add or create a category in ${name}`}
                onCancel={() => setIsAddingCategory(false)}
                onCreate={onCreateCategory}
                onSelect={async (category) => {
                  await onAddAllocation(category, subsectionId)
                  setIsAddingCategory(false)
                }}
              />
            </div>
            <div className="mini-segmented" aria-label="New category direction">
              <button className="selected" disabled type="button">
                Spending
              </button>
              <button disabled type="button">Income</button>
            </div>
            <div
              aria-label="0% of planned spending"
              className="progress"
              role="progressbar"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={0}
            >
              <i style={{ width: '0%' }} />
            </div>
            <input
              aria-label="New category planned magnitude"
              className="amount-input"
              disabled
              value="0.00"
            />
          </div>
        )}
      </div>
    </>
  )

  if (isNested) {
    return content
  }
  return <section className="budget-group">{content}</section>
}

function BudgetAllocationRow({
  allocation,
  busy,
  onDragEnd,
  onDragStart,
  onAmountInputRef,
  onAllocationRowRef,
  onSelect,
  onUpdate,
  selected,
}: {
  allocation: BudgetAllocation
  busy: boolean
  onDragEnd: () => void
  onDragStart: (item: DraggedBudgetItem) => void
  onAmountInputRef: (
    allocationId: string,
    input: HTMLInputElement | null,
  ) => void
  onAllocationRowRef: (
    allocationId: string,
    row: HTMLDivElement | null,
  ) => void
  onSelect: (allocationId: string) => void
  onUpdate: (
    allocation: BudgetAllocation,
    magnitude: number,
    direction?: BudgetDirection,
  ) => Promise<boolean>
  selected: boolean
}) {
  const plannedMagnitude = Math.abs(allocation.budgeted_amount)
  const [magnitudeValue, setMagnitudeValue] = useState(plannedMagnitude.toFixed(2))
  const isSaving = useRef(false)
  const actualMagnitude =
    allocation.direction === 'spending'
      ? Math.max(0, -allocation.actual_amount)
      : Math.max(0, allocation.actual_amount)
  const progress =
    plannedMagnitude === 0
      ? 0
      : Math.min(100, Math.round((actualMagnitude / plannedMagnitude) * 100))

  async function saveMagnitude(
    direction: BudgetDirection = allocation.direction,
  ): Promise<boolean> {
    if (isSaving.current) {
      return false
    }
    const parsed = parseMagnitude(magnitudeValue)
    if (parsed === null) {
      setMagnitudeValue(plannedMagnitude.toFixed(2))
      return false
    }
    if (
      direction === allocation.direction &&
      Math.round(parsed * 100) === Math.round(plannedMagnitude * 100)
    ) {
      setMagnitudeValue(parsed.toFixed(2))
      return true
    }
    isSaving.current = true
    const didSave = await onUpdate(allocation, parsed, direction)
    isSaving.current = false
    if (!didSave) {
      setMagnitudeValue(plannedMagnitude.toFixed(2))
    }
    return didSave
  }

  return (
    <div
      aria-current={selected ? 'true' : undefined}
      aria-label={`${allocation.category_name} budget category`}
      className={`row budget-item budget-item--${allocation.direction}${
        selected ? ' is-selected' : ''
      }`}
      data-budget-row-selected={selected ? 'true' : undefined}
      draggable={!busy}
      ref={(row) => onAllocationRowRef(allocation.allocation_id, row)}
      role="group"
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(allocation.allocation_id)}
      onDragEnd={onDragEnd}
      onDragStart={(event) => {
        const item: DraggedBudgetItem = {
          id: allocation.allocation_id,
          type: 'allocation',
        }
        event.stopPropagation()
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(
          budgetDragType,
          JSON.stringify(item),
        )
        onDragStart(item)
      }}
      onFocus={() => onSelect(allocation.allocation_id)}
    >
      <div className="row-main">
        <span className="drag hover-reveal" aria-hidden="true">⠿</span>
        <div>
          <strong>{allocation.category_name}</strong>
          <p>
            {formatDisplayMoney(actualMagnitude)} of{' '}
            {formatDisplayMoney(plannedMagnitude)}{' '}
            {allocation.direction === 'spending' ? 'spent' : 'received'}
          </p>
        </div>
      </div>
      <div className="mini-segmented" aria-label={`${allocation.category_name} direction`}>
        {(['spending', 'income'] as const).map((direction) => (
          <button
            aria-pressed={allocation.direction === direction}
            className={allocation.direction === direction ? 'selected' : ''}
            disabled={busy}
            key={direction}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (direction !== allocation.direction) {
                void saveMagnitude(direction)
              }
            }}
          >
            {direction === 'spending' ? 'Spending' : 'Income'}
          </button>
        ))}
      </div>
      <div
        aria-label={`${progress}% of planned ${allocation.direction}`}
        className="progress"
        role="progressbar"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress}
      >
        <i style={{ width: `${progress}%` }} />
      </div>
      <MagnitudeInput
        allocation={allocation}
        busy={busy}
        inputRef={(input) => onAmountInputRef(allocation.allocation_id, input)}
        value={magnitudeValue}
        onBlur={() => void saveMagnitude()}
        onChange={setMagnitudeValue}
        onReset={() => setMagnitudeValue(plannedMagnitude.toFixed(2))}
      />
    </div>
  )
}

function BudgetDropTarget({
  onDrop,
}: {
  onDrop: (event: DragEvent) => void
}) {
  const [isActive, setIsActive] = useState(false)
  return (
    <div
      className={`budget-drop-target${isActive ? ' active' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault()
        setIsActive(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsActive(false)
        }
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setIsActive(false)
        onDrop(event)
      }}
    >
      <span>Drop here</span>
    </div>
  )
}

function MagnitudeInput({
  allocation,
  busy,
  value,
  inputRef,
  onBlur,
  onChange,
  onReset,
}: {
  allocation: BudgetAllocation
  busy: boolean
  value: string
  inputRef: (input: HTMLInputElement | null) => void
  onBlur: () => void
  onChange: (value: string) => void
  onReset: () => void
}) {
  return (
    <input
      aria-label={`${allocation.category_name} planned magnitude`}
      className="amount-input"
      disabled={busy}
      inputMode="decimal"
      ref={inputRef}
      type="text"
      value={value}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          onReset()
          event.currentTarget.blur()
        }
      }}
    />
  )
}
