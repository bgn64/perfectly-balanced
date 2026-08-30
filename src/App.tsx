import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { useAuth } from './auth/useAuth.ts'
import { BudgetPanel } from './budgets/BudgetPanel.tsx'
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
type FocusDirection = 'left' | 'down' | 'up' | 'right'

const navigationItems: ReadonlyArray<{
  view: AppView
  label: string
}> = [
  { view: 'budgets', label: 'Budget' },
  { view: 'transactions', label: 'Transactions' },
  { view: 'insights', label: 'Reports' },
]

const workspaceControlSelector = [
  'button:not([disabled])',
  'summary',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[role="combobox"]',
].join(', ')

function getWorkspaceControls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(workspaceControlSelector))
    .filter(
      (control) =>
        !control.matches(':disabled') &&
        control.getAttribute('aria-hidden') !== 'true' &&
        control.closest('[aria-hidden="true"], [hidden]') === null &&
        control.getClientRects().length > 0,
    )
}

function isInDirection(
  origin: DOMRect,
  candidate: DOMRect,
  direction: FocusDirection,
): boolean {
  const originX = origin.left + origin.width / 2
  const originY = origin.top + origin.height / 2
  const candidateX = candidate.left + candidate.width / 2
  const candidateY = candidate.top + candidate.height / 2

  switch (direction) {
    case 'left':
      return candidateX < originX
    case 'down':
      return candidateY > originY
    case 'up':
      return candidateY < originY
    case 'right':
      return candidateX > originX
  }
}

function findDirectionalControl(
  controls: HTMLElement[],
  origin: HTMLElement,
  direction: FocusDirection,
): HTMLElement | null {
  const originRect = origin.getBoundingClientRect()
  const isVertical = direction === 'up' || direction === 'down'
  const originAxis =
    (isVertical ? originRect.top : originRect.left) +
    (isVertical ? originRect.height : originRect.width) / 2
  const originCrossAxis =
    (isVertical ? originRect.left : originRect.top) +
    (isVertical ? originRect.width : originRect.height) / 2

  const directionalControls = controls
    .filter((control) => control !== origin)
    .map((control) => {
      const rect = control.getBoundingClientRect()
      const axis =
        (isVertical ? rect.top : rect.left) +
        (isVertical ? rect.height : rect.width) / 2
      const crossAxis =
        (isVertical ? rect.left : rect.top) +
        (isVertical ? rect.width : rect.height) / 2
      return {
        control,
        crossDistance: Math.abs(crossAxis - originCrossAxis),
        primaryDistance: Math.abs(axis - originAxis),
        rect,
      }
    })
    .filter(({ rect }) => isInDirection(originRect, rect, direction))
  const alignedControls = directionalControls.filter(
    ({ crossDistance, primaryDistance }) => crossDistance <= primaryDistance,
  )

  return (alignedControls.length > 0 ? alignedControls : directionalControls)
    .sort(
      (left, right) =>
        left.crossDistance - right.crossDistance ||
        left.primaryDistance - right.primaryDistance,
    )[0]?.control ?? null
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
  const [focusedWorkspaceControl, setFocusedWorkspaceControl] = useState(1)
  const [workspaceControlCount, setWorkspaceControlCount] = useState(18)
  const workspaceShellRef = useRef<HTMLDivElement>(null)
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
      const controls = getWorkspaceControls(root)
      const activeElement = document.activeElement
      const activeControl =
        activeElement instanceof HTMLElement
          ? activeElement.closest<HTMLElement>(workspaceControlSelector)
          : null
      setWorkspaceControlCount(controls.length)
      setFocusedWorkspaceControl(
        activeControl && controls.includes(activeControl)
          ? controls.indexOf(activeControl) + 1
          : 1,
      )
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
        event.shiftKey ||
        isTextEntryTarget(event.target)
      ) {
        return
      }
      const root = workspaceShellRef.current
      if (!root) {
        return
      }
      const directionByKey: Record<string, FocusDirection> = {
        h: 'left',
        j: 'down',
        k: 'up',
        l: 'right',
      }
      const direction = directionByKey[event.key.toLocaleLowerCase()]
      if (!direction) {
        return
      }
      const controls = getWorkspaceControls(root)
      const activeElement = document.activeElement
      const activeControl =
        activeElement instanceof HTMLElement
          ? activeElement.closest<HTMLElement>(workspaceControlSelector)
          : null
      const focusedControl =
        activeControl && controls.includes(activeControl) ? activeControl : null
      const nextControl = focusedControl
        ? findDirectionalControl(controls, focusedControl, direction)
        : controls.find((control) =>
            control.matches('.nav-item.is-active'),
          ) ?? controls[0]
      if (nextControl) {
        event.preventDefault()
        focusWorkspaceControl(nextControl)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [focusWorkspaceControl])

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
      <div className="authenticated-app terminal-app" ref={workspaceShellRef}>
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
                  activeView === item.view ? ' is-active is-focused' : ''
                }`}
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
                key={month}
                type="button"
                onClick={() => setSelectedMonth(month)}
              >
                {formatMonth(month)}
              </button>
            ))}
          </section>
          <section className="sidebar-section keyboard-guide" aria-labelledby="keymap-title">
            <h2 id="keymap-title">Keymap</h2>
            <dl>
              <div><dt><kbd>h</kbd><kbd>j</kbd><kbd>k</kbd><kbd>l</kbd></dt><dd>move focus</dd></div>
              <div><dt><kbd>Enter</kbd></dt><dd>activate control</dd></div>
            </dl>
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
            categoriesRevision={categoriesRevision}
            selectedMonth={selectedMonth}
            onCategoriesChanged={handleCategoriesChanged}
            onMonthChange={setSelectedMonth}
          />
        </main>

        <aside className="command-panel" aria-label="Command">
          <div className="command-panel__head">
            <h2>Command</h2>
          </div>
          <label className="command-input">
            <span aria-hidden="true">:</span>
            <input
              aria-label="Command"
              value={commandQuery}
              onChange={(event) => setCommandQuery(event.target.value)}
            />
          </label>
          <ul className="command-list">
            <li className="is-highlighted">
              <button type="button" onClick={() => navigateToView('transactions')}>
                Go to transactions
              </button>
            </li>
            <li>
              <button type="button" onClick={() => navigateToView('insights')}>
                Go to reports
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() =>
                  document.getElementById('add-category')?.focus()
                }
              >
                Go to category
              </button>
            </li>
          </ul>
        </aside>

        <footer className="statusline">
          <div>
            <strong>NAVIGATE</strong>
            <span>budget</span>
            <span>focus {focusedWorkspaceControl} of {workspaceControlCount}</span>
          </div>
          <div><span><kbd>h</kbd><kbd>j</kbd><kbd>k</kbd><kbd>l</kbd> move</span><span><kbd>Enter</kbd> activate</span></div>
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
