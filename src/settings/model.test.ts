import { describe, expect, it } from 'vitest'
import { connectionPresentation, resolveTheme } from './model.ts'

describe('Settings model', () => {
  it('resolves explicit and system theme preferences', () => {
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
  })

  it('offers sync for an active connection', () => {
    expect(connectionPresentation('active')).toEqual({
      label: 'Active',
      tone: 'ok',
      action: 'sync',
      actionLabel: 'Sync now',
      canDisconnect: true,
    })
  })

  it('offers repair and retry for recoverable connection states', () => {
    expect(connectionPresentation('needs_reconnect')).toMatchObject({
      action: 'reconnect',
      actionLabel: 'Repair link',
      canDisconnect: true,
    })
    expect(connectionPresentation('error')).toMatchObject({
      action: 'retry',
      actionLabel: 'Try again',
      canDisconnect: true,
    })
  })

  it('does not expose invalid actions while syncing or disconnected', () => {
    expect(connectionPresentation('initial_syncing')).toMatchObject({
      action: null,
      canDisconnect: false,
    })
    expect(connectionPresentation('disconnected')).toMatchObject({
      action: 'delete-history',
      actionLabel: 'Delete history',
      canDisconnect: false,
    })
  })
})