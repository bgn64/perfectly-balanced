import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  isTextEntryTarget,
} from './finance/utils.ts'
import {
  InsightsPanel,
  type InsightsInteraction,
} from './insights/InsightsPanel.tsx'
import { getSupabaseClient } from './lib/supabase.ts'
import { focusWithScrollComfort } from './navigation/focus.ts'
import { Statusline } from './navigation/Statusline.tsx'
import {
  findSpatialTarget,
  type SpatialDirection,
} from './navigation/spatial.ts'
import {
  buildNavigationStatus,
  textEntryStatus,
  type StatusPresentation,
} from './navigation/status.ts'
import {
  SettingsPanel,
  type SettingsFocusRequest,
  type SettingsInteraction,
} from './settings/SettingsPanel.tsx'
import {
  resolveTheme,
  type ThemePreference,
} from './settings/model.ts'
import { TransactionsPanel } from './transactions/TransactionsPanel.tsx'
import './App.css'
import './terminal.css'
import './theme.css'

interface AppProps {
  appName: string
}

type AppView = 'budgets' | 'transactions' | 'insights' | 'settings'
type SemanticRegion = 'header' | 'sidebar' | 'workspace'

interface StatusContext {
  action: string
  label: string
  semanticKind: string | null
  isTextEntry: boolean
}

interface AmountEditRequest {
  allocationId: string
  sequence: number
}

interface TransactionFocusRequest {
  transactionId: string
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

function readInitialThemePreference(): ThemePreference {
  const savedTheme = window.localStorage.getItem(themePreferenceKey)
  if (
    savedTheme === 'dark' ||
    savedTheme === 'light' ||
    savedTheme === 'system'
  ) {
    return savedTheme
  }
  return 'system'
}

function getSemanticControls(
  root: HTMLElement,
  region: SemanticRegion,
): HTMLElement[] {
  const modal = root.querySelector<HTMLElement>('[aria-modal="true"]')
  const semanticRoot = modal ?? root
  return Array.from(
    semanticRoot.querySelectorAll<HTMLElement>(
      `[data-semantic-region="${region}"]`,
    ),
  )
    .filter(
      (control) =>
        control.matches(
          'button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
        ) &&
        !control.matches(':disabled') &&
        control.getAttribute('aria-hidden') !== 'true' &&
        (control.tagName === 'SUMMARY' ||
          control.closest('details:not([open])') === null) &&
        control.closest('[aria-hidden="true"], [hidden]') === null &&
        control.getClientRects().length > 0,
    )
}

function getStatusContext(
  control: HTMLElement | null,
  activeElement: Element | null,
  semanticNode: HTMLElement | null,
): StatusContext {
  return {
    action: control?.dataset.statusAction ?? 'activate',
    label: control?.dataset.statusLabel ?? 'budget',
    semanticKind:
      semanticNode?.dataset.semanticKind ?? control?.dataset.semanticKind ?? null,
    isTextEntry: isTextEntryTarget(activeElement),
  }
}

function findNearestControlToLeft(
  current: HTMLElement,
  candidates: HTMLElement[],
): HTMLElement | null {
  const currentRect = current.getBoundingClientRect()
  const currentCenterX = (currentRect.left + currentRect.right) / 2
  const currentCenterY = (currentRect.top + currentRect.bottom) / 2

  return (
    candidates
      .map((control) => {
        const rect = control.getBoundingClientRect()
        return {
          control,
          centerX: (rect.left + rect.right) / 2,
          centerY: (rect.top + rect.bottom) / 2,
        }
      })
      .filter(({ centerX }) => centerX < currentCenterX - 4)
      .sort(
        (left, right) =>
          Math.abs(left.centerY - currentCenterY) -
            Math.abs(right.centerY - currentCenterY) ||
          right.centerX - left.centerX,
      )[0]?.control ?? null
  )
}

function buildAuthenticatedStatus({
  activeView,
  budgetKeyboardInteraction,
  commandQuery,
  insightsInteraction,
  isCommandPaletteOpen,
  isTransactionSearchOpen,
  settingsInteraction,
  statusContext,
  transactionControlDialog,
  transactionSearchQuery,
}: {
  activeView: AppView
  budgetKeyboardInteraction: BudgetKeyboardInteraction | null
  commandQuery: string
  insightsInteraction: InsightsInteraction | null
  isCommandPaletteOpen: boolean
  isTransactionSearchOpen: boolean
  settingsInteraction: SettingsInteraction | null
  statusContext: StatusContext
  transactionControlDialog: 'time' | 'filter' | 'sort' | null
  transactionSearchQuery: string
}): StatusPresentation {
  if (budgetKeyboardInteraction) {
    const mode =
      budgetKeyboardInteraction.mode === 'confirm-delete'
        ? 'CONFIRM'
        : budgetKeyboardInteraction.mode === 'choose-create'
          ? 'CREATE'
          : budgetKeyboardInteraction.mode === 'name-entry' ||
              budgetKeyboardInteraction.mode === 'choose-category'
            ? 'NAME'
            : budgetKeyboardInteraction.mode === 'rename-entry'
              ? 'RENAME'
              : budgetKeyboardInteraction.mode === 'saving-move'
                ? 'SAVING'
                : 'MOVE'
    const shortcuts =
      budgetKeyboardInteraction.mode === 'saving-move'
        ? []
        : budgetKeyboardInteraction.mode === 'confirm-delete' ||
            budgetKeyboardInteraction.mode === 'choose-create'
          ? [
              { keys: ['j', 'k'], label: 'choose' },
              { keys: ['Enter'], label: 'confirm' },
              { keys: ['Esc'], label: 'cancel' },
            ]
          : budgetKeyboardInteraction.mode === 'name-entry' ||
              budgetKeyboardInteraction.mode === 'rename-entry'
            ? [
                { keys: ['Enter'], label: 'save' },
                { keys: ['Esc'], label: 'cancel' },
              ]
            : budgetKeyboardInteraction.mode === 'choose-category'
              ? [
                  { keys: ['Ctrl+N', 'Ctrl+P'], label: 'choose' },
                  { keys: ['Enter'], label: 'select' },
                  { keys: ['Esc'], label: 'cancel' },
                ]
              : [
                  { keys: ['j', 'k'], label: 'position' },
                  { keys: ['p'], label: 'place' },
                  { keys: ['Esc'], label: 'cancel' },
                ]
    return {
      mode,
      label: budgetKeyboardInteraction.label,
      shortcuts,
    }
  }

  if (isCommandPaletteOpen) {
    return textEntryStatus('COMMAND', commandQuery || 'command', [
      { keys: ['Esc'], label: 'close' },
    ])
  }

  if (settingsInteraction) {
    if (settingsInteraction.mode === 'confirm') {
      return {
        mode: 'CONFIRM',
        label: settingsInteraction.label,
        shortcuts: [
          { keys: ['h', 'l'], label: 'choose' },
          { keys: ['Enter'], label: 'confirm' },
          { keys: ['Esc'], label: 'cancel' },
        ],
      }
    }
    if (settingsInteraction.mode === 'connecting') {
      return {
        mode: 'CONNECT',
        label: settingsInteraction.label,
        shortcuts: [{ keys: ['Esc'], label: 'cancel' }],
      }
    }
    return {
      mode: 'ACCOUNTS',
      label: settingsInteraction.label,
      shortcuts: [],
    }
  }

  if (activeView === 'transactions' && isTransactionSearchOpen) {
    return textEntryStatus('SEARCH', transactionSearchQuery || 'search', [
      { keys: ['Enter'], label: 'focus first result' },
      { keys: ['Esc'], label: 'clear and return' },
    ])
  }

  if (activeView === 'transactions' && transactionControlDialog) {
    return {
      mode: transactionControlDialog.toLocaleUpperCase(),
      label: `transactions / ${transactionControlDialog}`,
      shortcuts: [
        { keys: ['h', 'j', 'k', 'l'], label: 'focus' },
        ...(transactionControlDialog === 'filter'
          ? [{ keys: ['Space'], label: 'toggle' }]
          : []),
        { keys: ['Enter'], label: 'activate' },
        { keys: ['Esc'], label: 'close' },
      ],
    }
  }

  if (activeView === 'insights' && insightsInteraction) {
    if (insightsInteraction.mode === 'transactions') {
      return {
        mode: 'TRANSACTIONS',
        label: statusContext.label,
        shortcuts: [
          { keys: ['j', 'k'], label: 'focus' },
          {
            keys: ['Esc'],
            label: insightsInteraction.hasParent ? 'back' : 'close',
          },
        ],
      }
    }
    return {
      mode: 'DRILLDOWN',
      label: statusContext.label,
      shortcuts: [
        ...(insightsInteraction.canOpenTransactions ||
        statusContext.action === 'close'
          ? [{ keys: ['Enter'], label: statusContext.action }]
          : []),
        { keys: ['h', 'j', 'k', 'l'], label: 'focus' },
        { keys: ['Esc'], label: 'close' },
      ],
    }
  }

  if (statusContext.isTextEntry) {
    if (statusContext.semanticKind === 'category-picker-search') {
      return textEntryStatus('CATEGORY', statusContext.label, [
        { keys: ['Ctrl+N', 'Ctrl+P'], label: 'choose' },
        { keys: ['Enter'], label: 'select' },
        { keys: ['Esc'], label: 'cancel' },
      ])
    }
    const canCommit = statusContext.action.startsWith('save')
    return textEntryStatus(
      'INPUT',
      statusContext.label,
      canCommit
        ? [
            { keys: ['Enter'], label: statusContext.action },
            { keys: ['Esc'], label: 'cancel' },
          ]
        : [],
    )
  }

  if (statusContext.semanticKind === 'transaction-detail') {
    const isSplitRow = statusContext.action === 'edit split'
    return {
      mode: isSplitRow ? 'SPLIT' : 'TRANSACTION',
      label: statusContext.label,
      shortcuts: isSplitRow
        ? [
            { keys: ['a'], label: 'amount' },
            { keys: ['c'], label: 'category' },
            { keys: ['d'], label: 'delete' },
            { keys: ['j', 'k'], label: 'focus' },
            { keys: ['Esc'], label: 'close' },
          ]
        : [
            { keys: ['Enter'], label: statusContext.action },
            { keys: ['m'], label: 'month' },
            { keys: ['t'], label: 'status' },
            { keys: ['h', 'j', 'k', 'l'], label: 'focus' },
            { keys: ['Esc'], label: 'close' },
          ],
    }
  }

  return buildNavigationStatus({
    view: activeView,
    action: statusContext.action,
    label: statusContext.label,
    semanticKind: statusContext.semanticKind,
    isTextEntry: false,
  })
}

function AuthenticatedTitlebar({
  appName,
  email,
  initials,
  onOpenAccount,
  onOpenBudget,
}: {
  appName: string
  email: string
  initials: string
  onOpenAccount: () => void
  onOpenBudget: () => void
}) {
  return (
    <header className="titlebar hud-titlebar">
      <button
        className="brand"
        data-semantic-id="header-brand"
        data-semantic-kind="header-brand"
        data-semantic-region="header"
        data-status-action="open budget"
        data-status-label="application / budget"
        type="button"
        onClick={onOpenBudget}
      >
        <span className="brand-mark" aria-hidden="true">pb</span>
        <span>{appName.toLocaleLowerCase().replace(/\s+/g, '-')}</span>
      </button>
      <button
        aria-label={`Account settings for ${email}`}
        className="hud-identity"
        data-semantic-id="header-account"
        data-semantic-kind="header-account"
        data-semantic-region="header"
        data-status-action="open Account settings"
        data-status-label="account / profile shortcut"
        type="button"
        onClick={onOpenAccount}
      >
        <span>{initials || 'PB'}</span>
        <span>
          <strong>{email.split('@')[0]}</strong>
          <small>Account settings</small>
        </span>
      </button>
    </header>
  )
}

function AuthenticatedSidebar({
  activeView,
  focusedSemanticId,
  uncategorizedTransactionCount,
  onNavigate,
}: {
  activeView: AppView
  focusedSemanticId: string | null
  uncategorizedTransactionCount: number
  onNavigate: (view: AppView) => void
}) {
  function navigationButton(item: { view: AppView; label: string }) {
    return (
      <button
        aria-current={activeView === item.view ? 'page' : undefined}
        className={`nav-item${activeView === item.view ? ' is-active' : ''}${
          focusedSemanticId === `nav-${item.view}` ? ' is-focused' : ''
        }`}
        data-semantic-id={`nav-${item.view}`}
        data-semantic-kind="navigation"
        data-semantic-region="sidebar"
        data-status-action={`open ${item.label.toLocaleLowerCase()}`}
        data-status-label={`${item.label.toLocaleLowerCase()} / navigation`}
        key={item.view}
        type="button"
        onClick={() => onNavigate(item.view)}
      >
        <span>{item.label}</span>
        {item.view === 'transactions' && (
          <strong>{uncategorizedTransactionCount}</strong>
        )}
      </button>
    )
  }

  return (
    <aside className="sidebar hud-sidebar" aria-label="Application navigation">
      <nav className="main-nav">{navigationItems.map(navigationButton)}</nav>
      <nav className="main-nav hud-utility-nav" aria-label="Settings navigation">
        {navigationButton({ view: 'settings', label: 'Settings' })}
      </nav>
    </aside>
  )
}

function App({ appName }: AppProps) {
  const { isLoading, initializationError, session, user } = useAuth()

  if (isLoading) {
    return <LoadingScreen appName={appName} />
  }

  if (initializationError) {
    return (
      <main className="auth-page">
        <section className="auth-terminal" aria-labelledby="auth-error-title">
          <header className="auth-terminal__head">
            <span className="brand">
              <span className="brand-mark" aria-hidden="true">pb</span>
              <span>{appName.toLocaleLowerCase().replace(/\s+/g, '-')}</span>
            </span>
            <span className="spent">session unavailable</span>
          </header>
          <div className="auth-terminal__body">
            <p className="eyebrow">Authentication</p>
            <h1 id="auth-error-title">We could not verify your session</h1>
            <p>{initializationError}</p>
            <p className="auth-footnote">Refresh the page to try again.</p>
          </div>
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
      <section className="auth-terminal" aria-live="polite">
        <header className="auth-terminal__head">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">pb</span>
            <span>{appName.toLocaleLowerCase().replace(/\s+/g, '-')}</span>
          </span>
          <span>secure session</span>
        </header>
        <div className="auth-terminal__body">
          <p className="eyebrow">Authentication</p>
          <h1>Checking your session</h1>
          <p>One moment while we securely sign you in.</p>
          <span className="terminal-pill">Working...</span>
        </div>
      </section>
    </main>
  )
}

function SignInScreen({ appName }: AppProps) {
  const { localDemoMode, localTestCredentials, siteUrl } =
    getClientConfiguration()
  const [email, setEmail] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [localEmail, setLocalEmail] = useState(
    localTestCredentials?.email ?? '',
  )
  const [localPassword, setLocalPassword] = useState(
    localTestCredentials?.password ?? '',
  )
  const [isLocalSubmitting, setIsLocalSubmitting] = useState(false)

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
        emailRedirectTo: siteUrl,
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

  async function handleLocalSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const normalizedEmail = localEmail.trim()
    if (!normalizedEmail || !localPassword) {
      setErrorMessage('Enter the local test account email and password.')
      return
    }

    setIsLocalSubmitting(true)
    setErrorMessage(null)
    setSuccessMessage(null)

    const { error } = await getSupabaseClient().auth.signInWithPassword({
      email: normalizedEmail,
      password: localPassword,
    })

    setIsLocalSubmitting(false)

    if (error) {
      setErrorMessage(error.message)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-terminal" aria-labelledby="sign-in-title">
        <header className="auth-terminal__head">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">pb</span>
            <span>{appName.toLocaleLowerCase().replace(/\s+/g, '-')}</span>
          </span>
          <span>secure session</span>
        </header>
        <div className="auth-terminal__body">
          <p className="eyebrow">Welcome back</p>
          <h1 id="sign-in-title">Sign in with email</h1>
          <p>
            Your invitation is tied to your email address. We will send a
            single-use sign-in link.
          </p>
          <form className="auth-form" onSubmit={handleSubmit}>
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
            <button
              className="terminal-button terminal-button--primary"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Sending sign-in link...' : 'Send sign-in link'}
            </button>
          </form>
          {localDemoMode && (
            <>
              <div className="auth-divider" aria-hidden="true">
                local development
              </div>
              <section
                className="local-access"
                aria-labelledby="local-sign-in-title"
              >
                <h2 id="local-sign-in-title">Use the seeded local account</h2>
                <p>Only shown in the local environment.</p>
                <form className="auth-form" onSubmit={handleLocalSubmit}>
                  <label htmlFor="local-email">Email address</label>
                  <input
                    id="local-email"
                    name="local-email"
                    type="email"
                    autoComplete="username"
                    disabled={isLocalSubmitting}
                    value={localEmail}
                    onChange={(event) => setLocalEmail(event.target.value)}
                    required
                  />
                  <label htmlFor="local-password">Password</label>
                  <input
                    id="local-password"
                    name="local-password"
                    type="password"
                    autoComplete="current-password"
                    disabled={isLocalSubmitting}
                    value={localPassword}
                    onChange={(event) => setLocalPassword(event.target.value)}
                    required
                  />
                  <button
                    className="terminal-button"
                    type="submit"
                    disabled={isLocalSubmitting}
                  >
                    {isLocalSubmitting ? 'Signing in locally...' : 'Sign in locally'}
                  </button>
                </form>
              </section>
            </>
          )}
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
        </div>
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
  const [uncategorizedTransactionCount, setUncategorizedTransactionCount] =
    useState(0)
  const [isTransactionSearchOpen, setIsTransactionSearchOpen] =
    useState(false)
  const [transactionSearchQuery, setTransactionSearchQuery] = useState('')
  const [transactionControlDialog, setTransactionControlDialog] = useState<
    'time' | 'filter' | 'sort' | null
  >(null)
  const [insightsInteraction, setInsightsInteraction] =
    useState<InsightsInteraction | null>(null)
  const [settingsInteraction, setSettingsInteraction] =
    useState<SettingsInteraction | null>(null)
  const [settingsFocusRequest, setSettingsFocusRequest] =
    useState<SettingsFocusRequest | null>(null)
  const [commandQuery, setCommandQuery] = useState('go')
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(readInitialThemePreference)
  const [systemPrefersLight, setSystemPrefersLight] = useState(() =>
    window.matchMedia('(prefers-color-scheme: light)').matches,
  )
  const theme = resolveTheme(themePreference, systemPrefersLight)
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [isAmountEditorOpen, setIsAmountEditorOpen] = useState(false)
  const [amountEditRequest, setAmountEditRequest] =
    useState<AmountEditRequest | null>(null)
  const [budgetKeyboardAction, setBudgetKeyboardAction] =
    useState<BudgetKeyboardAction | null>(null)
  const [budgetKeyboardInteraction, setBudgetKeyboardInteraction] =
    useState<BudgetKeyboardInteraction | null>(null)
  const [transactionFocusRequest, setTransactionFocusRequest] =
    useState<TransactionFocusRequest | null>(null)
  const [focusedSemanticId, setFocusedSemanticId] = useState<string | null>(
    'nav-budgets',
  )
  const [statusContext, setStatusContext] = useState<StatusContext>({
    action: 'view',
    label: 'budget / navigation',
    semanticKind: null,
    isTextEntry: false,
  })
  const workspaceShellRef = useRef<HTMLDivElement>(null)
  const commandInputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const pendingViewFocusRef = useRef<AppView | null>(null)
  const handleTransactionsChanged = useCallback(() => {
    setBudgetActivityRevision((revision) => revision + 1)
  }, [])
  const handleCategoriesChanged = useCallback(() => {
    setCategoriesRevision((revision) => revision + 1)
  }, [])
  const handleUncategorizedCountChange = useCallback((count: number) => {
    setUncategorizedTransactionCount(count)
  }, [])
  const handleTransactionSearchStateChange = useCallback(
    (isOpen: boolean, query: string) => {
      setIsTransactionSearchOpen(isOpen)
      setTransactionSearchQuery(query)
    },
    [],
  )
  const openTransaction = useCallback((transactionId: string) => {
    setTransactionFocusRequest((current) => ({
      transactionId,
      sequence: (current?.sequence ?? 0) + 1,
    }))
    setActiveView('transactions')
  }, [])
  const initials = email
    .split('@')[0]
    .split(/[._-]/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  const focusWorkspaceControl = useCallback((control: HTMLElement) => {
    focusWithScrollComfort(control)
  }, [])
  const navigateToView = useCallback((view: AppView) => {
    pendingViewFocusRef.current = view
    setSettingsFocusRequest(null)
    setIsCommandPaletteOpen(false)
    setActiveView(view)
  }, [])
  const openAccountSettings = useCallback(() => {
    pendingViewFocusRef.current = null
    setSettingsFocusRequest((current) => ({
      section: 'account',
      sequence: (current?.sequence ?? 0) + 1,
    }))
    setIsCommandPaletteOpen(false)
    setActiveView('settings')
  }, [])
  useEffect(() => {
    if (pendingViewFocusRef.current !== activeView) {
      return
    }
    pendingViewFocusRef.current = null
    const navItem = workspaceShellRef.current?.querySelector<HTMLElement>(
      `[data-semantic-id="nav-${activeView}"]`,
    )
    if (navItem) {
      focusWorkspaceControl(navItem)
    }
  }, [activeView, focusWorkspaceControl])
  const focusBudgetRow = useCallback(
    (allocationId: string) => {
      window.requestAnimationFrame(() => {
        const row = document.getElementById(`budget-row-${allocationId}`)
        if (row) {
          focusWithScrollComfort(row)
        }
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
    window.localStorage.setItem(themePreferenceKey, themePreference)
  }, [themePreference])

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const updatePreference = () => setSystemPrefersLight(media.matches)
    media.addEventListener('change', updatePreference)
    return () => media.removeEventListener('change', updatePreference)
  }, [])

  useEffect(() => {
    const root = workspaceShellRef.current
    if (!root) {
      return
    }
    let animationFrame = 0
    const updateFocusStatus = () => {
      const activeElement = document.activeElement
      if (!(activeElement instanceof HTMLElement) || !root.contains(activeElement)) {
        return
      }
      const activeControl =
        activeElement.closest<HTMLElement>('[data-status-label]')
      const activeSemanticNode =
        activeElement.closest<HTMLElement>('[data-semantic-id]')
      setFocusedSemanticId(activeSemanticNode?.dataset.semanticId ?? null)
      setStatusContext(
        getStatusContext(activeControl, activeElement, activeSemanticNode),
      )
    }
    const scheduleFocusStatusUpdate = () => {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(updateFocusStatus)
    }
    const handleFocusIn = () => {
      window.cancelAnimationFrame(animationFrame)
      updateFocusStatus()
    }
    const observer = new MutationObserver(scheduleFocusStatusUpdate)
    document.addEventListener('focusin', handleFocusIn)
    observer.observe(root, {
      attributeFilter: ['aria-hidden', 'disabled', 'hidden'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    scheduleFocusStatusUpdate()

    return () => {
      window.cancelAnimationFrame(animationFrame)
      document.removeEventListener('focusin', handleFocusIn)
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
                budgetKeyboardInteraction.mode !== 'name-entry' &&
                budgetKeyboardInteraction.mode !== 'choose-category'
              ? key === 'j'
                ? 'next'
                : 'previous'
              : event.key === 'Enter' &&
                  budgetKeyboardInteraction.mode !== 'moving' &&
                  budgetKeyboardInteraction.mode !== 'choose-category'
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
      if (
        event.key === ':' &&
        activeView === 'budgets' &&
        !isAmountEditorOpen
      ) {
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
      const headerControls = getSemanticControls(root, 'header')
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

      if (
        key === 'n' &&
        focusedControl?.dataset.semanticKind === 'budget-first-item'
      ) {
        event.preventDefault()
        focusedControl.click()
        return
      }

      if (
        event.key === 'Enter' &&
        document.activeElement === focusedControl &&
        focusedControl.dataset.semanticKind === 'transaction-row'
      ) {
        event.preventDefault()
        focusedControl.click()
        return
      }

      const region = focusedControl?.dataset.semanticRegion
      const controls =
        region === 'header'
          ? headerControls
          : region === 'sidebar'
          ? sidebarControls
          : region === 'workspace'
            ? workspaceControls
            : []
      let nextControl: HTMLElement | null = null

      const spatialDirection: SpatialDirection | null =
        key === 'h'
          ? 'left'
          : key === 'j'
            ? 'down'
            : key === 'k'
              ? 'up'
              : key === 'l'
                ? 'right'
                : null
      if (!spatialDirection) {
        return
      }
      nextControl = findSpatialTarget(
        focusedControl,
        controls,
        spatialDirection,
      )
      if (!nextControl && key === 'h' && region === 'workspace') {
        const nearestIncomeSlice =
          focusedControl.dataset.semanticKind === 'report-slice' &&
          focusedControl.dataset.semanticId?.startsWith(
            'report-slice-spending-',
          )
            ? findNearestControlToLeft(
                focusedControl,
                workspaceControls.filter((control) =>
                  control.dataset.semanticId?.startsWith(
                    'report-slice-income-',
                  ),
                ),
              )
            : null
        nextControl =
          nearestIncomeSlice ??
          findSpatialTarget(focusedControl, sidebarControls, 'left') ??
          sidebarControls.find((control) =>
            control.matches('.nav-item.is-active'),
          ) ??
          null
      } else if (!nextControl && key === 'l' && region === 'sidebar') {
        nextControl =
          findSpatialTarget(focusedControl, workspaceControls, 'right') ??
          workspaceControls[0] ??
          null
      } else if (
        !nextControl &&
        key === 'k' &&
        (region === 'sidebar' || region === 'workspace')
      ) {
        nextControl = findSpatialTarget(focusedControl, headerControls, 'up')
      } else if (!nextControl && key === 'j' && region === 'header') {
        nextControl = findSpatialTarget(
          focusedControl,
          [...sidebarControls, ...workspaceControls],
          'down',
        )
      }

      if (nextControl) {
        event.preventDefault()
        focusWorkspaceControl(nextControl)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    activeView,
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

  const statusPresentation = buildAuthenticatedStatus({
    activeView,
    budgetKeyboardInteraction,
    commandQuery,
    insightsInteraction,
    isCommandPaletteOpen,
    isTransactionSearchOpen,
    settingsInteraction,
    statusContext,
    transactionControlDialog,
    transactionSearchQuery,
  })

  return (
    <div
      className={`authenticated-app terminal-app${
        isCommandPaletteOpen ? '' : ' command-closed'
      }${activeView === 'budgets' ? '' : ' screen-app'} hud-app`}
      ref={workspaceShellRef}
    >
      <AuthenticatedTitlebar
        appName={appName}
        email={email}
        initials={initials}
        onOpenAccount={openAccountSettings}
        onOpenBudget={() => navigateToView('budgets')}
      />

      <AuthenticatedSidebar
        activeView={activeView}
        focusedSemanticId={focusedSemanticId}
        uncategorizedTransactionCount={uncategorizedTransactionCount}
        onNavigate={navigateToView}
      />

      <main className="workspace">
        {signOutError && activeView !== 'settings' && (
          <p className="form-message form-message--error" role="alert">
            {signOutError}
          </p>
        )}
        {activeView === 'budgets' && (
          <BudgetPanel
            activityRevision={budgetActivityRevision}
            amountEditRequest={amountEditRequest}
            keyboardActionRequest={budgetKeyboardAction}
            categoriesRevision={categoriesRevision}
            focusedSemanticId={focusedSemanticId}
            selectedMonth={selectedMonth}
            onCategoriesChanged={handleCategoriesChanged}
            onOpenTransaction={openTransaction}
            onUncategorizedCountChange={handleUncategorizedCountChange}
            onKeyboardInteractionChange={setBudgetKeyboardInteraction}
            onAmountEditorClosed={(allocationId) => {
              setIsAmountEditorOpen(false)
              setAmountEditRequest(null)
              focusBudgetRow(allocationId)
            }}
            onAmountEditorOpenChange={setIsAmountEditorOpen}
            onMonthChange={setSelectedMonth}
          />
        )}
        {activeView === 'transactions' && (
          <TransactionsPanel
            categoriesRevision={categoriesRevision}
            focusTransactionRequest={transactionFocusRequest}
            selectedMonth={selectedMonth}
            onCategoriesChanged={handleCategoriesChanged}
            onControlDialogChange={setTransactionControlDialog}
            onSearchStateChange={handleTransactionSearchStateChange}
            onTransactionsChanged={handleTransactionsChanged}
            onUncategorizedCountChange={handleUncategorizedCountChange}
          />
        )}
        {activeView === 'insights' && (
          <InsightsPanel
            activityRevision={budgetActivityRevision}
            categoriesRevision={categoriesRevision}
            selectedMonth={selectedMonth}
            onInteractionChange={setInsightsInteraction}
            onMonthChange={setSelectedMonth}
          />
        )}
        {activeView === 'settings' && (
          <SettingsPanel
            email={email}
            focusRequest={settingsFocusRequest}
            isSigningOut={isSigningOut}
            signOutError={signOutError}
            themePreference={themePreference}
            onActivityChanged={handleTransactionsChanged}
            onInteractionChange={setSettingsInteraction}
            onSignOut={() => void handleSignOut()}
            onThemePreferenceChange={setThemePreference}
          />
        )}
      </main>

      {activeView === 'budgets' && isCommandPaletteOpen && (
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
              <button type="button" onClick={() => navigateToView('settings')}>
                Go to settings
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  closeCommandPalette()
                  window.requestAnimationFrame(() => {
                    const firstBudgetEntry = document.querySelector<HTMLElement>(
                      '.budget-table [data-semantic-kind="budget-row"], .budget-table [data-semantic-kind="budget-subsection"]',
                    )
                    const categoryTarget =
                      firstBudgetEntry ?? document.getElementById('budget-heading')
                    if (categoryTarget) {
                      focusWithScrollComfort(categoryTarget)
                    }
                  })
                }}
              >
                Go to category
              </button>
            </li>
          </ul>
        </aside>
      )}

      <Statusline presentation={statusPresentation} />
    </div>
  )
}

export default App
