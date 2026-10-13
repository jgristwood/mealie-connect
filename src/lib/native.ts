import { Browser } from '@capacitor/browser'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { Keyboard, KeyboardResize } from '@capacitor/keyboard'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import type { ResolvedMode } from '../types/mealie'

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform()
}

export function isAndroidPlatform(): boolean {
  return Capacitor.getPlatform() === 'android'
}

/** Status bar matches the page background so it blends with the header. */
const STATUS_BAR_COLORS: Record<ResolvedMode, string> = {
  light: '#faf6ef',
  dark: '#12100e',
}

export async function configureNativeUi(mode: ResolvedMode): Promise<void> {
  if (!isNativePlatform()) return

  if (isAndroidPlatform()) {
    document.documentElement.classList.add('native-android')
  }

  await applyNativeTheme(mode)

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

export async function applyNativeTheme(mode: ResolvedMode): Promise<void> {
  if (!isNativePlatform()) return

  const isDark = mode === 'dark'
  const color = STATUS_BAR_COLORS[mode]

  try {
    await StatusBar.setBackgroundColor({ color })
    // Style.Dark = light icons for dark backgrounds; Style.Light = dark icons.
    await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light })
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
