// ---------------------------------------------------------------------------
// Native shell lifecycle: hardware back button, system-bar contrast that
// follows the editor's light/dark theme, and housekeeping of staged files.
// ---------------------------------------------------------------------------

import { SystemBars, SystemBarsStyle } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { handleBack } from '@web/lib/backStack'
import { STAGING_DIR } from './platform'

/** Back closes the topmost sheet/dialog; with nothing open, background the
 *  app instead of finishing the activity, so an unsaved edit survives. */
function wireBackButton(): void {
  void App.addListener('backButton', () => {
    if (!handleBack()) void App.minimizeApp()
  })
}

/** Keep status/navigation-bar icons legible against the editor's theme
 *  (themeStore writes `data-theme` on <html>; index.html sets it pre-paint). */
function syncSystemBars(): void {
  const apply = () => {
    const light = document.documentElement.getAttribute('data-theme') === 'light'
    // DARK = light icons for a dark background, and vice versa.
    void SystemBars.setStyle({ style: light ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(
      () => {},
    )
  }
  apply()
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
}

/** Staged export/share copies from a previous session are never needed again. */
async function clearStaging(): Promise<void> {
  try {
    await Filesystem.rmdir({ path: STAGING_DIR, directory: Directory.Cache, recursive: true })
  } catch {
    /* nothing staged yet */
  }
}

export function initNativeShell(): void {
  document.documentElement.classList.add('is-native')
  wireBackButton()
  syncSystemBars()
  void clearStaging()
}
