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
import { isTextEntryTarget } from './finance/utils.ts'
import { InsightsPanel } from './insights/InsightsPanel.tsx'
import { getSupabaseClient } from './lib/supabase.ts'
import { TransactionsPanel } from './transactions/TransactionsPanel.tsx'
import './App.css'

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
  { view: 'insights', label: 'Insights' },
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
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [categoriesRevision, setCategoriesRevision] = useState(0)
  const [budgetActivityRevision, setBudgetActivityRevision] = useState(0)
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const [focusedWorkspaceControl, setFocusedWorkspaceControl] = useState(0)
  const [workspaceControlCount, setWorkspaceControlCount] = useState(0)
  const commandInputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const workspaceShellRef = useRef<HTMLDivElement>(null)
  const handleTransactionsChanged = useCallback(() => {
    setBudgetActivityRevision((revision) => revision + 1)
  }, [])

  const commandItems = navigationItems.filter(
    (item) => item.view !== activeView,
  )
  const matchingCommands = commandItems.filter((item) =>
    `go to ${item.label}`
      .toLocaleLowerCase()
      .includes(commandQuery.trim().toLocaleLowerCase()),
  )

  const focusWorkspaceControl = useCallback((control: HTMLElement) => {
    control.focus({ preventScroll: true })
    control.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [])

  const focusFirstWorkspaceControl = useCallback(() => {
    const root = workspaceShellRef.current
    if (!root) {
      return
    }
    const controls = getWorkspaceControls(root)
    const control =
      controls.find((candidate) =>
        candidate.matches('.workspace-nav button.active'),
      ) ?? controls[0]
    if (control) {
      focusWorkspaceControl(control)
    }
  }, [focusWorkspaceControl])

  const closeCommandPalette = useCallback(() => {
    setIsCommandPaletteOpen(false)
    setCommandQuery('')
    setActiveCommandIndex(0)
    const previousFocus = previousFocusRef.current
    if (previousFocus?.isConnected) {
      window.requestAnimationFrame(() => previousFocus.focus())
      return
    }
    focusFirstWorkspaceControl()
  }, [focusFirstWorkspaceControl])

  const openCommandPalette = useCallback(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null
    setCommandQuery('go')
    setActiveCommandIndex(0)
    setIsCommandPaletteOpen(true)
    window.requestAnimationFrame(() => commandInputRef.current?.focus())
  }, [])

  const navigateToView = useCallback((view: AppView) => {
    setActiveView(view)
    setIsCommandPaletteOpen(false)
    setCommandQuery('')
    setActiveCommandIndex(0)
  }, [])

  useEffect(() => {
    if (activeView !== 'budgets') {
      return
    }
    const root = workspaceShellRef.current
    if (!root) {
      return
    }
    const workspaceRoot: HTMLElement = root

    let animationFrame = window.requestAnimationFrame(updateFocusStatus)
    const observer = new MutationObserver(scheduleFocusStatusUpdate)

    function updateFocusStatus() {
      const controls = getWorkspaceControls(workspaceRoot)
      const activeElement = document.activeElement
      const activeControl =
        activeElement instanceof HTMLElement
          ? activeElement.closest<HTMLElement>(workspaceControlSelector)
          : null
      setWorkspaceControlCount(controls.length)
      setFocusedWorkspaceControl(
        activeControl && controls.includes(activeControl)
          ? controls.indexOf(activeControl) + 1
          : 0,
      )
    }

    function scheduleFocusStatusUpdate() {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(updateFocusStatus)
    }

    workspaceRoot.addEventListener('focusin', scheduleFocusStatusUpdate)
    observer.observe(workspaceRoot, {
      attributeFilter: ['aria-hidden', 'disabled', 'hidden'],
      attributes: true,
      childList: true,
      subtree: true,
    })

    return () => {
      window.cancelAnimationFrame(animationFrame)
      workspaceRoot.removeEventListener('focusin', scheduleFocusStatusUpdate)
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
      const controls = getWorkspaceControls(root)
      const activeElement = document.activeElement
      const activeControl =
        activeElement instanceof HTMLElement
          ? activeElement.closest<HTMLElement>(workspaceControlSelector)
          : null
      const focusedControl =
        activeControl && controls.includes(activeControl) ? activeControl : null

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
      const nextControl = focusedControl
        ? findDirectionalControl(controls, focusedControl, direction)
        : controls.find((control) =>
            control.matches('.workspace-nav button.active'),
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

  function runActiveCommand() {
    const command = matchingCommands[activeCommandIndex] ?? matchingCommands[0]
    if (command) {
      navigateToView(command.view)
    }
  }

  function moveActiveCommand(direction: 1 | -1) {
    if (matchingCommands.length === 0) {
      return
    }
    setActiveCommandIndex(
      (current) =>
        (current + direction + matchingCommands.length) % matchingCommands.length,
    )
  }

  if (activeView === 'budgets') {
    return (
      <div className="authenticated-app workspace-app">
        <div className="workspace-shell" ref={workspaceShellRef} tabIndex={-1}>
          <header className="workspace-titlebar">
            <button
              className="workspace-brand"
              type="button"
              onClick={() => navigateToView('budgets')}
            >
              <span className="workspace-brand-mark" aria-hidden="true">pb</span>
              <span>{appName}</span>
            </button>
            <p>Monthly budget workspace</p>
            <details className="workspace-account-menu">
              <summary className="workspace-account-chip">
                <span>{initials || 'PB'}</span>
                <span>{email.split('@')[0]}</span>
              </summary>
              <div className="workspace-account-popover">
                <strong>{email}</strong>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => void handleSignOut()}
                  disabled={isSigningOut}
                >
                  {isSigningOut ? 'Signing out...' : 'Sign out'}
                </button>
              </div>
            </details>
          </header>

          <aside className="workspace-sidebar" aria-label="Primary navigation">
            <nav className="workspace-nav">
              {navigationItems.map((item) => (
                <button
                  aria-current={activeView === item.view ? 'page' : undefined}
                  className={activeView === item.view ? 'active' : ''}
                  key={item.view}
                  type="button"
                  onClick={() => navigateToView(item.view)}
                >
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
            <section className="workspace-keymap" aria-labelledby="workspace-keymap-title">
              <h2 id="workspace-keymap-title">Keymap</h2>
              <dl>
                <div><dt><kbd>h</kbd><kbd>j</kbd><kbd>k</kbd><kbd>l</kbd></dt><dd>move focus</dd></div>
                <div><dt><kbd>Enter</kbd></dt><dd>activate control</dd></div>
              </dl>
            </section>
          </aside>

          <div className="workspace-content">
            {signOutError && (
              <div className="shell-message">
                <p className="form-message form-message--error" role="alert">
                  {signOutError}
                </p>
              </div>
            )}
            <BudgetPanel
              categoriesRevision={categoriesRevision}
              activityRevision={budgetActivityRevision}
              onCategoriesChanged={handleCategoriesChanged}
            />
          </div>

          <aside
            aria-label="Command palette"
            className={`workspace-command-panel${
              isCommandPaletteOpen ? ' is-open' : ''
            }`}
          >
            <div className="workspace-command-head">
              <h2>Command</h2>
            </div>
            {isCommandPaletteOpen ? (
              <>
                <label className="workspace-command-input">
                  <span aria-hidden="true">:</span>
                  <input
                    ref={commandInputRef}
                    aria-label="Command"
                    value={commandQuery}
                    onChange={(event) => {
                      setCommandQuery(event.target.value)
                      setActiveCommandIndex(0)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        moveActiveCommand(1)
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        moveActiveCommand(-1)
                      } else if (event.key === 'Enter') {
                        event.preventDefault()
                        runActiveCommand()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        closeCommandPalette()
                      }
                    }}
                  />
                </label>
                <ul className="workspace-command-list">
                  {matchingCommands.map((command, index) => (
                    <li key={command.view}>
                      <button
                        className={index === activeCommandIndex ? 'active' : ''}
                        type="button"
                        onMouseEnter={() => setActiveCommandIndex(index)}
                        onClick={() => navigateToView(command.view)}
                      >
                        <strong>Go to {command.label.toLocaleLowerCase()}</strong>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <button
                className="workspace-command-trigger"
                type="button"
                onClick={openCommandPalette}
              >
                Open command menu
              </button>
            )}
          </aside>

          <footer className="workspace-statusline">
            <div>
              <strong>NAVIGATE</strong>
              <span>budget</span>
              <span>
                focus {focusedWorkspaceControl || '-'} of {workspaceControlCount}
              </span>
            </div>
            <div><kbd>h</kbd><kbd>j</kbd><kbd>k</kbd><kbd>l</kbd> move <kbd>Enter</kbd> activate</div>
          </footer>
        </div>
      </div>
    )
  }

  return (
    <div className="authenticated-app">
      <header className="topbar">
        <button
          className="brand"
          type="button"
          onClick={() => setActiveView('budgets')}
        >
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
              onClick={() => setActiveView(view)}
            >
              {label}
            </button>
          ))}
        </nav>
        <details className="account-menu">
          <summary className="account-chip">
            <span className="avatar">{initials || 'PB'}</span>
            <span className="account-label">{email.split('@')[0]}</span>
          </summary>
          <div className="account-popover">
            <strong>{email}</strong>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void handleSignOut()}
              disabled={isSigningOut}
            >
              {isSigningOut ? 'Signing out...' : 'Sign out'}
            </button>
          </div>
        </details>
      </header>
      {signOutError && (
        <div className="shell-message">
          <p className="form-message form-message--error" role="alert">
            {signOutError}
          </p>
        </div>
      )}
      {activeView === 'transactions' && (
        <TransactionsPanel
          categoriesRevision={categoriesRevision}
          onCategoriesChanged={handleCategoriesChanged}
          onTransactionsChanged={handleTransactionsChanged}
        />
      )}
      {activeView === 'insights' && (
        <InsightsPanel
          categoriesRevision={categoriesRevision}
          activityRevision={budgetActivityRevision}
        />
      )}
    </div>
  )
}

export default App
