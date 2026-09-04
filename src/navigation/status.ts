export interface StatusShortcut {
  keys: string[]
  label: string
}

export interface StatusPresentation {
  mode: string
  label: string
  shortcuts: StatusShortcut[]
}

export interface NavigationStatusInput {
  view: 'budgets' | 'transactions' | 'insights' | 'settings'
  action: string
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