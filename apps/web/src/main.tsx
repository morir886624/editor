import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useInstallStore, type BeforeInstallPromptEvent } from './store/installStore.ts'

// Capture the PWA install prompt at module scope: `beforeinstallprompt` can
// fire before React mounts, so an effect-based listener would miss it. We stash
// the event and surface it later via <InstallPrompt />.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  useInstallStore.getState().setDeferred(e as BeforeInstallPromptEvent)
})
window.addEventListener('appinstalled', () => {
  useInstallStore.getState().setInstalled()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
