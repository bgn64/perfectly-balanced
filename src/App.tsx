import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { useAuth } from './auth/useAuth.ts'
import {
  BudgetPanel,
  type BudgetKeyboardAction,
  type BudgetKeyboardInteraction,
} from './budgets/BudgetPanel.tsx'
import { getClientConfiguration } from './config.ts'
import {
  currentMonth,
  formatMonth,
  isTextEntryTarget,
  shiftMonth,
} from './finance/utils.ts'
import { InsightsPanel } from './insights/InsightsPanel.tsx'
import { getSupabaseClient } from './lib/supabase.ts'
import { TransactionsPanel } from './transactions/TransactionsPanel.tsx'
import './App.css'
import '../mockup/neovim-tokyonight.css'

interface AppProps {
  appName: string
}

type AppView = 'budgets' | 'transactions' | 'insights'
type SemanticRegion = 'sidebar' | 'workspace'
type WorkspaceTheme = 'dark' | 'light'

interface StatusContext {
  action: string
  label: string
}

interface AmountEditRequest {
  allocationId: string
  sequence: number
}

const navigationItems: ReadonlyArray<{
  view: AppView
  label: string
}> = [
  { view: 'budgets', label: 'Budget' },
  { view: 'transactions', label: 'Transactions' },
  { view: 'insights', label: 'Reports' },
]

const themePreferenceKey = 'perfectly-balanced.theme'

function readInitialTheme(): WorkspaceTheme {
  const savedTheme = window.localStorage.getItem(themePreferenceKey)
  if (savedTheme === 'dark' || savedTheme === 'light') {
    return savedTheme
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
}

function getSemanticControls(
  root: HTMLElement,
  region: SemanticRegion,
): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      `[data-semantic-region="${region}"]`,
    ),
  )
    .filter(
      (control) =>
        !control.matches(':disabled') &&
        control.getAttribute('aria-hidden') !== 'true' &&
        control.closest('[aria-hidden="true"], [hidden]') === null &&
        control.getClientRects().length > 0,
    )
}

function getStatusContext(control: HTMLElement | null): StatusContext {
  return {
    action: control?.dataset.statusAction ?? 'activate',
    label: control?.dataset.statusLabel ?? 'budget',
  }
}

function App({ appName }: AppProps) {
  const { isLoading, initializationError, session, user } = useAuth()

  if (isLoading) {
    return <LoadingScreen appName={appName} />
  }

  if (initializationError) {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="auth-error-title">
          <p className="eyebrow">{appName}</p>
          <h1 id="auth-error-title">We could not verify your session</h1>
          <p className="auth-card__copy">{initializationError}</p>
          <p className="auth-card__hint">Refresh the page to try again.</p>
        </section>
      </main>
    )
  }

  if (!session || !user) {
    return <SignInScreen appName={appName} />
  }

  return (
    <AuthenticatedShell
      appName={appName}
      email={user.email ?? ''}
    />
  )
}

function LoadingScreen({ appName }: AppProps) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-live="polite">
        <p className="eyebrow">{appName}</p>
        <h1>Checking your session</h1>
        <p className="auth-card__copy">One moment while we securely sign you in.</p>
      </section>
    </main>
  )
}

function SignInScreen({ appName }: AppProps) {
  const [email, setEmail] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const normalizedEmail = email.trim()
    if (!normalizedEmail) {
      setErrorMessage('Enter your email address to receive a sign-in link.')
      return
    }

    setIsSubmitting(true)
    setErrorMessage(null)
    setSuccessMessage(null)

    const { error } = await getSupabaseClient().auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo: getClientConfiguration().siteUrl,
        shouldCreateUser: false,
      },
    })

    setIsSubmitting(false)

    if (error) {
      setErrorMessage(error.message)
      return
    }

    setSuccessMessage(`We sent a secure sign-in link to ${normalizedEmail}.`)
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <p className="eyebrow">{appName}</p>
        <h1 id="sign-in-title">Sign in with email</h1>
        <p className="auth-card__copy">
          Enter the email address associated with your invitation. We will send
          you a one-time sign-in link.
        </p>
        <form className="sign-in-form" onSubmit={handleSubmit}>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={isSubmitting}
            required
          />
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Sending sign-in link...' : 'Email me a sign-in link'}
          </button>
        </form>
        {errorMessage && (
          <p className="form-message form-message--error" role="alert">
            {errorMessage}
          </p>
        )}
        {successMessage && (
          <p className="form-message form-message--success" aria-live="polite">
            {successMessage}
          </p>
        )}
      </section>
    </main>
  )
}

function AuthenticatedShell({
  appName,
  email,
}: {
  appName: string
  email: string
}) {
  const { signOut } = useAuth()
  const [activeView, setActiveView] = useState<AppView>('budgets')
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [categoriesRevision, setCategoriesRevision] = useState(0)
  const [budgetActivityRevision, setBudgetActivityRevision] = useState(0)
  const [commandQuery, setCommandQuery] = useState('go')
  const [theme, setTheme] = useState<WorkspaceTheme>(readInitialTheme)
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [isAmountEditorOpen, setIsAmountEditorOpen] = useState(false)
  const [amountEditRequest, setAmountEditRequest] =
    useState<AmountEditRequest | null>(null)
  const [budgetKeyboardAction, setBudgetKeyboardAction] =
    useState<BudgetKeyboardAction | null>(null)
  const [budgetKeyboardInteraction, setBudgetKeyboardInteraction] =
    useState<BudgetKeyboardInteraction | null>(null)
  const [focusedSemanticId, setFocusedSemanticId] = useState<string | null>(
    'nav-budgets',
  )
  const [focusedWorkspaceControl, setFocusedWorkspaceControl] = useState(1)
  const [workspaceControlCount, setWorkspaceControlCount] = useState(18)
  const [statusContext, setStatusContext] = useState<StatusContext>({
    action: 'select',
    label: 'budget / navigation',
  })
  const workspaceShellRef = useRef<HTMLDivElement>(null)
  const commandInputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const handleTransactionsChanged = useCallback(() => {
    setBudgetActivityRevision((revision) => revision + 1)
  }, [])
  const handleCategoriesChanged = useCallback(() => {
    setCategoriesRevision((revision) => revision + 1)
  }, [])
  const initials = email
    .split('@')[0]
    .split(/[._-]/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  const adjacentMonths = [
    shiftMonth(selectedMonth, -1),
    selectedMonth,
    shiftMonth(selectedMonth, 1),
  ]

  const navigateToView = useCallback((view: AppView) => {
    setActiveView(view)
  }, [])
  const focusWorkspaceControl = useCallback((control: HTMLElement) => {
    control.focus({ preventScroll: true })
    control.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [])
  const focusBudgetRow = useCallback(
    (allocationId: string) => {
      window.requestAnimationFrame(() => {
        document.getElementById(`budget-row-${allocationId}`)?.focus()
      })
    },
    [],
  )
  const requestBudgetKeyboardAction = useCallback(
    (
      action: BudgetKeyboardAction['action'],
      semanticId: string | null,
    ) => {
      setBudgetKeyboardAction((current) => ({
        action,
        semanticId,
        sequence: (current?.sequence ?? 0) + 1,
      }))
    },
    [],
  )
  const closeCommandPalette = useCallback(() => {
    setIsCommandPaletteOpen(false)
    const previousFocus = previousFocusRef.current
    window.requestAnimationFrame(() => {
      if (previousFocus?.isConnected) {
        focusWorkspaceControl(previousFocus)
        return
      }
      const firstControl = workspaceShellRef.current
        ? getSemanticControls(workspaceShellRef.current, 'sidebar').find(
            (control) => control.matches('.nav-item.is-active'),
          )
        : null
      if (firstControl) {
        focusWorkspaceControl(firstControl)
      }
    })
  }, [focusWorkspaceControl])
  const openCommandPalette = useCallback(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setCommandQuery('go')
    setIsCommandPaletteOpen(true)
    window.requestAnimationFrame(() => commandInputRef.current?.focus())
  }, [])

  useEffect(() => {
    window.localStorage.setItem(themePreferenceKey, theme)
  }, [theme])

  useEffect(() => {
    if (activeView !== 'budgets') {
      return
    }
    const root = workspaceShellRef.current
    if (!root) {
      return
    }
    let animationFrame = 0
    const updateFocusStatus = () => {
      const controls = [
        ...getSemanticControls(root, 'sidebar'),
        ...getSemanticControls(root, 'workspace'),
      ]
      const activeElement = document.activeElement
      const activeControl =
        activeElement instanceof HTMLElement
          ? activeElement.closest<HTMLElement>('[data-status-label]')
          : null
      const activeSemanticNode =
        activeElement instanceof HTMLElement
          ? activeElement.closest<HTMLElement>('[data-semantic-id]')
          : null
      setWorkspaceControlCount(controls.length)
      setFocusedWorkspaceControl(
        activeControl && controls.includes(activeControl)
          ? controls.indexOf(activeControl) + 1
          : 1,
      )
      setFocusedSemanticId(activeSemanticNode?.dataset.semanticId ?? null)
      setStatusContext(getStatusContext(activeControl))
    }
    const scheduleFocusStatusUpdate = () => {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(updateFocusStatus)
    }
    const observer = new MutationObserver(scheduleFocusStatusUpdate)
    root.addEventListener('focusin', scheduleFocusStatusUpdate)
    observer.observe(root, {
      attributeFilter: ['aria-hidden', 'disabled', 'hidden'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    scheduleFocusStatusUpdate()

    return () => {
      window.cancelAnimationFrame(animationFrame)
      root.removeEventListener('focusin', scheduleFocusStatusUpdate)
      observer.disconnect()
    }
  }, [activeView])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTextEntryTarget(event.target)
      ) {
        return
      }
      const key = event.key.toLocaleLowerCase()
      if (budgetKeyboardInteraction) {
        const action =
          budgetKeyboardInteraction.mode === 'saving-move'
            ? null
            : event.key === 'Escape'
            ? 'cancel'
            : (key === 'j' || key === 'k') &&
                budgetKeyboardInteraction.mode !== 'name-entry'
              ? key === 'j'
                ? 'next'
                : 'previous'
              : event.key === 'Enter' &&
                  budgetKeyboardInteraction.mode !== 'moving'
                ? 'confirm'
                : key === 'p' && budgetKeyboardInteraction.mode === 'moving'
                  ? 'confirm'
                  : null
        if (action) {
          event.preventDefault()
          requestBudgetKeyboardAction(action, focusedSemanticId)
        }
        return
      }
      if (event.key === ':' && !isAmountEditorOpen) {
        event.preventDefault()
        openCommandPalette()
        return
      }
      if (event.shiftKey || isAmountEditorOpen) {
        return
      }
      const root = workspaceShellRef.current
      if (!root) {
        return
      }
      const sidebarControls = getSemanticControls(root, 'sidebar')
      const workspaceControls = getSemanticControls(root, 'workspace')
      const activeElement = document.activeElement
      const focusedControl =
        activeElement instanceof HTMLElement
          ? activeElement.closest<HTMLElement>('[data-semantic-region]')
          : null

      if (!focusedControl) {
        const firstControl = sidebarControls.find((control) =>
          control.matches('.nav-item.is-active'),
        )
        if (firstControl) {
          event.preventDefault()
          focusWorkspaceControl(firstControl)
        }
        return
      }

      if (
        key === 'a' &&
        focusedControl?.dataset.semanticKind === 'budget-row'
      ) {
        const allocationId = focusedControl.dataset.allocationId
        if (!allocationId) {
          return
        }
        event.preventDefault()
        setAmountEditRequest((current) => ({
          allocationId,
          sequence: (current?.sequence ?? 0) + 1,
        }))
        setIsAmountEditorOpen(true)
        return
      }

      if (
        key === 't' &&
        focusedControl?.dataset.semanticKind === 'budget-row'
      ) {
        const allocationId = focusedControl.dataset.allocationId
        const directionToggle = allocationId
          ? document.getElementById(`direction-toggle-${allocationId}`)
          : null
        if (
          !(directionToggle instanceof HTMLButtonElement) ||
          directionToggle.disabled
        ) {
          return
        }
        event.preventDefault()
        directionToggle.click()
        return
      }

      if (
        (key === 'd' || key === 'n' || key === 'r' || key === 'x') &&
        (focusedControl?.dataset.semanticKind === 'budget-row' ||
          focusedControl?.dataset.semanticKind === 'budget-subsection')
      ) {
        event.preventDefault()
        requestBudgetKeyboardAction(
          key === 'd'
            ? 'start-delete'
            : key === 'n'
              ? 'start-create'
              : key === 'r'
                ? 'start-rename'
                : 'start-move',
          focusedControl.dataset.semanticId ?? null,
        )
        return
      }

      const region = focusedControl?.dataset.semanticRegion
      const controls =
        region === 'sidebar'
          ? sidebarControls
          : region === 'workspace'
            ? workspaceControls
            : []
      const index = focusedControl ? controls.indexOf(focusedControl) : -1
      let nextControl: HTMLElement | null = null

      if (key === 'j' || key === 'k') {
        const nextIndex = index + (key === 'j' ? 1 : -1)
        nextControl = controls[nextIndex] ?? null
      } else if (key === 'h') {
        if (region === 'workspace') {
          nextControl =
            focusedControl?.dataset.semanticId === 'month-next'
              ? workspaceControls.find(
                  (control) =>
                    control.dataset.semanticId === 'month-previous',
                ) ?? null
              : sidebarControls.find((control) =>
                  control.matches('.nav-item.is-active'),
                ) ?? null
        }
      } else if (key === 'l') {
        if (region === 'sidebar') {
          nextControl =
            workspaceControls.find(
              (control) =>
                control.dataset.semanticId === 'month-previous',
            ) ?? null
        } else if (focusedControl?.dataset.semanticId === 'month-previous') {
          nextControl =
            workspaceControls.find(
              (control) => control.dataset.semanticId === 'month-next',
            ) ?? null
        }
      } else if (index === -1) {
        nextControl =
          sidebarControls.find((control) =>
            control.matches('.nav-item.is-active'),
          ) ?? null
      } else {
        return
      }

      if (nextControl) {
        event.preventDefault()
        focusWorkspaceControl(nextControl)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    focusBudgetRow,
    focusWorkspaceControl,
    focusedSemanticId,
    isAmountEditorOpen,
    budgetKeyboardInteraction,
    openCommandPalette,
    requestBudgetKeyboardAction,
  ])

  async function handleSignOut() {
    setIsSigningOut(true)
    setSignOutError(null)
    try {
      await signOut()
    } catch (error) {
      setSignOutError(
        error instanceof Error
          ? error.message
          : 'We could not sign you out. Please try again.',
      )
      setIsSigningOut(false)
    }
  }

  if (activeView === 'budgets') {
    return (
      <div
        className={`authenticated-app terminal-app${
          isCommandPaletteOpen ? '' : ' command-closed'
        } theme-${theme}`}
        ref={workspaceShellRef}
      >
        <header className="titlebar">
          <button
            className="brand"
            type="button"
            onClick={() => navigateToView('budgets')}
          >
            <span className="brand-mark" aria-hidden="true">pb</span>
            <span>{appName.toLocaleLowerCase().replace(/\s+/g, '-')}</span>
          </button>
          <p>{formatMonth(selectedMonth)} · Personal budget</p>
          <div className="theme-switcher" role="group" aria-label="Theme">
            <input
              checked={theme === 'dark'}
              id="theme-dark"
              name="theme"
              type="radio"
              onChange={() => setTheme('dark')}
            />
            <label htmlFor="theme-dark">Dark</label>
            <input
              checked={theme === 'light'}
              id="theme-light"
              name="theme"
              type="radio"
              onChange={() => setTheme('light')}
            />
            <label htmlFor="theme-light">Light</label>
          </div>
          <details className="profile">
            <summary>
              <span>{initials || 'PB'}</span>
              {email.split('@')[0]}
            </summary>
            <div className="account-popover">
              <strong>{email}</strong>
              <button
                className="button button--secondary"
                disabled={isSigningOut}
                type="button"
                onClick={() => void handleSignOut()}
              >
                {isSigningOut ? 'Signing out...' : 'Sign out'}
              </button>
            </div>
          </details>
        </header>

        <aside className="sidebar" aria-label="Application navigation">
          <nav className="main-nav">
            {navigationItems.map((item) => (
              <button
                aria-current={activeView === item.view ? 'page' : undefined}
                className={`nav-item${
                  activeView === item.view ? ' is-active' : ''
                }${
                  focusedSemanticId === `nav-${item.view}` ? ' is-focused' : ''
                }`}
                data-semantic-id={`nav-${item.view}`}
                data-semantic-region="sidebar"
                data-status-action="select"
                data-status-label={`budget / ${item.label.toLocaleLowerCase()}`}
                key={item.view}
                type="button"
                onClick={() => navigateToView(item.view)}
              >
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <section className="sidebar-section" aria-labelledby="months-title">
            <h2 id="months-title">Months</h2>
            {adjacentMonths.map((month) => (
              <button
                className={month === selectedMonth ? 'is-current' : ''}
                data-semantic-id={`sidebar-month-${month}`}
                data-semantic-region="sidebar"
                data-status-action="select month"
                data-status-label={`budget / ${formatMonth(month)}`}
                key={month}
                type="button"
                onClick={() => setSelectedMonth(month)}
              >
                {formatMonth(month)}
              </button>
            ))}
          </section>
        </aside>

        <main className="workspace">
          {signOutError && (
            <p className="form-message form-message--error" role="alert">
              {signOutError}
            </p>
          )}
          <BudgetPanel
            activityRevision={budgetActivityRevision}
            amountEditRequest={amountEditRequest}
            keyboardActionRequest={budgetKeyboardAction}
            categoriesRevision={categoriesRevision}
            focusedSemanticId={focusedSemanticId}
            selectedMonth={selectedMonth}
            onCategoriesChanged={handleCategoriesChanged}
            onKeyboardInteractionChange={setBudgetKeyboardInteraction}
            onAmountEditorClosed={(allocationId) => {
              setIsAmountEditorOpen(false)
              setAmountEditRequest(null)
              focusBudgetRow(allocationId)
            }}
            onAmountEditorOpenChange={setIsAmountEditorOpen}
            onMonthChange={setSelectedMonth}
          />
        </main>

        {isCommandPaletteOpen && (
          <aside className="command-panel" aria-label="Command">
            <div className="command-panel__head">
              <h2>Command</h2>
            </div>
            <label className="command-input">
              <span aria-hidden="true">:</span>
              <input
                ref={commandInputRef}
                aria-label="Command"
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    closeCommandPalette()
                  }
                }}
              />
            </label>
            <ul className="command-list">
              <li className="is-highlighted">
                <button
                  data-status-action="open"
                  data-status-label="command / transactions"
                  type="button"
                  onClick={() => navigateToView('transactions')}
                >
                  Go to transactions
                </button>
              </li>
              <li>
                <button
                  data-status-action="open"
                  data-status-label="command / reports"
                  type="button"
                  onClick={() => navigateToView('insights')}
                >
                  Go to reports
                </button>
              </li>
              <li>
                <button
                  data-status-action="focus"
                  data-status-label="command / category"
                  type="button"
                  onClick={() => {
                    closeCommandPalette()
                    window.requestAnimationFrame(() =>
                      document.getElementById('add-category')?.focus(),
                    )
                  }}
                >
                  Go to category
                </button>
              </li>
            </ul>
          </aside>
        )}

        <footer className="statusline">
          {budgetKeyboardInteraction ? (
            <>
              <div>
                <strong>
                  {budgetKeyboardInteraction.mode === 'confirm-delete'
                    ? 'CONFIRM'
                    : budgetKeyboardInteraction.mode === 'choose-create'
                      ? 'CREATE'
                      : budgetKeyboardInteraction.mode === 'name-entry'
                        ? 'NAME'
                          : budgetKeyboardInteraction.mode === 'rename-entry'
                            ? 'RENAME'
                            : budgetKeyboardInteraction.mode === 'saving-move'
                              ? 'SAVING'
                          : 'MOVE'}
                </strong>
                <span>{budgetKeyboardInteraction.label}</span>
              </div>
              <div>
                {(budgetKeyboardInteraction.mode === 'confirm-delete' ||
                  budgetKeyboardInteraction.mode === 'choose-create') && (
                  <>
                    <span><kbd>j</kbd><kbd>k</kbd> choose</span>
                    <span><kbd>Enter</kbd> confirm</span>
                  </>
                )}
                {(budgetKeyboardInteraction.mode === 'name-entry' ||
                  budgetKeyboardInteraction.mode === 'rename-entry') && (
                  <span><kbd>Enter</kbd> save</span>
                )}
                {budgetKeyboardInteraction.mode === 'moving' && (
                  <>
                    <span><kbd>j</kbd><kbd>k</kbd> position</span>
                    <span><kbd>p</kbd> place</span>
                  </>
                )}
                {budgetKeyboardInteraction.mode === 'saving-move' && (
                  <span>Saving placement...</span>
                )}
                {budgetKeyboardInteraction.mode !== 'saving-move' && (
                  <span><kbd>Esc</kbd> cancel</span>
                )}
              </div>
            </>
          ) : (
            <>
              <div>
                <strong>NAVIGATE</strong>
                <span>{statusContext.label}</span>
                <span>focus {focusedWorkspaceControl} of {workspaceControlCount}</span>
              </div>
              <div>
                {statusContext.action !== 'amount' &&
                  statusContext.action !== 'subsection' && (
                    <span><kbd>Enter</kbd> {statusContext.action}</span>
                  )}
                {statusContext.action === 'amount' && (
                  <>
                    <span><kbd>a</kbd> amount</span>
                    <span><kbd>t</kbd> direction</span>
                  </>
                )}
                {(statusContext.action === 'amount' ||
                  statusContext.action === 'subsection') && (
                  <>
                    <span><kbd>n</kbd> new</span>
                    <span><kbd>r</kbd> rename</span>
                    <span><kbd>d</kbd> delete</span>
                    <span><kbd>x</kbd> move</span>
                  </>
                )}
                <span><kbd>h</kbd><kbd>j</kbd><kbd>k</kbd><kbd>l</kbd> focus</span>
                <span><kbd>:</kbd> command</span>
              </div>
            </>
          )}
        </footer>
      </div>
    )
  }

  return (
    <div className="authenticated-app">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => navigateToView('budgets')}>
          <span className="brand-mark" aria-hidden="true">P</span>
          {appName}
        </button>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navigationItems.map(({ view, label }) => (
            <button
              aria-current={activeView === view ? 'page' : undefined}
              className={activeView === view ? 'active' : ''}
              key={view}
              type="button"
              onClick={() => navigateToView(view)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      {activeView === 'transactions' && (
        <TransactionsPanel
          categoriesRevision={categoriesRevision}
          onCategoriesChanged={handleCategoriesChanged}
          onTransactionsChanged={handleTransactionsChanged}
        />
      )}
      {activeView === 'insights' && (
        <InsightsPanel
          activityRevision={budgetActivityRevision}
          categoriesRevision={categoriesRevision}
        />
      )}
    </div>
  )
}

export default App
