import {
  useEffect,
  useLayoutEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from './settings/model.ts'

export const themePreferenceKey = 'perfectly-balanced.theme'

const themeColors: Record<ResolvedTheme, string> = {
  dark: '#16161e',
  light: '#d5d6db',
}

export function readThemePreference(
  storage: Pick<Storage, 'getItem'>,
): ThemePreference {
  try {
    const savedTheme = storage.getItem(themePreferenceKey)
    if (
      savedTheme === 'dark' ||
      savedTheme === 'light' ||
      savedTheme === 'system'
    ) {
      return savedTheme
    }
  } catch {
    return 'system'
  }

  return 'system'
}

export function applyDocumentTheme(
  theme: ResolvedTheme,
  targetDocument: Document = document,
) {
  targetDocument.documentElement.dataset.theme = theme
  const themeColor = targetDocument.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )
  if (themeColor) {
    themeColor.content = themeColors[theme]
  }
}

export function initializeDocumentTheme(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
  systemPrefersLight = window.matchMedia('(prefers-color-scheme: light)').matches,
  targetDocument: Document = document,
): ThemePreference {
  const preference = readThemePreference(storage)
  applyDocumentTheme(
    resolveTheme(preference, systemPrefersLight),
    targetDocument,
  )
  return preference
}

export function useThemePreference(): {
  themePreference: ThemePreference
  setThemePreference: Dispatch<SetStateAction<ThemePreference>>
} {
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(() => readThemePreference(window.localStorage))
  const [systemPrefersLight, setSystemPrefersLight] = useState(() =>
    window.matchMedia('(prefers-color-scheme: light)').matches,
  )
  const theme = resolveTheme(themePreference, systemPrefersLight)

  useEffect(() => {
    try {
      window.localStorage.setItem(themePreferenceKey, themePreference)
    } catch {
      // The active preference still applies when browser storage is unavailable.
    }
  }, [themePreference])

  useLayoutEffect(() => {
    applyDocumentTheme(theme)
  }, [theme])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const updateSystemPreference = () => setSystemPrefersLight(media.matches)
    media.addEventListener('change', updateSystemPreference)
    return () => media.removeEventListener('change', updateSystemPreference)
  }, [])

  return { themePreference, setThemePreference }
}