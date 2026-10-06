import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import '@web/index.css'
import './mobile.css'
import App from '@web/App.tsx'
import { setPlatform } from '@web/lib/platform'
import { nativePlatform } from './native/platform'
import { initNativeShell } from './native/shell'

// Same editor as apps/web — only the platform glue differs. Install it before
// the first render so every component reads the native implementation. In a
// plain browser (`pnpm start` for quick UI checks) the web defaults stay.
if (Capacitor.isNativePlatform()) {
  setPlatform(nativePlatform)
  initNativeShell()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
