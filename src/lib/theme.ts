import type { AccentName, ResolvedMode, ThemeMode } from '../types/mealie'
import { applyNativeTheme } from './native'

const MODE_KEY = 'mealie-connect-theme-mode'
const ACCENT_KEY = 'mealie-connect-accent'
/** Pre-redesign single theme setting, migrated on first load. */
const LEGACY_THEME_KEY = 'mealie-connect-theme'

export const DEFAULT_MODE: ThemeMode = 'light'
export const DEFAULT_ACCENT: AccentName = 'purple'

export const THEME_MODES: { id: ThemeMode; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

export const ACCENTS: { id: AccentName; label: string; swatch: string }[] = [
  { id: 'purple', label: 'Plum', swatch: '#7c3aed' },
  { id: 'blue', label: 'Blue', swatch: '#2f5fae' },
  { id: 'red', label: 'Terracotta', swatch: '#c2553a' },
  { id: 'green', label: 'Sage', swatch: '#3d7a53' },
]

export interface ThemePreference {
  mode: ThemeMode
  accent: AccentName
}

function isMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

function isAccent(value: string | null): value is AccentName {
  return value === 'purple' || value === 'blue' || value === 'red' || value === 'green'
}

/** Maps the old five themes onto mode + accent so each user keeps the look
 * they picked: Purple was the light theme; Blue, Red, Green and Dark were dark. */
function migrateLegacyTheme(legacy: string | null): ThemePreference | null {
  switch (legacy) {
    case 'purple': return { mode: 'light', accent: 'purple' }
    case 'blue': return { mode: 'dark', accent: 'blue' }
    case 'red': return { mode: 'dark', accent: 'red' }
    case 'green': return { mode: 'dark', accent: 'green' }
    case 'dark': return { mode: 'dark', accent: 'purple' }
    default: return null
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore storage failures (e.g. private browsing); the theme still applies for this session.
  }
}

export function getStoredTheme(): ThemePreference {
  const mode = safeGet(MODE_KEY)
  const accent = safeGet(ACCENT_KEY)
  if (isMode(mode) || isAccent(accent)) {
    return { mode: isMode(mode) ? mode : DEFAULT_MODE, accent: isAccent(accent) ? accent : DEFAULT_ACCENT }
  }
  const migrated = migrateLegacyTheme(safeGet(LEGACY_THEME_KEY))
  if (migrated) {
    safeSet(MODE_KEY, migrated.mode)
    safeSet(ACCENT_KEY, migrated.accent)
    return migrated
  }
  return { mode: DEFAULT_MODE, accent: DEFAULT_ACCENT }
}

const systemDarkQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

export function resolveMode(mode: ThemeMode): ResolvedMode {
  if (mode === 'system') return systemDarkQuery?.matches ? 'dark' : 'light'
  return mode
}

/** Applies the theme to the document immediately, without a page reload. */
export function applyTheme(preference: ThemePreference): void {
  const resolved = resolveMode(preference.mode)
  const root = document.documentElement
  root.setAttribute('data-mode', resolved)
  root.setAttribute('data-accent', preference.accent)
  void applyNativeTheme(resolved)
}

export function setTheme(preference: ThemePreference): void {
  safeSet(MODE_KEY, preference.mode)
  safeSet(ACCENT_KEY, preference.accent)
  applyTheme(preference)
}

/** Reads and applies the persisted theme, and follows the OS setting while
 * the mode is "System". Call once on app startup. */
export function initTheme(): ResolvedMode {
  const preference = getStoredTheme()
  applyTheme(preference)
  systemDarkQuery?.addEventListener('change', () => {
    const current = getStoredTheme()
    if (current.mode === 'system') applyTheme(current)
  })
  return resolveMode(preference.mode)
}
