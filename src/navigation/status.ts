export interface StatusShortcut {
  keys: string[]
  label: string
}

export interface StatusPresentation {
  mode: string
  label: string
  shortcuts: StatusShortcut[]
}

export type TransactionDetailInteractionMode =
  | 'detail'
  | 'split'
  | 'amount'
  | 'category'
  | 'date'
  | 'saving'

export interface TransactionDetailInteraction {
  hasUnsavedChanges: boolean
  mode: TransactionDetailInteractionMode
  label: string
}

export interface NavigationStatusInput {
  view: 'budgets' | 'transactions' | 'insights' | 'settings'
  action: string
  hasRecommendations?: boolean
  label: string
  semanticKind: string | null
  isTextEntry: boolean
}

const focusShortcut: StatusShortcut = {
  keys: ['h', 'j', 'k', 'l'],
  label: 'focus',
}

export function buildNavigationStatus({
  view,
  action,
  hasRecommendations = false,
  label,
  semanticKind,
  isTextEntry,
}: NavigationStatusInput): StatusPresentation {
  if (isTextEntry) {
    return {
      mode: 'INPUT',
      label,
      shortcuts: [],
    }
  }

  const shortcuts: StatusShortcut[] = []
  const isReadOnly = action === 'view'
  const isBudgetRow = semanticKind === 'budget-row'
  const isBudgetSubsection = semanticKind === 'budget-subsection'
  const isBudgetFirstItem = semanticKind === 'budget-first-item'
  const isTransactionRow = semanticKind === 'transaction-row'
  const isFilterToken = semanticKind === 'filter-remove'
  const isAccount = semanticKind === 'settings-account'

  if (view === 'transactions') {
    shortcuts.push({ keys: ['/'], label: 'search' })
  }

  if (isBudgetRow) {
    shortcuts.push(
      { keys: ['a'], label: 'amount' },
      { keys: ['t'], label: 'direction' },
    )
  }

  if (isBudgetRow || isBudgetSubsection) {
    shortcuts.push(
      { keys: ['n'], label: 'new' },
      { keys: ['r'], label: 'rename' },
      { keys: ['d'], label: 'delete' },
      { keys: ['x'], label: 'move' },
    )
  } else if (isBudgetFirstItem) {
    shortcuts.push({ keys: ['n'], label: 'new' })
  } else if (isTransactionRow) {
    shortcuts.push(
      ...(hasRecommendations
        ? [{ keys: ['a'], label: 'apply recommendations' }]
        : []),
      { keys: ['c'], label: 'category' },
      { keys: ['t'], label: 'status' },
    )
  } else if (isFilterToken) {
    shortcuts.push({ keys: ['d'], label: 'remove' })
  }

  if (!isReadOnly && !isBudgetRow && !isBudgetSubsection) {
    shortcuts.push({ keys: ['Enter'], label: action })
  }

  if (isBudgetRow && action !== 'amount') {
    shortcuts.push({ keys: ['Enter'], label: action })
  }

  if (isAccount) {
    shortcuts.push({ keys: ['d'], label: 'disconnect' })
  }

  shortcuts.push(focusShortcut)

  if (view === 'budgets') {
    shortcuts.push({ keys: [':'], label: 'command' })
  }

  return {
    mode:
      view === 'settings'
        ? 'SETTINGS'
        : view === 'transactions'
          ? 'EDIT'
          : view === 'insights'
            ? 'REPORT'
            : 'NAVIGATE',
    label,
    shortcuts,
  }
}

export function textEntryStatus(
  mode: string,
  label: string,
  shortcuts: StatusShortcut[],
): StatusPresentation {
  return { mode, label, shortcuts }
}

export function buildTransactionDetailStatus(
  interaction: TransactionDetailInteraction,
): StatusPresentation {
  if (interaction.mode === 'saving') {
    return {
      mode: 'SAVING',
      label: interaction.label,
      shortcuts: [],
    }
  }
  if (interaction.mode === 'date') {
    return textEntryStatus('DATE', interaction.label, [
      { keys: ['Enter'], label: 'save' },
      { keys: ['Esc'], label: 'cancel' },
    ])
  }
  if (interaction.mode === 'amount') {
    return textEntryStatus('AMOUNT', interaction.label, [
      { keys: ['Enter'], label: 'apply' },
      { keys: ['Esc'], label: 'cancel' },
    ])
  }
  if (interaction.mode === 'category') {
    return textEntryStatus('CATEGORY', interaction.label, [
      { keys: ['Ctrl+N', 'Ctrl+P'], label: 'choose' },
      { keys: ['Enter'], label: 'select' },
      { keys: ['Esc'], label: 'cancel' },
    ])
  }
  return {
    mode: interaction.mode === 'split' ? 'SPLIT' : 'DETAIL',
    label: interaction.label,
    shortcuts: [
      { keys: ['j', 'k'], label: 'split' },
      ...(interaction.mode === 'split'
        ? [
            { keys: ['a'], label: 'amount' },
            { keys: ['c'], label: 'category' },
            { keys: ['d'], label: 'delete' },
          ]
        : []),
      { keys: ['n'], label: 'new split' },
      { keys: ['e'], label: 'date' },
      { keys: ['t'], label: 'status' },
      {
        keys: ['Esc'],
        label: interaction.hasUnsavedChanges ? 'discard changes' : 'close',
      },
    ],
  }
}