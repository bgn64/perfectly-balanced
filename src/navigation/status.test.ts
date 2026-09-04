import { describe, expect, it } from 'vitest'
import { buildNavigationStatus, textEntryStatus } from './status.ts'

describe('statusline presentation', () => {
  it('does not advertise spatial navigation while text entry owns focus', () => {
    expect(
      buildNavigationStatus({
        view: 'transactions',
        action: 'search',
        label: 'merchant:cedar',
        semanticKind: 'transaction-search',
        isTextEntry: true,
      }),
    ).toEqual({ mode: 'INPUT', label: 'merchant:cedar', shortcuts: [] })

    expect(
      textEntryStatus('SEARCH', 'merchant:cedar', [
        { keys: ['Enter'], label: 'focus first result' },
        { keys: ['Esc'], label: 'clear and return' },
      ]).shortcuts,
    ).not.toContainEqual({ keys: ['h', 'j', 'k', 'l'], label: 'focus' })
  })

  it('shows row actions only for a focused transaction row', () => {
    expect(
      buildNavigationStatus({
        view: 'transactions',
        action: 'select transaction',
        label: 'transaction / Cedar Cafe',
        semanticKind: 'transaction-row',
        isTextEntry: false,
      }).shortcuts,
    ).toEqual([
      { keys: ['/'], label: 'search' },
      { keys: ['c'], label: 'category' },
      { keys: ['t'], label: 'status' },
      { keys: ['Enter'], label: 'select transaction' },
      { keys: ['h', 'j', 'k', 'l'], label: 'focus' },
    ])
  })

  it('omits Enter for read-only report rows', () => {
    const status = buildNavigationStatus({
      view: 'insights',
      action: 'view',
      label: 'reports / under budget / Groceries',
      semanticKind: 'report-variance',
      isTextEntry: false,
    })

    expect(status.shortcuts).toEqual([
      { keys: ['h', 'j', 'k', 'l'], label: 'focus' },
    ])
  })

  it('shows Enter only when a Budget row child has its own action', () => {
    const directRow = buildNavigationStatus({
      view: 'budgets',
      action: 'amount',
      label: 'budget / Groceries',
      semanticKind: 'budget-row',
      isTextEntry: false,
    })
    const amountButton = buildNavigationStatus({
      view: 'budgets',
      action: 'edit amount',
      label: 'budget / Groceries',
      semanticKind: 'budget-row',
      isTextEntry: false,
    })

    expect(directRow.shortcuts).not.toContainEqual({
      keys: ['Enter'],
      label: 'amount',
    })
    expect(amountButton.shortcuts).toContainEqual({
      keys: ['Enter'],
      label: 'edit amount',
    })
  })

  it('shows both ways to create the first Budget item', () => {
    expect(
      buildNavigationStatus({
        view: 'budgets',
        action: 'choose category',
        label: 'budget / add first item',
        semanticKind: 'budget-first-item',
        isTextEntry: false,
      }).shortcuts,
    ).toEqual([
      { keys: ['n'], label: 'new' },
      { keys: ['Enter'], label: 'choose category' },
      { keys: ['h', 'j', 'k', 'l'], label: 'focus' },
      { keys: [':'], label: 'command' },
    ])
  })

  it('shows disconnect only for a focused account', () => {
    expect(
      buildNavigationStatus({
        view: 'settings',
        action: 'sync now',
        label: 'settings / accounts / Local Bank',
        semanticKind: 'settings-account',
        isTextEntry: false,
      }),
    ).toEqual({
      mode: 'SETTINGS',
      label: 'settings / accounts / Local Bank',
      shortcuts: [
        { keys: ['Enter'], label: 'sync now' },
        { keys: ['d'], label: 'disconnect' },
        { keys: ['h', 'j', 'k', 'l'], label: 'focus' },
      ],
    })
  })
})