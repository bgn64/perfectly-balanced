import { describe, expect, it } from 'vitest'
import {
  applyDocumentTheme,
  initializeDocumentTheme,
  readThemePreference,
  themePreferenceKey,
} from './theme.ts'

function createDocumentTarget() {
  const documentElement = { dataset: {} as DOMStringMap }
  const themeColor = { content: '' }
  const targetDocument = {
    documentElement,
    querySelector: () => themeColor,
  } as unknown as Document

  return { documentElement, targetDocument, themeColor }
}

describe('theme', () => {
  it('reads supported preferences and falls back to system', () => {
    expect(
      readThemePreference({ getItem: () => 'light' }),
    ).toBe('light')
    expect(
      readThemePreference({ getItem: () => 'sepia' }),
    ).toBe('system')
    expect(
      readThemePreference({
        getItem: () => {
          throw new Error('Storage unavailable')
        },
      }),
    ).toBe('system')
  })

  it('applies the resolved theme and browser color', () => {
    const { documentElement, targetDocument, themeColor } =
      createDocumentTarget()

    applyDocumentTheme('light', targetDocument)

    expect(documentElement.dataset.theme).toBe('light')
    expect(themeColor.content).toBe('#eef3f9')
  })

  it('initializes system preference before the application renders', () => {
    const { documentElement, targetDocument, themeColor } =
      createDocumentTarget()
    const storage = {
      getItem: (key: string) => key === themePreferenceKey ? 'system' : null,
    }

    expect(initializeDocumentTheme(storage, false, targetDocument)).toBe('system')
    expect(documentElement.dataset.theme).toBe('dark')
    expect(themeColor.content).toBe('#16161e')
  })
})