import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  type PlaidLinkOnExit,
  type PlaidLinkOnSuccess,
  usePlaidLink,
} from 'react-plaid-link'
import { collectPages } from '../finance/query.ts'
import { getSupabaseClient } from '../lib/supabase.ts'
import { focusWithScrollComfort } from '../navigation/focus.ts'
import {
  connectionPresentation,
  type PlaidConnectionAction,
  type PlaidConnectionStatus,
  type ThemePreference,
} from './model.ts'

interface PlaidItemRow {
  id: string
  institution_name: string | null
  status: PlaidConnectionStatus
  last_synced_at: string | null
  connected_at: string
  disconnected_at: string | null
}

interface PlaidTransactionAccountRow {
  id: string
  plaid_item_id: string | null
  account_name: string
}

interface PlaidConnection extends PlaidItemRow {
  accountNames: string[]
}

interface LinkRequest {
  token: string
  itemId: string | null
  isUpdateMode: boolean
}

interface ConfirmationRequest {
  kind: 'disconnect' | 'delete-history'
  connection: PlaidConnection
}

export interface SettingsFocusRequest {
  section: 'account'
  sequence: number
}

export interface SettingsInteraction {
  mode: 'connecting' | 'confirm' | 'working'
  label: string
}

export function SettingsPanel({
  email,
  focusRequest,
  isSigningOut,
  signOutError,
  themePreference,
  onActivityChanged,
  onInteractionChange,
  onSignOut,
  onThemePreferenceChange,
}: {
  email: string
  focusRequest: SettingsFocusRequest | null
  isSigningOut: boolean
  signOutError: string | null
  themePreference: ThemePreference
  onActivityChanged: () => void
  onInteractionChange: (interaction: SettingsInteraction | null) => void
  onSignOut: () => void
  onThemePreferenceChange: (preference: ThemePreference) => void
}) {
  const [connections, setConnections] = useState<PlaidConnection[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [preparingLinkFor, setPreparingLinkFor] = useState<string | null>(null)
  const [linkRequest, setLinkRequest] = useState<LinkRequest | null>(null)
  const [workingItemId, setWorkingItemId] = useState<string | null>(null)
  const [confirmation, setConfirmation] =
    useState<ConfirmationRequest | null>(null)
  const requestGeneration = useRef(0)
  const accountSectionRef = useRef<HTMLElement>(null)
  const confirmationRef = useRef<HTMLElement>(null)
  const plaidDialogRef = useRef<HTMLElement>(null)
  const actionOriginRef = useRef<HTMLElement | null>(null)
  const linkRequestRef = useRef<LinkRequest | null>(null)
  const linkGenerationRef = useRef(0)

  const loadConnections = useCallback(async () => {
    const generation = ++requestGeneration.current
    try {
      const client = getSupabaseClient()
      const [itemsResult, accountRows] = await Promise.all([
        client
          .from('plaid_items')
          .select(
            'id, institution_name, status, last_synced_at, connected_at, disconnected_at',
          )
          .order('connected_at', { ascending: false }),
        collectPages((afterId, limit) => {
          let query = client
            .from('transactions')
            .select('id, plaid_item_id, account_name')
            .not('plaid_item_id', 'is', null)
            .order('id')
            .limit(limit)
          if (afterId) {
            query = query.gt('id', afterId)
          }
          return query
        }),
      ])

      if (itemsResult.error) {
        throw new Error(itemsResult.error.message)
      }
      if (generation !== requestGeneration.current) {
        return
      }

      const accountNamesByItem = new Map<string, Set<string>>()
      for (const row of accountRows as PlaidTransactionAccountRow[]) {
        if (!row.plaid_item_id) {
          continue
        }
        const names = accountNamesByItem.get(row.plaid_item_id) ?? new Set()
        names.add(row.account_name)
        accountNamesByItem.set(row.plaid_item_id, names)
      }

      setConnections(
        ((itemsResult.data ?? []) as PlaidItemRow[]).map((item) => ({
          ...item,
          accountNames: Array.from(accountNamesByItem.get(item.id) ?? []).sort(),
        })),
      )
      setErrorMessage(null)
    } catch (error) {
      if (generation === requestGeneration.current) {
        setErrorMessage(errorMessageFrom(error, 'We could not load bank connections.'))
      }
    } finally {
      if (generation === requestGeneration.current) {
        setIsLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect synchronizes Settings with Supabase.
    void loadConnections()
    return () => {
      requestGeneration.current += 1
    }
  }, [loadConnections])

  useEffect(() => {
    if (
      !connections.some((connection) => connection.status === 'initial_syncing')
    ) {
      return
    }
    const timeout = window.setTimeout(() => void loadConnections(), 3_000)
    return () => window.clearTimeout(timeout)
  }, [connections, loadConnections])

  useEffect(() => {
    if (!focusRequest || focusRequest.section !== 'account') {
      return
    }
    const animationFrame = window.requestAnimationFrame(() => {
      if (accountSectionRef.current) {
        focusWithScrollComfort(accountSectionRef.current)
      }
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [focusRequest])

  const restoreActionFocus = useCallback(() => {
    const origin = actionOriginRef.current
    actionOriginRef.current = null
    window.requestAnimationFrame(() => {
      if (origin?.isConnected) {
        focusWithScrollComfort(origin)
      }
    })
  }, [])

  const finishPlaidLink = useCallback(
    async (publicToken: string | null) => {
      const request = linkRequestRef.current
      if (!request) {
        return
      }
      linkRequestRef.current = null
      setLinkRequest(null)
      setWorkingItemId(request.itemId ?? 'new')
      try {
        if (request.isUpdateMode && request.itemId) {
          await invokeFunction('plaid-complete-item-update', {
            itemId: request.itemId,
          })
          setSuccessMessage('The bank connection was repaired.')
        } else {
          if (!publicToken) {
            throw new Error('Plaid did not return a public token.')
          }
          await invokeFunction('plaid-import-transactions', { publicToken })
          setSuccessMessage('The bank was connected and its activity is syncing.')
        }
        setErrorMessage(null)
        await loadConnections()
        onActivityChanged()
      } catch (error) {
        setErrorMessage(
          errorMessageFrom(error, 'We could not complete the bank connection.'),
        )
      } finally {
        setWorkingItemId(null)
        restoreActionFocus()
      }
    },
    [loadConnections, onActivityChanged, restoreActionFocus],
  )

  const handlePlaidSuccess: PlaidLinkOnSuccess = useCallback(
    (publicToken) => {
      void finishPlaidLink(publicToken)
    },
    [finishPlaidLink],
  )

  const handlePlaidExit: PlaidLinkOnExit = useCallback(
    (error) => {
      linkRequestRef.current = null
      setLinkRequest(null)
      if (error) {
        setErrorMessage(error.display_message ?? 'The Plaid connection was closed.')
      }
      restoreActionFocus()
    },
    [restoreActionFocus],
  )

  useEffect(() => {
    onInteractionChange(
      confirmation
        ? {
            mode: 'confirm',
            label: `settings / accounts / ${connectionName(confirmation.connection)} / ${confirmation.kind}`,
          }
        : preparingLinkFor || linkRequest
          ? { mode: 'connecting', label: 'settings / accounts / Plaid' }
          : workingItemId
            ? { mode: 'working', label: 'settings / accounts / updating' }
            : null,
    )
  }, [confirmation, linkRequest, onInteractionChange, preparingLinkFor, workingItemId])

  useEffect(
    () => () => onInteractionChange(null),
    [onInteractionChange],
  )

  useEffect(() => {
    if (!confirmation) {
      return
    }
    const animationFrame = window.requestAnimationFrame(() => {
      confirmationRef.current
        ?.querySelector<HTMLElement>('[data-confirm-primary="true"]')
        ?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [confirmation])

  useEffect(() => {
    if (!preparingLinkFor && !linkRequest) {
      return
    }
    const animationFrame = window.requestAnimationFrame(() => {
      plaidDialogRef.current
        ?.querySelector<HTMLElement>('button:not(:disabled)')
        ?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [linkRequest, preparingLinkFor])

  async function startPlaidLink(
    itemId: string | null,
    origin: HTMLElement,
  ) {
    const generation = ++linkGenerationRef.current
    actionOriginRef.current = origin
    setPreparingLinkFor(itemId ?? 'new')
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      const response = await invokeFunction<{
        linkToken: string
        isUpdateMode: boolean
      }>('plaid-create-link-token', itemId ? { itemId } : {})
      if (generation !== linkGenerationRef.current) {
        return
      }
      const request = {
        token: response.linkToken,
        itemId,
        isUpdateMode: response.isUpdateMode,
      }
      linkRequestRef.current = request
      setLinkRequest(request)
    } catch (error) {
      if (generation !== linkGenerationRef.current) {
        return
      }
      setErrorMessage(
        errorMessageFrom(error, 'We could not start the Plaid connection.'),
      )
      restoreActionFocus()
    } finally {
      setPreparingLinkFor(null)
    }
  }

  async function runConnectionAction(
    connection: PlaidConnection,
    action: PlaidConnectionAction,
    origin: HTMLElement,
  ) {
    if (!action) {
      return
    }
    if (action === 'reconnect') {
      await startPlaidLink(connection.id, origin)
      return
    }
    if (action === 'delete-history') {
      actionOriginRef.current = origin
      setConfirmation({ kind: 'delete-history', connection })
      return
    }

    actionOriginRef.current = origin
    setWorkingItemId(connection.id)
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      await invokeFunction('plaid-retry-item-sync', { itemId: connection.id })
      setSuccessMessage(
        action === 'retry'
          ? `${connectionName(connection)} is syncing again.`
          : `${connectionName(connection)} is checking for new activity.`,
      )
      await loadConnections()
      onActivityChanged()
    } catch (error) {
      setErrorMessage(
        errorMessageFrom(
          error,
          `We could not check ${connectionName(connection)} for available transactions.`,
        ),
      )
    } finally {
      setWorkingItemId(null)
      restoreActionFocus()
    }
  }

  function requestDisconnect(connection: PlaidConnection, origin: HTMLElement) {
    actionOriginRef.current = origin
    setConfirmation({ kind: 'disconnect', connection })
  }

  function closeConfirmation() {
    setConfirmation(null)
    restoreActionFocus()
  }

  async function confirmDestructiveAction() {
    const request = confirmation
    if (!request) {
      return
    }
    setConfirmation(null)
    setWorkingItemId(request.connection.id)
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      await invokeFunction(
        request.kind === 'disconnect'
          ? 'plaid-disconnect-item'
          : 'plaid-delete-disconnected-history',
        { itemId: request.connection.id },
      )
      setSuccessMessage(
        request.kind === 'disconnect'
          ? `${connectionName(request.connection)} was disconnected.`
          : `${connectionName(request.connection)} history was deleted.`,
      )
      await loadConnections()
      onActivityChanged()
    } catch (error) {
      setErrorMessage(
        errorMessageFrom(
          error,
          request.kind === 'disconnect'
            ? 'We could not disconnect this bank.'
            : 'We could not delete this disconnected bank history.',
        ),
      )
    } finally {
      setWorkingItemId(null)
      restoreActionFocus()
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if ((preparingLinkFor || linkRequest) && event.key === 'Escape') {
      event.preventDefault()
      linkGenerationRef.current += 1
      linkRequestRef.current = null
      setPreparingLinkFor(null)
      setLinkRequest(null)
      restoreActionFocus()
      return
    }
    if (confirmation && event.key === 'Escape') {
      event.preventDefault()
      closeConfirmation()
      return
    }
    if (event.key.toLocaleLowerCase() !== 'd' || confirmation) {
      return
    }
    const target = event.target
    if (!(target instanceof HTMLElement)) {
      return
    }
    const accountControl = target.closest<HTMLElement>(
      '[data-semantic-kind="settings-account"]',
    )
    const itemId = accountControl?.dataset.plaidItemId
    const connection = connections.find((candidate) => candidate.id === itemId)
    if (!accountControl || !connection) {
      return
    }
    const presentation = connectionPresentation(connection.status)
    if (!presentation.canDisconnect) {
      return
    }
    event.preventDefault()
    requestDisconnect(connection, accountControl)
  }

  function trapModalFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') {
      return
    }
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    )
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) {
      event.preventDefault()
      return
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <section className="page hud-settings-page" onKeyDown={handleKeyDown}>
      <header className="workspace-head workspace-head--compact">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Settings</h1>
          <p className="subtitle">
            Manage appearance, connected accounts, and your session.
          </p>
        </div>
      </header>

      {(errorMessage || signOutError) && (
        <p className="form-message form-message--error" role="alert">
          {errorMessage ?? signOutError}
        </p>
      )}
      {successMessage && (
        <p className="form-message form-message--success" aria-live="polite">
          {successMessage}
        </p>
      )}

      <section className="hud-settings-section" aria-labelledby="settings-theme-title">
        <header>
          <div>
            <p className="eyebrow">Appearance</p>
            <h2 id="settings-theme-title">Theme</h2>
          </div>
          <span>Applied immediately</span>
        </header>
        <div className="hud-setting-row">
          <div>
            <strong>Color theme</strong>
            <small>Use the dark, light, or system app palette.</small>
          </div>
          <div aria-label="Color theme" className="hud-theme-control" role="group">
            {(['dark', 'light', 'system'] as const).map((preference) => (
              <button
                aria-pressed={themePreference === preference}
                className={themePreference === preference ? 'is-selected' : ''}
                data-semantic-id={`settings-theme-${preference}`}
                data-semantic-kind="settings-theme"
                data-semantic-region="workspace"
                data-status-action="select theme"
                data-status-label={`settings / appearance / ${preference}`}
                key={preference}
                type="button"
                onClick={() => onThemePreferenceChange(preference)}
              >
                {preference[0].toLocaleUpperCase() + preference.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="hud-settings-section" aria-labelledby="settings-accounts-title">
        <header>
          <div>
            <p className="eyebrow">Data sources</p>
            <h2 id="settings-accounts-title">Banks and accounts</h2>
          </div>
          <button
            className="terminal-button terminal-button--primary"
            data-semantic-id="settings-add-plaid"
            data-semantic-kind="settings-add-account"
            data-semantic-region="workspace"
            data-status-action="add via Plaid"
            data-status-label="settings / accounts / add"
            disabled={Boolean(preparingLinkFor || linkRequest || workingItemId)}
            type="button"
            onClick={(event) => void startPlaidLink(null, event.currentTarget)}
          >
            + Add via Plaid
          </button>
        </header>

        {isLoading ? (
          <div className="hud-account-state" aria-live="polite">
            <span className="hud-loading-line" />
            <span className="hud-loading-line hud-loading-line--short" />
            <small>Loading connections...</small>
          </div>
        ) : connections.length === 0 ? (
          <div className="hud-account-state">
            <strong>No banks connected</strong>
            <small>Connect an institution to import account activity.</small>
          </div>
        ) : (
          <div className="hud-connection-list">
            {connections.map((connection) => {
              const presentation = connectionPresentation(connection.status)
              const isWorking = workingItemId === connection.id
              return (
                <article
                  className={`hud-connection${
                    presentation.tone === 'danger' ? ' is-attention' : ''
                  }`}
                  key={connection.id}
                >
                  <span className="hud-bank-mark" aria-hidden="true">
                    {connectionInitials(connection)}
                  </span>
                  <div>
                    <strong>{connectionName(connection)}</strong>
                    <small>{connectionDetails(connection)}</small>
                  </div>
                  <span
                    className={`terminal-pill terminal-pill--${presentation.tone}`}
                  >
                    {isWorking ? 'Working' : presentation.label}
                  </span>
                  {presentation.action ? (
                    <button
                      className={`terminal-button${
                        presentation.tone === 'danger'
                          ? ' terminal-button--primary'
                          : ''
                      }`}
                      data-plaid-item-id={connection.id}
                      data-semantic-id={`settings-account-${connection.id}`}
                      data-semantic-kind={
                        presentation.canDisconnect
                          ? 'settings-account'
                          : 'settings-account-history'
                      }
                      data-semantic-region="workspace"
                      data-status-action={presentation.actionLabel ?? 'view'}
                      data-status-label={`settings / accounts / ${connectionName(connection).toLocaleLowerCase()}`}
                      disabled={isWorking}
                      type="button"
                      onClick={(event) =>
                        void runConnectionAction(
                          connection,
                          presentation.action,
                          event.currentTarget,
                        )
                      }
                    >
                      {isWorking ? 'Working...' : presentation.actionLabel}
                    </button>
                  ) : (
                    <span
                      data-semantic-id={`settings-account-${connection.id}`}
                      data-semantic-kind="settings-account-status"
                      data-semantic-region="workspace"
                      data-status-action="view"
                      data-status-label={`settings / accounts / ${connectionName(connection).toLocaleLowerCase()}`}
                      tabIndex={0}
                    >
                      Syncing...
                    </span>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section
        className="hud-settings-section hud-account-section"
        data-semantic-id="settings-account-section"
        data-semantic-kind="settings-section"
        data-semantic-region="workspace"
        data-status-action="view"
        data-status-label="settings / account"
        ref={accountSectionRef}
        tabIndex={-1}
        aria-labelledby="settings-session-title"
      >
        <header>
          <div>
            <p className="eyebrow">Account</p>
            <h2 id="settings-session-title">Session</h2>
          </div>
        </header>
        <div className="hud-setting-row">
          <div>
            <strong>{email}</strong>
            <small>Signed in as {email.split('@')[0]}</small>
          </div>
          <button
            className="terminal-button"
            data-semantic-id="settings-sign-out"
            data-semantic-kind="settings-sign-out"
            data-semantic-region="workspace"
            data-status-action="sign out"
            data-status-label="settings / account / sign out"
            disabled={isSigningOut}
            type="button"
            onClick={onSignOut}
          >
            {isSigningOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
      </section>

      {(preparingLinkFor || linkRequest) && (
        <div className="transaction-control-layer">
          <section
            aria-labelledby="settings-plaid-dialog-title"
            aria-modal="true"
            className="hud-modal"
            ref={plaidDialogRef}
            role="dialog"
            onKeyDown={trapModalFocus}
          >
            <header>
              <div>
                <p className="eyebrow">Banks and accounts</p>
                <h2 id="settings-plaid-dialog-title">Opening Plaid</h2>
              </div>
              <span className="terminal-pill">Connecting</span>
            </header>
            <div className="hud-modal-body">
              <strong>Preparing a secure connection...</strong>
              <small>Plaid will open when the link token is ready.</small>
            </div>
            <footer>
              <button
                className="terminal-button"
                data-semantic-id="settings-plaid-cancel"
                data-semantic-region="workspace"
                data-status-action="cancel"
                data-status-label="settings / accounts / Plaid"
                type="button"
                onClick={() => {
                  linkGenerationRef.current += 1
                  linkRequestRef.current = null
                  setPreparingLinkFor(null)
                  setLinkRequest(null)
                  restoreActionFocus()
                }}
              >
                Cancel
              </button>
            </footer>
          </section>
        </div>
      )}

      {linkRequest && (
        <PlaidLauncher
          request={linkRequest}
          onExit={handlePlaidExit}
          onSuccess={handlePlaidSuccess}
        />
      )}

      {confirmation && (
        <div className="transaction-control-layer">
          <section
            aria-labelledby="settings-confirm-dialog-title"
            aria-modal="true"
            className="hud-modal"
            ref={confirmationRef}
            role="dialog"
            onKeyDown={trapModalFocus}
          >
            <header>
              <div>
                <p className="eyebrow">{connectionName(confirmation.connection)}</p>
                <h2 id="settings-confirm-dialog-title">
                  {confirmation.kind === 'disconnect'
                    ? 'Disconnect this institution?'
                    : 'Delete imported history?'}
                </h2>
              </div>
              <span className="terminal-pill terminal-pill--danger">
                Destructive
              </span>
            </header>
            <div className="hud-modal-body">
              <strong>
                {confirmation.kind === 'disconnect'
                  ? 'Imported history will remain available.'
                  : 'Transactions imported from this connection will be deleted.'}
              </strong>
              <small>
                {confirmation.kind === 'disconnect'
                  ? 'The institution will stop syncing until it is connected again.'
                  : 'Budgets and reports will update immediately. This cannot be undone.'}
              </small>
            </div>
            <footer>
              <button
                className="terminal-button"
                data-semantic-id="settings-confirm-cancel"
                data-semantic-region="workspace"
                data-status-action="cancel"
                data-status-label="settings / accounts / confirmation"
                type="button"
                onClick={closeConfirmation}
              >
                {confirmation.kind === 'disconnect'
                  ? 'Keep connection'
                  : 'Keep history'}
              </button>
              <button
                className="terminal-button terminal-button--danger"
                data-confirm-primary="true"
                data-semantic-id="settings-confirm-primary"
                data-semantic-region="workspace"
                data-status-action="confirm"
                data-status-label="settings / accounts / confirmation"
                type="button"
                onClick={() => void confirmDestructiveAction()}
              >
                {confirmation.kind === 'disconnect'
                  ? 'Disconnect'
                  : 'Delete history'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  )
}

function PlaidLauncher({
  request,
  onExit,
  onSuccess,
}: {
  request: LinkRequest
  onExit: PlaidLinkOnExit
  onSuccess: PlaidLinkOnSuccess
}) {
  const didOpenRef = useRef(false)
  const { open, ready } = usePlaidLink({
    token: request.token,
    onExit,
    onSuccess,
  })

  useEffect(() => {
    if (!ready || didOpenRef.current) {
      return
    }
    didOpenRef.current = true
    open()
  }, [open, ready])

  return null
}

async function invokeFunction<T = Record<string, unknown>>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await getSupabaseClient().functions.invoke<T>(name, {
    body,
  })
  if (error) {
    let message = error.message
    if (
      typeof error === 'object' &&
      error !== null &&
      'context' in error &&
      error.context instanceof Response
    ) {
      try {
        const response: unknown = await error.context.clone().json()
        if (
          typeof response === 'object' &&
          response !== null &&
          'error' in response &&
          typeof response.error === 'string'
        ) {
          message = response.error
        }
      } catch {
        // Keep the transport message when the response is not JSON.
      }
    }
    throw new Error(message)
  }
  if (data === null) {
    throw new Error('The bank operation returned no response.')
  }
  return data
}

function errorMessageFrom(error: unknown, fallback: string): string {
  if (
    !(error instanceof Error) ||
    !error.message ||
    error.message.includes('Edge Function returned a non-2xx status code')
  ) {
    return fallback
  }
  return error.message
}

function connectionName(connection: PlaidConnection): string {
  return connection.institution_name?.trim() || 'Connected institution'
}

function connectionInitials(connection: PlaidConnection): string {
  return connectionName(connection)
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toLocaleUpperCase()
}

function connectionDetails(connection: PlaidConnection): string {
  const accounts =
    connection.accountNames.length === 0
      ? 'No imported accounts yet'
      : connection.accountNames.length <= 2
        ? connection.accountNames.join(' and ')
        : `${connection.accountNames.length} accounts`
  if (connection.status === 'needs_reconnect') {
    return `${accounts} · Login required`
  }
  if (connection.status === 'error') {
    return `${accounts} · Sync failed`
  }
  if (connection.status === 'disconnected') {
    return `${accounts} · Disconnected`
  }
  if (!connection.last_synced_at) {
    return `${accounts} · Syncing`
  }
  return `${accounts} · Synced ${formatLastSynced(connection.last_synced_at)}`
}

function formatLastSynced(value: string): string {
  const elapsedMinutes = Math.round(
    (new Date(value).getTime() - Date.now()) / 60_000,
  )
  if (Math.abs(elapsedMinutes) < 60) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
      elapsedMinutes,
      'minute',
    )
  }
  const elapsedHours = Math.round(elapsedMinutes / 60)
  if (Math.abs(elapsedHours) < 24) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
      elapsedHours,
      'hour',
    )
  }
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
  }).format(new Date(value))
}