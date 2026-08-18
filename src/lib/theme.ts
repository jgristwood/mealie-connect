import type { ThemeName } from '../types/mealie'
import { applyNativeTheme } from './native'

const THEME_KEY = 'mealie-connect-theme'
export const DEFAULT_THEME: ThemeName = 'purple'

export const THEMES: { id: ThemeName; label: string; swatch: string }[] = [
  { id: 'purple', label: 'Purple', swatch: '#713a72' },
  { id: 'blue', label: 'Blue', swatch: '#2f5fae' },
  { id: 'red', label: 'Red', swatch: '#b1443b' },
  { id: 'green', label: 'Green', swatch: '#3d7a53' },
  { id: 'dark', label: 'Dark', swatch: '#1c1a20' },
]

function isThemeName(value: string | null): value is ThemeName {
  return value === 'purple' || value === 'blue' || value === 'red' || value === 'green' || value === 'dark'
}

export function getStoredTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return isThemeName(stored) ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/** Applies the theme to the document immediately, without a page reload. */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute('data-theme', theme)
}

export function setTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Ignore storage failures (e.g. private browsing); theme still applies for this session.
  }
  applyTheme(theme)
  void applyNativeTheme(theme)
}

/** Reads and applies the persisted theme. Call once on app startup. */
export function initTheme(): ThemeName {
  const theme = getStoredTheme()
  applyTheme(theme)
  void applyNativeTheme(theme)
  return theme
}
