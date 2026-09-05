import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
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
  monthKey,
  parseMagnitude,
  shiftMonth,
} from '../finance/utils.ts'
import { getSupabaseClient } from '../lib/supabase.ts'
import { focusWithScrollComfort } from '../navigation/focus.ts'
import { useAuth } from '../auth/useAuth.ts'

interface BudgetData {
  budgets: Budget[]
  budget: Budget | null
  subsections: BudgetSubsection[]
  allocations: BudgetAllocation[]
  categories: Category[]
  ignoredTransactionIds: string[]
  uncategorizedCount: number
}

interface AmountEditRequest {
  allocationId: string
  sequence: number
}

export interface BudgetKeyboardAction {
  action:
    | 'start-delete'
    | 'start-create'
    | 'start-move'
    | 'start-rename'
    | 'previous'
    | 'next'
    | 'confirm'
    | 'cancel'
  semanticId: string | null
  sequence: number
}

export interface BudgetKeyboardInteraction {
  mode:
    | 'confirm-delete'
    | 'choose-create'
    | 'choose-category'
    | 'name-entry'
    | 'rename-entry'
    | 'moving'
    | 'saving-move'
  label: string
}

type BudgetEntry =
  | {
      allocation: BudgetAllocation
      kind: 'allocation'
      semanticId: string
    }
  | {
      kind: 'subsection'
      semanticId: string
      subsection: BudgetSubsection
    }

interface PendingCreation {
  kind: 'allocation' | 'subsection'
  originSemanticId: string
  position: number
  subsectionId: string | null
}

type MoveLocation =
  | {
      kind: 'allocation'
      position: number
      subsectionId: string | null
    }
  | {
      kind: 'subsection'
      position: number
    }

interface MovingEntry {
  entry: BudgetEntry
  originalLocation: MoveLocation
  previewLocation: MoveLocation
}

type TopLevelBudgetEntry =
  | {
      allocation: BudgetAllocation
      kind: 'allocation'
    }
  | {
      kind: 'subsection'
      subsection: BudgetSubsection
    }

interface BudgetMovePreview {
  allocations: BudgetAllocation[]
  subsections: BudgetSubsection[]
}

function comparePosition(
  left: { position: number },
  right: { position: number },
): number {
  return left.position - right.position
}

function getTopLevelBudgetEntries(
  allocations: BudgetAllocation[],
  subsections: BudgetSubsection[],
): TopLevelBudgetEntry[] {
  return [
    ...allocations
      .filter((allocation) => allocation.subsection_id === null)
      .map((allocation) => ({ allocation, kind: 'allocation' as const })),
    ...subsections.map((subsection) => ({
      kind: 'subsection' as const,
      subsection,
    })),
  ].sort((left, right) =>
    comparePosition(
      left.kind === 'allocation' ? left.allocation : left.subsection,
      right.kind === 'allocation' ? right.allocation : right.subsection,
    ),
  )
}

function sameMoveLocation(left: MoveLocation, right: MoveLocation): boolean {
  return (
    left.kind === right.kind &&
    left.position === right.position &&
    (left.kind !== 'allocation' ||
      right.kind !== 'allocation' ||
      left.subsectionId === right.subsectionId)
  )
}

function moveBudgetPreview(
  allocations: BudgetAllocation[],
  subsections: BudgetSubsection[],
  movingEntry: MovingEntry,
): BudgetMovePreview {
  const allocationGroups = new Map<string | null, BudgetAllocation[]>()
  for (const allocation of allocations) {
    const group = allocationGroups.get(allocation.subsection_id) ?? []
    group.push(allocation)
    allocationGroups.set(allocation.subsection_id, group)
  }
  for (const group of allocationGroups.values()) {
    group.sort(comparePosition)
  }

  const topLevelEntries = getTopLevelBudgetEntries(allocations, subsections)

  if (movingEntry.entry.kind === 'allocation') {
    const source = movingEntry.entry.allocation
    if (source.subsection_id === null) {
      const sourceIndex = topLevelEntries.findIndex(
        (entry) =>
          entry.kind === 'allocation' &&
          entry.allocation.allocation_id === source.allocation_id,
      )
      topLevelEntries.splice(sourceIndex, 1)
    } else {
      allocationGroups.set(
        source.subsection_id,
        (allocationGroups.get(source.subsection_id) ?? []).filter(
          (allocation) => allocation.allocation_id !== source.allocation_id,
        ),
      )
    }

    const target = movingEntry.previewLocation
    if (target.kind !== 'allocation') {
      return { allocations, subsections }
    }
    if (target.subsectionId === null) {
      topLevelEntries.splice(target.position, 0, {
        allocation: source,
        kind: 'allocation',
      })
    } else {
      const targetGroup = allocationGroups.get(target.subsectionId) ?? []
      targetGroup.splice(target.position, 0, source)
      allocationGroups.set(target.subsectionId, targetGroup)
    }
  } else {
    const source = movingEntry.entry.subsection
    const sourceIndex = topLevelEntries.findIndex(
      (entry) =>
        entry.kind === 'subsection' && entry.subsection.id === source.id,
    )
    topLevelEntries.splice(sourceIndex, 1)
    const target = movingEntry.previewLocation
    if (target.kind !== 'subsection') {
      return { allocations, subsections }
    }
    topLevelEntries.splice(target.position, 0, {
      kind: 'subsection',
      subsection: source,
    })
  }

  const previewSubsections: BudgetSubsection[] = []
  const topLevelAllocations: BudgetAllocation[] = []

  topLevelEntries.forEach((entry, position) => {
    if (entry.kind === 'allocation') {
      topLevelAllocations.push({
        ...entry.allocation,
        position,
        subsection_id: null,
      })
      return
    }
    previewSubsections.push({
      ...entry.subsection,
      position,
    })
  })

  const previewAllocations = [
    ...topLevelAllocations,
    ...previewSubsections.flatMap((subsection) =>
      (allocationGroups.get(subsection.id) ?? []).map((allocation, position) => ({
        ...allocation,
        position,
        subsection_id: subsection.id,
      })),
    ),
  ]

  return {
    allocations: previewAllocations,
    subsections: previewSubsections,
  }
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') {
    return
  }
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
  )
  const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const nextIndex =
    currentIndex < 0
      ? 0
      : (currentIndex + (event.shiftKey ? -1 : 1) + buttons.length) %
        buttons.length
  event.preventDefault()
  buttons[nextIndex]?.focus()
}

async function queryBudget(month: string): Promise<BudgetData> {
  const client = getSupabaseClient()
  const [budgetsResult, categoriesResult, transactions, splits] = await Promise.all([
    client.from('budgets').select('id, month').order('month', { ascending: false }),
    client.from('categories').select('id, name').order('name'),
    collectPages((afterId, limit) => {
      let query = client
        .from('transactions')
        .select('id, transaction_date, currency_code, is_ignored')
        .order('id')
        .limit(limit)
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
    (transaction) =>
      !transaction.is_ignored &&
      monthKey(transaction.transaction_date) === month &&
      !categorizedTransactionIds.has(transaction.id),
  ).length
  const ignoredTransactionIds = transactions
    .filter(
      (transaction) =>
        transaction.is_ignored &&
        transaction.currency_code === 'USD' &&
        monthKey(transaction.transaction_date) === month,
    )
    .map((transaction) => transaction.id)
  const budget =
    budgets.find((candidate) => candidate.month.slice(0, 7) === month) ?? null

  if (!budget) {
    return {
      budgets,
      budget: null,
      subsections: [],
      allocations: [],
      categories: categoriesResult.data ?? [],
      ignoredTransactionIds,
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
    ignoredTransactionIds,
    uncategorizedCount,
  }
}

export function BudgetPanel({
  categoriesRevision,
  activityRevision,
  onCategoriesChanged,
  onOpenTransaction,
  onUncategorizedCountChange,
  selectedMonth,
  onMonthChange,
  focusedSemanticId,
  keyboardActionRequest,
  amountEditRequest,
  onAmountEditorClosed,
  onAmountEditorOpenChange,
  onKeyboardInteractionChange,
}: {
  categoriesRevision: number
  activityRevision: number
  onCategoriesChanged: () => void
  onOpenTransaction: (transactionId: string) => void
  onUncategorizedCountChange: (count: number) => void
  selectedMonth: string
  onMonthChange: (month: string) => void
  focusedSemanticId: string | null
  keyboardActionRequest: BudgetKeyboardAction | null
  amountEditRequest: AmountEditRequest | null
  onAmountEditorClosed: (allocationId: string) => void
  onAmountEditorOpenChange: (isOpen: boolean) => void
  onKeyboardInteractionChange: (
    interaction: BudgetKeyboardInteraction | null,
  ) => void
}) {
  const { user } = useAuth()
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [budget, setBudget] = useState<Budget | null>(null)
  const [subsections, setSubsections] = useState<BudgetSubsection[]>([])
  const [allocations, setAllocations] = useState<BudgetAllocation[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [ignoredTransactionIds, setIgnoredTransactionIds] = useState<string[]>([])
  const [uncategorizedCount, setUncategorizedCount] = useState(0)
  const [editingAllocationId, setEditingAllocationId] = useState<string | null>(
    null,
  )
  const [deleteTarget, setDeleteTarget] = useState<BudgetEntry | null>(null)
  const [deleteChoice, setDeleteChoice] = useState<'yes' | 'no'>('no')
  const [creationTarget, setCreationTarget] = useState<BudgetEntry | null>(null)
  const [creationKind, setCreationKind] = useState<'allocation' | 'subsection'>(
    'allocation',
  )
  const [pendingCreation, setPendingCreation] =
    useState<PendingCreation | null>(null)
  const [pendingName, setPendingName] = useState('')
  const [renameTarget, setRenameTarget] = useState<BudgetEntry | null>(null)
  const [renameName, setRenameName] = useState('')
  const [movingEntry, setMovingEntry] = useState<MovingEntry | null>(null)
  const [savingMoveEntry, setSavingMoveEntry] = useState<BudgetEntry | null>(
    null,
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const mutationBusy = useRef(false)
  const handledKeyboardActionSequence = useRef(0)
  const deleteYesButtonRef = useRef<HTMLButtonElement>(null)
  const deleteNoButtonRef = useRef<HTMLButtonElement>(null)
  const createAllocationButtonRef = useRef<HTMLButtonElement>(null)
  const createSubsectionButtonRef = useRef<HTMLButtonElement>(null)
  const pendingNameInputRef = useRef<HTMLInputElement>(null)
  const renameNameInputRef = useRef<HTMLInputElement>(null)

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
      setIgnoredTransactionIds(data.ignoredTransactionIds)
      setUncategorizedCount(data.uncategorizedCount)
      onUncategorizedCountChange(data.uncategorizedCount)
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
  }, [onUncategorizedCountChange, selectedMonth])

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

  useEffect(
    () => () => onKeyboardInteractionChange(null),
    [onKeyboardInteractionChange],
  )

  async function runMutation<T = null>(
    id: string,
    mutation: () => PromiseLike<{
      data: T | null
      error: { message: string } | null
    }>,
    refreshOnSuccess = true,
  ): Promise<{ data: T | null; didSave: boolean }> {
    if (mutationBusy.current) {
      return { data: null, didSave: false }
    }
    mutationBusy.current = true
    setBusyId(id)
    setErrorMessage(null)
    try {
      const { data, error } = await mutation()
      if (error) {
        setErrorMessage(error.message)
        return { data: null, didSave: false }
      }
      if (refreshOnSuccess) {
        await loadBudget()
      }
      return { data, didSave: true }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'The budget change could not be saved.',
      )
      return { data: null, didSave: false }
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
    const { didSave } = await runMutation(
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

  function getEntryName(entry: BudgetEntry): string {
    return entry.kind === 'allocation'
      ? entry.allocation.category_name
      : entry.subsection.name
  }

  function findBudgetEntry(semanticId: string | null): BudgetEntry | null {
    if (!semanticId) {
      return null
    }
    const allocation = allocations.find(
      (candidate) => `budget-row-${candidate.allocation_id}` === semanticId,
    )
    if (allocation) {
      return {
        allocation,
        kind: 'allocation',
        semanticId,
      }
    }
    const subsection = subsections.find(
      (candidate) => `budget-subsection-${candidate.id}` === semanticId,
    )
    return subsection
      ? {
          kind: 'subsection',
          semanticId,
          subsection,
        }
      : null
  }

  function getNavigationEntries(): BudgetEntry[] {
    return getTopLevelBudgetEntries(allocations, subsections).flatMap((entry) =>
      entry.kind === 'allocation'
        ? [
            {
              allocation: entry.allocation,
              kind: 'allocation' as const,
              semanticId: `budget-row-${entry.allocation.allocation_id}`,
            },
          ]
        : [
            {
              kind: 'subsection' as const,
              semanticId: `budget-subsection-${entry.subsection.id}`,
              subsection: entry.subsection,
            },
            ...allocations
              .filter(
                (allocation) =>
                  allocation.subsection_id === entry.subsection.id,
              )
              .sort(comparePosition)
              .map((allocation) => ({
                allocation,
                kind: 'allocation' as const,
                semanticId: `budget-row-${allocation.allocation_id}`,
              })),
          ],
    )
  }

  function focusSemanticEntry(semanticId: string) {
    window.requestAnimationFrame(() => {
      const entry = document.getElementById(semanticId)
      if (entry) {
        focusWithScrollComfort(entry)
      }
    })
  }

  function focusInitialBudgetEntry() {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(
          '[data-semantic-kind="budget-row"], [data-semantic-kind="budget-subsection"], [data-semantic-kind="budget-first-item"]',
        )
        if (target) {
          focusWithScrollComfort(target)
        }
      })
    })
  }

  function closeDeleteConfirmation() {
    if (deleteTarget) {
      focusSemanticEntry(deleteTarget.semanticId)
    }
    setDeleteTarget(null)
    setDeleteChoice('no')
  }

  function closeCreation() {
    const originSemanticId =
      pendingCreation?.originSemanticId ?? creationTarget?.semanticId
    setCreationTarget(null)
    setPendingCreation(null)
    setPendingName('')
    if (originSemanticId) {
      focusSemanticEntry(originSemanticId)
    }
  }

  function closeRename() {
    if (renameTarget) {
      focusSemanticEntry(renameTarget.semanticId)
    }
    setRenameTarget(null)
    setRenameName('')
  }

  function closeMove() {
    if (movingEntry) {
      focusSemanticEntry(movingEntry.entry.semanticId)
    }
    setMovingEntry(null)
  }

  function creationPosition(
    target: BudgetEntry,
    kind: 'allocation' | 'subsection',
  ): PendingCreation {
    if (kind === 'allocation') {
      if (target.kind === 'subsection') {
        return {
          kind,
          originSemanticId: target.semanticId,
          position: 0,
          subsectionId: target.subsection.id,
        }
      }
      return {
        kind,
        originSemanticId: target.semanticId,
        position: target.allocation.position + 1,
        subsectionId: target.allocation.subsection_id,
      }
    }

    if (target.kind === 'subsection') {
      return {
        kind,
        originSemanticId: target.semanticId,
        position: target.subsection.position + 1,
        subsectionId: null,
      }
    }

    const containingSubsection = target.allocation.subsection_id
      ? subsections.find(
          (subsection) => subsection.id === target.allocation.subsection_id,
        )
      : null
    return {
      kind,
      originSemanticId: target.semanticId,
      position: containingSubsection
        ? containingSubsection.position + 1
        : target.allocation.position + 1,
      subsectionId: null,
    }
  }

  function beginPendingCreation(kind = creationKind) {
    if (!creationTarget) {
      return
    }
    setPendingName('')
    setPendingCreation(creationPosition(creationTarget, kind))
    setCreationTarget(null)
  }

  function beginFirstAllocation() {
    setPendingName('')
    setPendingCreation({
      kind: 'allocation',
      originSemanticId: 'budget-first-item',
      position: 0,
      subsectionId: null,
    })
  }

  async function createBudget(copyPrevious: boolean) {
    const result = await runMutation<string>(
      copyPrevious ? 'copy-budget' : 'create-budget',
      () =>
        copyPrevious
          ? getSupabaseClient().rpc('copy_previous_month_budget', {
              p_month: `${selectedMonth}-01`,
            })
          : getSupabaseClient().rpc('create_monthly_budget', {
              p_month: `${selectedMonth}-01`,
            }),
    )
    if (result.didSave) {
      focusInitialBudgetEntry()
    }
  }

  async function savePendingAllocation(category: Category) {
    if (pendingCreation?.kind !== 'allocation' || !budget) {
      return
    }
    const creation = pendingCreation
    const result = await runMutation<string>(
      'create-budget-line-item',
      () =>
        getSupabaseClient().rpc(
          'create_budget_category_allocation_at_position',
          {
            p_budget_id: budget.id,
            p_category_id: category.id,
            p_position: creation.position,
            p_subsection_id: creation.subsectionId,
          },
        ),
    )
    if (!result.didSave || !result.data) {
      throw new Error('The category could not be added to this budget.')
    }
    setPendingCreation(null)
    setPendingName('')
    focusSemanticEntry(`budget-row-${result.data}`)
  }

  async function savePendingSubsection() {
    if (pendingCreation?.kind !== 'subsection' || !budget) {
      return
    }
    const name = pendingName.trim()
    if (!name) {
      setErrorMessage('Enter a name before saving.')
      return
    }

    const result = await runMutation<string>(
      'create-budget-subsection',
      () =>
        getSupabaseClient().rpc('create_budget_subsection_at_position', {
          p_budget_id: budget.id,
          p_name: name,
          p_position: pendingCreation.position,
        }),
    )

    if (!result.didSave || !result.data) {
      return
    }

    setPendingCreation(null)
    setPendingName('')
    focusSemanticEntry(`budget-subsection-${result.data}`)
  }

  async function saveRename() {
    if (!renameTarget) {
      return
    }
    const name = renameName.trim()
    if (!name) {
      setErrorMessage('Enter a name before saving.')
      return
    }

    const { didSave } =
      renameTarget.kind === 'allocation'
        ? await runMutation(
            `rename-category-${renameTarget.allocation.category_id}`,
            () =>
              getSupabaseClient()
                .from('categories')
                .update({ name, updated_at: new Date().toISOString() })
                .eq('id', renameTarget.allocation.category_id),
          )
        : await runMutation(
            `rename-budget-subsection-${renameTarget.subsection.id}`,
            () =>
              getSupabaseClient().rpc('rename_budget_subsection', {
                p_name: name,
                p_subsection_id: renameTarget.subsection.id,
              }),
          )

    if (!didSave) {
      return
    }
    const semanticId = renameTarget.semanticId
    const renamedCategory = renameTarget.kind === 'allocation'
    setRenameTarget(null)
    setRenameName('')
    if (renamedCategory) {
      onCategoriesChanged()
    }
    focusSemanticEntry(semanticId)
  }

  function nearestFocusAfterDelete(target: BudgetEntry): string {
    const entries = getNavigationEntries()
    const targetIndex = entries.findIndex(
      (entry) => entry.semanticId === target.semanticId,
    )
    const isRemoved = (entry: BudgetEntry) =>
      entry.semanticId === target.semanticId ||
      (target.kind === 'subsection' &&
        entry.kind === 'allocation' &&
        entry.allocation.subsection_id === target.subsection.id)
    const following = entries.slice(targetIndex + 1).find(
      (entry) => !isRemoved(entry),
    )
    const previous = entries
      .slice(0, targetIndex)
      .toReversed()
      .find((entry) => !isRemoved(entry))
    return following?.semanticId ?? previous?.semanticId ?? 'budget-first-item'
  }

  async function confirmDelete(choice = deleteChoice) {
    if (!deleteTarget) {
      return
    }
    if (choice === 'no') {
      closeDeleteConfirmation()
      return
    }

    const focusAfterDelete = nearestFocusAfterDelete(deleteTarget)
    const { didSave } = await runMutation(
      deleteTarget.kind === 'allocation'
        ? `delete-budget-row-${deleteTarget.allocation.allocation_id}`
        : `delete-budget-subsection-${deleteTarget.subsection.id}`,
      () =>
        getSupabaseClient().rpc(
          deleteTarget.kind === 'allocation'
            ? 'remove_budget_allocation'
            : 'delete_budget_subsection',
          deleteTarget.kind === 'allocation'
            ? { p_allocation_id: deleteTarget.allocation.allocation_id }
            : { p_subsection_id: deleteTarget.subsection.id },
        ),
    )
    if (!didSave) {
      return
    }
    setDeleteTarget(null)
    setDeleteChoice('no')
    focusSemanticEntry(focusAfterDelete)
  }

  function getMoveLocations(entry: BudgetEntry): MoveLocation[] {
    const topLevelEntries = getTopLevelBudgetEntries(allocations, subsections)

    if (entry.kind === 'subsection') {
      const entriesWithoutSource = topLevelEntries.filter(
        (candidate) =>
          candidate.kind !== 'subsection' ||
          candidate.subsection.id !== entry.subsection.id,
      )
      return Array.from(
        { length: entriesWithoutSource.length + 1 },
        (_, position) => ({
          kind: 'subsection' as const,
          position,
        }),
      )
    }

    const entriesWithoutSource = topLevelEntries.filter(
      (candidate) =>
        candidate.kind !== 'allocation' ||
        candidate.allocation.allocation_id !== entry.allocation.allocation_id,
    )
    const locations: MoveLocation[] = []

    for (let topLevelPosition = 0;
      topLevelPosition <= entriesWithoutSource.length;
      topLevelPosition += 1) {
      locations.push({
        kind: 'allocation',
        position: topLevelPosition,
        subsectionId: null,
      })
      const nextEntry = entriesWithoutSource[topLevelPosition]
      if (nextEntry?.kind !== 'subsection') {
        continue
      }
      const subsectionAllocations = allocations
        .filter(
          (allocation) =>
            allocation.subsection_id === nextEntry.subsection.id &&
            allocation.allocation_id !== entry.allocation.allocation_id,
        )
        .sort(comparePosition)
      for (
        let subsectionPosition = 0;
        subsectionPosition <= subsectionAllocations.length;
        subsectionPosition += 1
      ) {
        locations.push({
          kind: 'allocation',
          position: subsectionPosition,
          subsectionId: nextEntry.subsection.id,
        })
      }
    }

    return locations.filter(
      (location, index) =>
        index === 0 ||
        !sameMoveLocation(location, locations[index - 1]),
    )
  }

  function startMove(entry: BudgetEntry) {
    const originalLocation: MoveLocation =
      entry.kind === 'allocation'
        ? {
            kind: 'allocation',
            position: entry.allocation.position,
            subsectionId: entry.allocation.subsection_id,
          }
        : {
            kind: 'subsection',
            position: entry.subsection.position,
          }
    setMovingEntry({
      entry,
      originalLocation,
      previewLocation: originalLocation,
    })
  }

  function movePreview(direction: 1 | -1) {
    setMovingEntry((current) => {
      if (!current) {
        return current
      }
      const locations = getMoveLocations(current.entry)
      const currentIndex = locations.findIndex((location) =>
        sameMoveLocation(location, current.previewLocation),
      )
      const nextLocation = locations[currentIndex + direction]
      if (!nextLocation) {
        return current
      }
      return {
        ...current,
        previewLocation: nextLocation,
      }
    })
  }

  function confirmMove() {
    if (!movingEntry) {
      return
    }
    if (
      sameMoveLocation(
        movingEntry.previewLocation,
        movingEntry.originalLocation,
      )
    ) {
      closeMove()
      return
    }

    const previousAllocations = allocations
    const previousSubsections = subsections
    const preview = moveBudgetPreview(
      allocations,
      subsections,
      movingEntry,
    )
    const { entry, previewLocation } = movingEntry
    setAllocations(preview.allocations)
    setSubsections(preview.subsections)
    setMovingEntry(null)
    setSavingMoveEntry(entry)
    focusSemanticEntry(entry.semanticId)

    void runMutation(
      entry.kind === 'allocation'
        ? `move-budget-row-${entry.allocation.allocation_id}`
        : `move-budget-subsection-${entry.subsection.id}`,
      () =>
        entry.kind === 'allocation' &&
        previewLocation.kind === 'allocation'
          ? getSupabaseClient().rpc('place_budget_category_allocation', {
              p_allocation_id: entry.allocation.allocation_id,
              p_position: previewLocation.position,
              p_subsection_id: previewLocation.subsectionId,
            })
          : entry.kind === 'subsection' &&
              previewLocation.kind === 'subsection'
            ? getSupabaseClient().rpc('place_budget_subsection', {
                p_position: previewLocation.position,
                p_subsection_id: entry.subsection.id,
              })
            : Promise.resolve({
                data: null,
                error: { message: 'The budget entry could not be moved.' },
              }),
      false,
    ).then(({ didSave }) => {
      if (!didSave) {
        setAllocations(previousAllocations)
        setSubsections(previousSubsections)
        setSavingMoveEntry(null)
        focusSemanticEntry(entry.semanticId)
        return
      }
      setSavingMoveEntry(null)
      void loadBudget()
    })
  }

  useEffect(() => {
    if (deleteTarget) {
      onKeyboardInteractionChange({
        label: `delete ${getEntryName(deleteTarget).toLocaleLowerCase()}`,
        mode: 'confirm-delete',
      })
      return
    }
    if (creationTarget) {
      onKeyboardInteractionChange({
        label: `create below ${getEntryName(creationTarget).toLocaleLowerCase()}`,
        mode: 'choose-create',
      })
      return
    }
    if (pendingCreation) {
      onKeyboardInteractionChange({
        label:
          pendingCreation.kind === 'allocation'
            ? pendingName.trim()
              ? 'choose or create category'
              : 'choose category'
            : 'name subsection',
        mode:
          pendingCreation.kind === 'allocation'
            ? 'choose-category'
            : 'name-entry',
      })
      return
    }
    if (renameTarget) {
      onKeyboardInteractionChange({
        label: `rename ${getEntryName(renameTarget).toLocaleLowerCase()}`,
        mode: 'rename-entry',
      })
      return
    }
    if (movingEntry) {
      onKeyboardInteractionChange({
        label: `move ${getEntryName(movingEntry.entry).toLocaleLowerCase()}`,
        mode: 'moving',
      })
      return
    }
    if (savingMoveEntry) {
      onKeyboardInteractionChange({
        label: `move ${getEntryName(savingMoveEntry).toLocaleLowerCase()}`,
        mode: 'saving-move',
      })
      return
    }
    onKeyboardInteractionChange(null)
  }, [
    creationTarget,
    deleteTarget,
    movingEntry,
    onKeyboardInteractionChange,
    pendingCreation,
    pendingName,
    renameTarget,
    savingMoveEntry,
  ])

  useEffect(() => {
    if (!deleteTarget && !creationTarget && !pendingCreation && !renameTarget) {
      return
    }
    window.requestAnimationFrame(() => {
      if (deleteTarget) {
        const selectedDeleteButton = deleteChoice === 'yes'
          ? deleteYesButtonRef.current
          : deleteNoButtonRef.current
        selectedDeleteButton?.focus()
        return
      }
      if (creationTarget) {
        const selectedCreationButton = creationKind === 'allocation'
          ? createAllocationButtonRef.current
          : createSubsectionButtonRef.current
        selectedCreationButton?.focus()
        return
      }
      if (pendingCreation) {
        if (pendingNameInputRef.current) {
          focusWithScrollComfort(pendingNameInputRef.current)
        }
        return
      }
      if (renameNameInputRef.current) {
        focusWithScrollComfort(renameNameInputRef.current)
      }
    })
  }, [
    creationKind,
    creationTarget,
    deleteChoice,
    deleteTarget,
    pendingCreation,
    renameTarget,
  ])

  useEffect(() => {
    if (
      !keyboardActionRequest ||
      keyboardActionRequest.sequence === handledKeyboardActionSequence.current
    ) {
      return
    }
    handledKeyboardActionSequence.current = keyboardActionRequest.sequence

    if (keyboardActionRequest.action === 'start-delete') {
      if (
        deleteTarget ||
        creationTarget ||
        pendingCreation ||
        renameTarget ||
        movingEntry ||
        savingMoveEntry ||
        mutationBusy.current
      ) {
        return
      }
      const target = findBudgetEntry(keyboardActionRequest.semanticId)
      if (target) {
        // oxlint-disable-next-line react/set-state-in-effect -- This effect applies a parent keyboard action request to local interaction state.
        setDeleteTarget(target)
        setDeleteChoice('no')
      }
      return
    }

    if (keyboardActionRequest.action === 'start-create') {
      if (
        deleteTarget ||
        creationTarget ||
        pendingCreation ||
        renameTarget ||
        movingEntry ||
        savingMoveEntry ||
        mutationBusy.current
      ) {
        return
      }
      const target = findBudgetEntry(keyboardActionRequest.semanticId)
      if (target) {
        setCreationTarget(target)
        setCreationKind('allocation')
      }
      return
    }

    if (keyboardActionRequest.action === 'start-move') {
      if (
        deleteTarget ||
        creationTarget ||
        pendingCreation ||
        renameTarget ||
        movingEntry ||
        savingMoveEntry ||
        mutationBusy.current
      ) {
        return
      }
      const target = findBudgetEntry(keyboardActionRequest.semanticId)
      if (target) {
        startMove(target)
      }
      return
    }

    if (keyboardActionRequest.action === 'start-rename') {
      if (
        deleteTarget ||
        creationTarget ||
        pendingCreation ||
        renameTarget ||
        movingEntry ||
        savingMoveEntry ||
        mutationBusy.current
      ) {
        return
      }
      const target = findBudgetEntry(keyboardActionRequest.semanticId)
      if (target) {
        setRenameTarget(target)
        setRenameName(getEntryName(target))
      }
      return
    }

    if (keyboardActionRequest.action === 'previous') {
      if (deleteTarget) {
        setDeleteChoice((choice) => (choice === 'yes' ? 'no' : 'yes'))
      } else if (creationTarget) {
        setCreationKind((kind) =>
          kind === 'allocation' ? 'subsection' : 'allocation',
        )
      } else if (movingEntry) {
        movePreview(-1)
      }
      return
    }

    if (keyboardActionRequest.action === 'next') {
      if (deleteTarget) {
        setDeleteChoice((choice) => (choice === 'yes' ? 'no' : 'yes'))
      } else if (creationTarget) {
        setCreationKind((kind) =>
          kind === 'allocation' ? 'subsection' : 'allocation',
        )
      } else if (movingEntry) {
        movePreview(1)
      }
      return
    }

    if (keyboardActionRequest.action === 'confirm') {
      if (deleteTarget) {
        void confirmDelete()
      } else if (creationTarget) {
        beginPendingCreation()
      } else if (movingEntry) {
        void confirmMove()
      }
      return
    }

    if (keyboardActionRequest.action === 'cancel') {
      if (deleteTarget) {
        closeDeleteConfirmation()
      } else if (creationTarget || pendingCreation) {
        closeCreation()
      } else if (renameTarget) {
        closeRename()
      } else if (movingEntry) {
        closeMove()
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- The request sequence is the effect trigger; render-local helpers use the listed state.
  }, [
    allocations,
    creationKind,
    creationTarget,
    deleteChoice,
    deleteTarget,
    keyboardActionRequest,
    movingEntry,
    pendingCreation,
    renameTarget,
    savingMoveEntry,
    subsections,
  ])

  const spendingAllocations = allocations.filter(
    (allocation) => allocation.direction === 'spending',
  )
  const plannedSpending = spendingAllocations.reduce(
    (sum, allocation) => sum + Math.abs(allocation.budgeted_amount),
    0,
  )
  const spent = spendingAllocations.reduce(
    (sum, allocation) => sum - allocation.actual_amount,
    0,
  )
  const allocatedCategoryIds = allocations.map(
    (allocation) => allocation.category_id,
  )
  const displayedBudget = movingEntry
    ? moveBudgetPreview(allocations, subsections, movingEntry)
    : { allocations, subsections }
  const displayedTopLevelEntries = getTopLevelBudgetEntries(
    displayedBudget.allocations,
    displayedBudget.subsections,
  )
  const previousMonth = shiftMonth(selectedMonth, -1)
  const hasPreviousBudget = budgets.some(
    (candidate) => candidate.month.slice(0, 7) === previousMonth,
  )

  function allocationsForSubsection(subsectionId: string | null) {
    return displayedBudget.allocations.filter(
      (allocation) => allocation.subsection_id === subsectionId,
    )
  }

  function renderPendingSubsection() {
    return (
      <PendingSubsection
        busy={busyId !== null}
        name={pendingName}
        nameInputRef={pendingNameInputRef}
        onCancel={closeCreation}
        onNameChange={setPendingName}
        onSave={() => void savePendingSubsection()}
      />
    )
  }

  function renderPendingAllocation(isSectioned: boolean): ReactNode {
    return (
      <PendingBudgetAllocation
        busy={busyId !== null}
        categories={categories}
        excludedCategoryIds={allocatedCategoryIds}
        isSectioned={isSectioned}
        nameInputRef={pendingNameInputRef}
        onCancel={closeCreation}
        onCreate={createCategory}
        onQueryChange={setPendingName}
        onSelect={savePendingAllocation}
      />
    )
  }

  function renderPendingTopLevelEntry() {
    if (pendingCreation?.kind === 'subsection') {
      return renderPendingSubsection()
    }
    if (
      pendingCreation?.kind === 'allocation' &&
      pendingCreation.subsectionId === null
    ) {
      return renderPendingAllocation(false)
    }
    return null
  }

  function isPendingTopLevelEntryAt(position: number) {
    return (
      pendingCreation !== null &&
      (pendingCreation.kind === 'subsection' ||
        pendingCreation.subsectionId === null) &&
      pendingCreation.position === position
    )
  }

  function renderSubsection(subsection: BudgetSubsection) {
    return (
      <BudgetGroup
        allocations={allocationsForSubsection(subsection.id)}
        busyId={busyId}
        editingAllocationId={editingAllocationId}
        focusedSemanticId={focusedSemanticId}
        movingEntry={movingEntry}
        name={subsection.name}
        onEdit={setEditingAllocationId}
        onAmountEditorClosed={onAmountEditorClosed}
        onAmountEditorOpenChange={onAmountEditorOpenChange}
        onUpdate={updateAllocation}
        pendingCreation={
          pendingCreation?.kind === 'allocation' &&
          pendingCreation.subsectionId === subsection.id
            ? pendingCreation
            : null
        }
        renameName={renameName}
        renameNameInputRef={renameNameInputRef}
        renameTarget={renameTarget}
        showHeader
        subsection={subsection}
        renderPendingAllocation={renderPendingAllocation}
        onRenameCancel={closeRename}
        onRenameNameChange={setRenameName}
        onRenameSave={() => void saveRename()}
      />
    )
  }

  function renderRootAllocation(allocation: BudgetAllocation) {
    return (
      <BudgetAllocationRow
        allocation={allocation}
        busyId={busyId}
        editingAllocationId={editingAllocationId}
        focusedSemanticId={focusedSemanticId}
        isPickedUp={
          movingEntry?.entry.kind === 'allocation' &&
          movingEntry.entry.allocation.allocation_id === allocation.allocation_id
        }
        isRenaming={
          renameTarget?.kind === 'allocation' &&
          renameTarget.allocation.allocation_id === allocation.allocation_id
        }
        isSectioned={false}
        onEdit={setEditingAllocationId}
        onAmountEditorClosed={onAmountEditorClosed}
        onAmountEditorOpenChange={onAmountEditorOpenChange}
        onRenameCancel={closeRename}
        onRenameNameChange={setRenameName}
        onRenameSave={() => void saveRename()}
        onUpdate={updateAllocation}
        renameName={renameName}
        renameNameInputRef={renameNameInputRef}
      />
    )
  }

  return (
    <>
      <header className="workspace-head">
        <div>
          <p className="eyebrow">Budget / {selectedMonth.replace('-', ' / ')}</p>
          <h1>{formatMonth(selectedMonth)}</h1>
          <p className="subtitle">Plan with the keyboard. Review with a glance.</p>
        </div>
        <nav className="month-jump-controls" aria-label="Month navigation">
          <button
            data-semantic-id="month-previous"
            data-semantic-region="workspace"
            data-status-action="previous month"
            data-status-label="budget / previous month"
            disabled={busyId !== null}
            type="button"
            onClick={() => onMonthChange(shiftMonth(selectedMonth, -1))}
          >
            <span aria-hidden="true">←</span>
            <span>
              <small>Previous month</small>
              <strong>{formatMonth(shiftMonth(selectedMonth, -1))}</strong>
            </span>
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
            <span>
              <small>Next month</small>
              <strong>{formatMonth(shiftMonth(selectedMonth, 1))}</strong>
            </span>
            <span aria-hidden="true">→</span>
          </button>
        </nav>
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
        <section className="screen-panel empty-terminal empty-terminal--streamlined">
          <div className="empty-terminal__copy">
            <p className="eyebrow">Buffer empty</p>
            <h2>Create the {formatMonth(selectedMonth)} budget.</h2>
            <p>
              {hasPreviousBudget
                ? 'Start empty or reuse last month’s structure and planned amounts.'
                : 'Set up an empty workspace now, then add subsections and categories in the order that makes sense for the month.'}
            </p>
            <div className="empty-budget-actions">
              <button
                className="terminal-button terminal-button--primary"
                data-semantic-id="create-empty-budget"
                data-semantic-region="workspace"
                data-status-action="create empty budget"
                data-status-label={`budget / create empty ${formatMonth(selectedMonth)}`}
                type="button"
                disabled={busyId !== null}
                onClick={() => void createBudget(false)}
              >
                {busyId === 'create-budget'
                  ? 'Creating month...'
                  : `+ Create empty ${formatMonth(selectedMonth)} budget`}
              </button>
              {hasPreviousBudget && (
                <button
                  className="terminal-button empty-budget-copy"
                  data-semantic-id="copy-previous-budget"
                  data-semantic-region="workspace"
                  data-status-action="copy previous budget"
                  data-status-label={`budget / copy ${formatMonth(previousMonth)}`}
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void createBudget(true)}
                >
                  {busyId === 'copy-budget'
                    ? 'Copying budget...'
                    : `Copy ${formatMonth(previousMonth)} budget`}
                </button>
              )}
            </div>
          </div>
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

          {ignoredTransactionIds.length > 0 && (
            <aside
              className="ignored-report-notice"
              aria-label="Ignored budget activity"
            >
              <span className="terminal-pill terminal-pill--muted">
                {ignoredTransactionIds.length} ignored
              </span>
              <span>Excluded from budget actuals</span>
              <button
                className="terminal-button"
                data-semantic-id="budget-ignored-transactions"
                data-semantic-kind="budget-action"
                data-semantic-region="workspace"
                data-status-action="view ignored transactions"
                data-status-label="budget / ignored activity"
                type="button"
                onClick={() => onOpenTransaction(ignoredTransactionIds[0])}
              >
                View transaction{ignoredTransactionIds.length === 1 ? '' : 's'}
              </button>
            </aside>
          )}

          <section className="budget-table" aria-labelledby="budget-heading">
            <div className="table-head">
              <div>
                <p className="eyebrow">Monthly plan</p>
                <h2 id="budget-heading" tabIndex={-1}>Categories</h2>
              </div>
            </div>
            <div className="column-head" aria-hidden="true">
              <span>Category</span>
              <span>Type</span>
              <span>Planned</span>
              <span>Spent / Received</span>
              <span>Remaining</span>
            </div>
            {displayedTopLevelEntries.length === 0 && !pendingCreation && (
              <button
                className={`first-budget-item${
                  focusedSemanticId === 'budget-first-item' ? ' is-selected' : ''
                }`}
                data-semantic-id="budget-first-item"
                data-semantic-kind="budget-first-item"
                data-semantic-region="workspace"
                data-status-action="choose category"
                data-status-label="budget / add first item"
                id="budget-first-item"
                type="button"
                onClick={beginFirstAllocation}
              >
                <span>
                  <i className="selection-caret">›</i>
                  Add first budget line item
                </span>
              </button>
            )}
            {displayedTopLevelEntries.map((entry, index) => (
              <Fragment
                key={
                  entry.kind === 'allocation'
                    ? entry.allocation.allocation_id
                    : entry.subsection.id
                }
              >
                {isPendingTopLevelEntryAt(index) &&
                  renderPendingTopLevelEntry()}
                {entry.kind === 'allocation'
                  ? renderRootAllocation(entry.allocation)
                  : renderSubsection(entry.subsection)}
              </Fragment>
            ))}
            {isPendingTopLevelEntryAt(displayedTopLevelEntries.length) &&
              renderPendingTopLevelEntry()}
          </section>
        </>
      )}
      {deleteTarget && (
        <BudgetActionDialog
          deleteChoice={deleteChoice}
          deleteYesButtonRef={deleteYesButtonRef}
          deleteNoButtonRef={deleteNoButtonRef}
          entry={deleteTarget}
          allocationCount={
            deleteTarget.kind === 'subsection'
              ? allocations.filter(
                  (allocation) =>
                    allocation.subsection_id === deleteTarget.subsection.id,
                ).length
              : 0
          }
          onCancel={closeDeleteConfirmation}
          onChoose={setDeleteChoice}
          onConfirm={(choice) => void confirmDelete(choice)}
        />
      )}
      {creationTarget && (
        <CreateBudgetEntryDialog
          allocationButtonRef={createAllocationButtonRef}
          creationKind={creationKind}
          entry={creationTarget}
          subsectionButtonRef={createSubsectionButtonRef}
          onChoose={setCreationKind}
          onConfirm={beginPendingCreation}
        />
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
  movingEntry,
  name,
  onEdit,
  onAmountEditorClosed,
  onAmountEditorOpenChange,
  onRenameCancel,
  onRenameNameChange,
  onRenameSave,
  onUpdate,
  pendingCreation,
  renameName,
  renameNameInputRef,
  renameTarget,
  renderPendingAllocation,
  showHeader,
  subsection,
}: {
  allocations: BudgetAllocation[]
  busyId: string | null
  editingAllocationId: string | null
  focusedSemanticId: string | null
  movingEntry: MovingEntry | null
  name: string
  onEdit: (allocationId: string | null) => void
  onAmountEditorClosed: (allocationId: string) => void
  onAmountEditorOpenChange: (isOpen: boolean) => void
  onRenameCancel: () => void
  onRenameNameChange: (name: string) => void
  onRenameSave: () => void
  onUpdate: (
    allocation: BudgetAllocation,
    magnitude: number,
    direction: BudgetDirection,
  ) => Promise<boolean>
  pendingCreation: PendingCreation | null
  renameName: string
  renameNameInputRef: RefObject<HTMLInputElement | null>
  renameTarget: BudgetEntry | null
  renderPendingAllocation: (isSectioned: boolean) => ReactNode
  showHeader: boolean
  subsection: BudgetSubsection | null
}) {
  const planned = allocations.reduce(
    (sum, allocation) => sum + Math.abs(allocation.budgeted_amount),
    0,
  )
  const subsectionSemanticId = subsection
    ? `budget-subsection-${subsection.id}`
    : null
  const isSubsectionSelected =
    subsectionSemanticId !== null && focusedSemanticId === subsectionSemanticId
  const isSubsectionRenaming =
    renameTarget?.kind === 'subsection' &&
    renameTarget.subsection.id === subsection?.id
  const isSubsectionPickedUp =
    movingEntry?.entry.kind === 'subsection' &&
    movingEntry.entry.subsection.id === subsection?.id
  const displayedAllocations: Array<BudgetAllocation | null> = [...allocations]
  if (pendingCreation) {
    displayedAllocations.splice(pendingCreation.position, 0, null)
  }

  return (
    <section
      className={`budget-group${showHeader ? '' : ' budget-group--root'}${
        isSubsectionPickedUp ? ' is-picked-up' : ''
      }`}
    >
      {showHeader && (
        <header
          aria-current={
            isSubsectionSelected || isSubsectionRenaming ? 'true' : undefined
          }
          className={`budget-subsection-head${
            isSubsectionSelected || isSubsectionRenaming ? ' is-selected' : ''
          }`}
          data-semantic-id={subsectionSemanticId ?? undefined}
          data-semantic-kind={subsection ? 'budget-subsection' : undefined}
          data-semantic-region={subsection ? 'workspace' : undefined}
          data-status-action={subsection ? 'subsection' : undefined}
          data-status-label={
            subsection
              ? `budget / ${subsection.name.toLocaleLowerCase()}`
              : undefined
          }
          id={subsectionSemanticId ?? undefined}
          tabIndex={subsection ? 0 : undefined}
        >
          <h3>
            {isSubsectionRenaming ? (
              <>
                <i className="selection-caret">›</i>
                <input
                  aria-label="Subsection name"
                  className="pending-budget-name-input"
                  disabled={busyId !== null}
                  maxLength={100}
                  ref={renameNameInputRef}
                  type="text"
                  value={renameName}
                  onChange={(event) => onRenameNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      onRenameSave()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      onRenameCancel()
                    }
                  }}
                />
              </>
            ) : (
              <>
                {isSubsectionSelected ? (
                  <i className="selection-caret">›</i>
                ) : (
                  <span>⌄</span>
                )}
                {name}
              </>
            )}
          </h3>
          <strong>{formatDisplayMoney(planned)}</strong>
        </header>
      )}
      {displayedAllocations.map((allocation, index) =>
        allocation ? (
          <BudgetAllocationRow
            allocation={allocation}
            busyId={busyId}
            editingAllocationId={editingAllocationId}
            focusedSemanticId={focusedSemanticId}
            isPickedUp={
              movingEntry?.entry.kind === 'allocation' &&
              movingEntry.entry.allocation.allocation_id ===
                allocation.allocation_id
            }
            isRenaming={
              renameTarget?.kind === 'allocation' &&
              renameTarget.allocation.allocation_id === allocation.allocation_id
            }
            isSectioned={subsection !== null}
            key={allocation.allocation_id}
            onEdit={onEdit}
            onAmountEditorClosed={onAmountEditorClosed}
            onAmountEditorOpenChange={onAmountEditorOpenChange}
            onRenameCancel={onRenameCancel}
            onRenameNameChange={onRenameNameChange}
            onRenameSave={onRenameSave}
            onUpdate={onUpdate}
            renameName={renameName}
            renameNameInputRef={renameNameInputRef}
          />
        ) : (
          <Fragment key={`pending-allocation-${index}`}>
            {renderPendingAllocation(subsection !== null)}
          </Fragment>
        ),
      )}
    </section>
  )
}

function BudgetAllocationRow({
  allocation,
  busyId,
  editingAllocationId,
  focusedSemanticId,
  isPickedUp,
  isRenaming,
  isSectioned,
  onEdit,
  onAmountEditorClosed,
  onAmountEditorOpenChange,
  onRenameCancel,
  onRenameNameChange,
  onRenameSave,
  onUpdate,
  renameName,
  renameNameInputRef,
}: {
  allocation: BudgetAllocation
  busyId: string | null
  editingAllocationId: string | null
  focusedSemanticId: string | null
  isPickedUp: boolean
  isRenaming: boolean
  isSectioned: boolean
  onEdit: (allocationId: string | null) => void
  onAmountEditorClosed: (allocationId: string) => void
  onAmountEditorOpenChange: (isOpen: boolean) => void
  onRenameCancel: () => void
  onRenameNameChange: (name: string) => void
  onRenameSave: () => void
  onUpdate: (
    allocation: BudgetAllocation,
    magnitude: number,
    direction: BudgetDirection,
  ) => Promise<boolean>
  renameName: string
  renameNameInputRef: RefObject<HTMLInputElement | null>
}) {
  const plannedAmount = Math.abs(allocation.budgeted_amount)
  const isBusy = busyId !== null
  const activityAmount =
    allocation.direction === 'spending'
      ? -allocation.actual_amount
      : allocation.actual_amount
  const remaining = plannedAmount - activityAmount
  const isOverPlan = activityAmount > plannedAmount
  const isIncomeOverPlan = allocation.direction === 'income' && isOverPlan
  const isSelected =
    focusedSemanticId === `budget-row-${allocation.allocation_id}` ||
    isRenaming

  return (
    <div
      aria-current={isSelected ? 'true' : undefined}
      className={`budget-row${isSectioned ? ' budget-row--sectioned' : ''}${
        isSelected ? ' is-selected' : ''
      }${
        isPickedUp ? ' is-picked-up' : ''
      }${
        isOverPlan ? ` budget-row--over-${allocation.direction}` : ''
      }`}
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
        {isRenaming ? (
          <input
            aria-label="Budget line item name"
            className="pending-budget-name-input"
            disabled={isBusy}
            maxLength={100}
            ref={renameNameInputRef}
            type="text"
            value={renameName}
            onChange={(event) => onRenameNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onRenameSave()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onRenameCancel()
              }
            }}
          />
        ) : (
          allocation.category_name
        )}
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
      <span className="activity-cell">{formatDisplayMoney(activityAmount)}</span>
      <span className="remaining-cell">
        {isIncomeOverPlan
          ? `+${formatDisplayMoney(Math.abs(remaining))}`
          : formatDisplayMoney(remaining)}
      </span>
    </div>
  )
}

function PendingBudgetAllocation({
  busy,
  categories,
  excludedCategoryIds,
  isSectioned,
  nameInputRef,
  onCancel,
  onCreate,
  onQueryChange,
  onSelect,
}: {
  busy: boolean
  categories: Category[]
  excludedCategoryIds: string[]
  isSectioned: boolean
  nameInputRef: RefObject<HTMLInputElement | null>
  onCancel: () => void
  onCreate: (name: string) => Promise<Category>
  onQueryChange: (name: string) => void
  onSelect: (category: Category) => Promise<void>
}) {
  return (
    <div
      className={`budget-row is-selected pending-budget-entry${
        isSectioned ? ' budget-row--sectioned' : ''
      }`}
    >
      <span className="category-name">
        <i className="selection-caret">›</i>
        <CategoryCombobox
          autoFocus
          categories={categories}
          className="pending-budget-category-combobox"
          disabled={busy}
          excludedCategoryIds={excludedCategoryIds}
          inputRef={nameInputRef}
          label="Search or create category"
          placeholder="Search or create category"
          onCancel={onCancel}
          onCreate={onCreate}
          onQueryChange={onQueryChange}
          onSelect={onSelect}
        />
      </span>
      <span className="amount-cell">$0</span>
      <span className="activity-cell">$0</span>
      <span className="remaining-cell">$0</span>
    </div>
  )
}

function PendingSubsection({
  busy,
  name,
  nameInputRef,
  onCancel,
  onNameChange,
  onSave,
}: {
  busy: boolean
  name: string
  nameInputRef: RefObject<HTMLInputElement | null>
  onCancel: () => void
  onNameChange: (name: string) => void
  onSave: () => void
}) {
  return (
    <section className="budget-group pending-budget-subsection">
      <header className="budget-subsection-head is-selected">
        <h3>
          <i className="selection-caret">›</i>
          <input
            aria-label="New subsection name"
            className="pending-budget-name-input"
            disabled={busy}
            maxLength={100}
            placeholder="Name this subsection"
            ref={nameInputRef}
            type="text"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onSave()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onCancel()
              }
            }}
          />
        </h3>
        <strong>$0</strong>
      </header>
    </section>
  )
}

function BudgetActionDialog({
  allocationCount,
  deleteChoice,
  deleteNoButtonRef,
  deleteYesButtonRef,
  entry,
  onCancel,
  onChoose,
  onConfirm,
}: {
  allocationCount: number
  deleteChoice: 'yes' | 'no'
  deleteNoButtonRef: RefObject<HTMLButtonElement | null>
  deleteYesButtonRef: RefObject<HTMLButtonElement | null>
  entry: BudgetEntry
  onCancel: () => void
  onChoose: (choice: 'yes' | 'no') => void
  onConfirm: (choice?: 'yes' | 'no') => void
}) {
  const name =
    entry.kind === 'allocation'
      ? entry.allocation.category_name
      : entry.subsection.name
  const deletingSubsection = entry.kind === 'subsection'

  return (
    <div className="budget-action-layer">
      <section
        aria-describedby="budget-delete-description"
        aria-labelledby="budget-delete-title"
        aria-modal="true"
        className="budget-action-dialog"
        role="dialog"
        onKeyDown={trapDialogFocus}
      >
        <p className="eyebrow">
          Delete {deletingSubsection ? 'subsection' : 'budget line item'}
        </p>
        <h2 id="budget-delete-title">Delete {name}?</h2>
        <p id="budget-delete-description">
          {deletingSubsection
            ? `Its ${allocationCount} budget line item${
                allocationCount === 1 ? '' : 's'
              } will also be deleted.`
            : 'This removes it from this budget.'}
        </p>
        <div className="budget-action-choices">
          <button
            className={`budget-action-choice budget-action-choice--danger${
              deleteChoice === 'yes' ? ' is-selected' : ''
            }`}
            ref={deleteYesButtonRef}
            type="button"
            onClick={() => {
              onChoose('yes')
              onConfirm('yes')
            }}
          >
            Yes, delete
          </button>
          <button
            className={`budget-action-choice${
              deleteChoice === 'no' ? ' is-selected' : ''
            }`}
            ref={deleteNoButtonRef}
            type="button"
            onClick={onCancel}
          >
            No, keep it
          </button>
        </div>
      </section>
    </div>
  )
}

function CreateBudgetEntryDialog({
  allocationButtonRef,
  creationKind,
  entry,
  subsectionButtonRef,
  onChoose,
  onConfirm,
}: {
  allocationButtonRef: RefObject<HTMLButtonElement | null>
  creationKind: 'allocation' | 'subsection'
  entry: BudgetEntry
  subsectionButtonRef: RefObject<HTMLButtonElement | null>
  onChoose: (kind: 'allocation' | 'subsection') => void
  onConfirm: (kind?: 'allocation' | 'subsection') => void
}) {
  const name =
    entry.kind === 'allocation'
      ? entry.allocation.category_name
      : entry.subsection.name

  return (
    <div className="budget-action-layer">
      <section
        aria-labelledby="budget-create-title"
        aria-modal="true"
        className="budget-action-dialog"
        role="dialog"
        onKeyDown={trapDialogFocus}
      >
        <p className="eyebrow">Create below {name}</p>
        <h2 id="budget-create-title">What would you like to create?</h2>
        <div className="budget-action-choices">
          <button
            className={`budget-action-choice${
              creationKind === 'allocation' ? ' is-selected' : ''
            }`}
            ref={allocationButtonRef}
            type="button"
            onClick={() => {
              onChoose('allocation')
              onConfirm('allocation')
            }}
          >
            Budget line item
          </button>
          <button
            className={`budget-action-choice${
              creationKind === 'subsection' ? ' is-selected' : ''
            }`}
            ref={subsectionButtonRef}
            type="button"
            onClick={() => {
              onChoose('subsection')
              onConfirm('subsection')
            }}
          >
            Subsection
          </button>
        </div>
      </section>
    </div>
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
        aria-label={`${allocation.category_name} planned amount`}
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
