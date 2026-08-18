import { Browser } from '@capacitor/browser'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { Keyboard, KeyboardResize } from '@capacitor/keyboard'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import type { ThemeName } from '../types/mealie'

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform()
}

export function isAndroidPlatform(): boolean {
  return Capacitor.getPlatform() === 'android'
}

const STATUS_BAR_COLORS: Record<ThemeName, string> = {
  purple: '#713a72',
  blue: '#2f5fae',
  red: '#b1443b',
  green: '#3d7a53',
  dark: '#1c1a20',
}

export async function configureNativeUi(theme: ThemeName): Promise<void> {
  if (!isNativePlatform()) return

  if (isAndroidPlatform()) {
    document.documentElement.classList.add('native-android')
  }

  await applyNativeTheme(theme)

  try {
    await StatusBar.setOverlaysWebView({ overlay: false })
  } catch (error) {
    console.warn('Unable to configure status bar overlay.', error)
  }

  if (!isAndroidPlatform()) {
    try {
      await Keyboard.setResizeMode({ mode: KeyboardResize.Body })
    } catch (error) {
      console.warn('Unable to configure keyboard resize mode.', error)
    }
  }

  try {
    await SplashScreen.hide()
  } catch (error) {
    console.warn('Unable to configure splash screen.', error)
  }
}

export async function applyNativeTheme(theme: ThemeName): Promise<void> {
  if (!isNativePlatform()) return

  const isDark = theme === 'dark'
  const color = STATUS_BAR_COLORS[theme]

  try {
    await StatusBar.setBackgroundColor({ color })
    await StatusBar.setStyle({ style: isDark ? Style.Light : Style.Dark })
  } catch (error) {
    console.warn('Unable to apply native theme colors.', error)
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isNativePlatform()) {
    await Browser.open({ url })
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

export function isExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin)
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin !== window.location.origin
  } catch {
    return false
  }
}

export async function removeNativeListener(listener: PluginListenerHandle | undefined): Promise<void> {
  if (!listener) return
  await listener.remove()
}
