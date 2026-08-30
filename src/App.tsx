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

const navigationItems: ReadonlyArray<{
  view: AppView
  label: string
  shortcut: string
}> = [
  { view: 'budgets', label: 'Budget', shortcut: 'g b' },
  { view: 'transactions', label: 'Transactions', shortcut: 'g t' },
  { view: 'insights', label: 'Insights', shortcut: 'g r' },
]

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
  const [isAwaitingGoTarget, setIsAwaitingGoTarget] = useState(false)
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
    `go to ${item.label} ${item.shortcut}`
      .toLocaleLowerCase()
      .includes(commandQuery.trim().toLocaleLowerCase()),
  )

  const focusSelectedBudgetRow = useCallback(() => {
    window.requestAnimationFrame(() => {
      const selectedRow = workspaceShellRef.current?.querySelector<HTMLElement>(
        '[data-budget-row-selected="true"]',
      )
      if (selectedRow) {
        selectedRow.focus()
        return
      }
      workspaceShellRef.current?.focus()
    })
  }, [])

  const closeCommandPalette = useCallback(() => {
    setIsCommandPaletteOpen(false)
    setCommandQuery('')
    setActiveCommandIndex(0)
    const previousFocus = previousFocusRef.current
    if (previousFocus?.isConnected) {
      window.requestAnimationFrame(() => previousFocus.focus())
      return
    }
    focusSelectedBudgetRow()
  }, [focusSelectedBudgetRow])

  const openCommandPalette = useCallback(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null
    setCommandQuery('go')
    setActiveCommandIndex(0)
    setIsAwaitingGoTarget(false)
    setIsCommandPaletteOpen(true)
    window.requestAnimationFrame(() => commandInputRef.current?.focus())
  }, [])

  const navigateToView = useCallback((view: AppView) => {
    setActiveView(view)
    setIsCommandPaletteOpen(false)
    setCommandQuery('')
    setActiveCommandIndex(0)
    setIsAwaitingGoTarget(false)
  }, [])

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

      if (event.key === ':' && activeView === 'budgets') {
        event.preventDefault()
        openCommandPalette()
        return
      }

      if (event.shiftKey) {
        return
      }

      const key = event.key.toLocaleLowerCase()
      if (isAwaitingGoTarget) {
        const navigationItem = navigationItems.find(
          (item) => item.shortcut.endsWith(` ${key}`),
        )
        setIsAwaitingGoTarget(false)
        if (navigationItem) {
          event.preventDefault()
          navigateToView(navigationItem.view)
        }
        return
      }

      if (key === 'g') {
        event.preventDefault()
        setIsAwaitingGoTarget(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeView, isAwaitingGoTarget, navigateToView, openCommandPalette])

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
                  <kbd>{item.shortcut}</kbd>
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
            <section className="workspace-keymap" aria-labelledby="workspace-keymap-title">
              <h2 id="workspace-keymap-title">Keymap</h2>
              <dl>
                <div><dt><kbd>j</kbd><kbd>k</kbd></dt><dd>move selection</dd></div>
                <div><dt><kbd>e</kbd></dt><dd>edit amount</dd></div>
                <div><dt><kbd>a</kbd></dt><dd>add category</dd></div>
                <div><dt><kbd>:</kbd></dt><dd>command menu</dd></div>
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
              {isCommandPaletteOpen ? <span><kbd>Esc</kbd> close</span> : null}
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
                        <kbd>Enter</kbd>
                        <strong>Go to {command.label.toLocaleLowerCase()}</strong>
                        <span>{command.shortcut}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="workspace-command-hint">
                  <kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>Enter</kbd> run
                </p>
              </>
            ) : (
              <button
                className="workspace-command-trigger"
                type="button"
                onClick={openCommandPalette}
              >
                <kbd>:</kbd> Open command menu
              </button>
            )}
          </aside>

          <footer className="workspace-statusline">
            <div>
              <strong>{isAwaitingGoTarget ? 'GO' : 'NORMAL'}</strong>
              <span>budget</span>
              <span>keyboard ready</span>
            </div>
            <div><kbd>:</kbd> commands <kbd>?</kbd> help</div>
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
