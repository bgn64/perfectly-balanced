export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

export type PlaidConnectionStatus =
  | 'initial_syncing'
  | 'active'
  | 'needs_reconnect'
  | 'error'
  | 'disconnected'

export type PlaidConnectionAction =
  | 'sync'
  | 'reconnect'
  | 'retry'
  | 'delete-history'
  | null

export interface PlaidConnectionPresentation {
  label: string
  tone: 'ok' | 'warning' | 'danger' | 'muted'
  action: PlaidConnectionAction
  actionLabel: string | null
  canDisconnect: boolean
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersLight: boolean,
): ResolvedTheme {
  if (preference === 'system') {
    return systemPrefersLight ? 'light' : 'dark'
  }
  return preference
}

export function connectionPresentation(
  status: PlaidConnectionStatus,
): PlaidConnectionPresentation {
  switch (status) {
    case 'initial_syncing':
      return {
        label: 'Syncing',
        tone: 'warning',
        action: null,
        actionLabel: null,
        canDisconnect: false,
      }
    case 'active':
      return {
        label: 'Active',
        tone: 'ok',
        action: 'sync',
        actionLabel: 'Sync now',
        canDisconnect: true,
      }
    case 'needs_reconnect':
      return {
        label: 'Reconnect',
        tone: 'danger',
        action: 'reconnect',
        actionLabel: 'Repair link',
        canDisconnect: true,
      }
    case 'error':
      return {
        label: 'Error',
        tone: 'danger',
        action: 'retry',
        actionLabel: 'Try again',
        canDisconnect: true,
      }
    case 'disconnected':
      return {
        label: 'Disconnected',
        tone: 'muted',
        action: 'delete-history',
        actionLabel: 'Delete history',
        canDisconnect: false,
      }
  }
}