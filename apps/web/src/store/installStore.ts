// ---------------------------------------------------------------------------
// PWA install state. `beforeinstallprompt` can fire before React mounts, so
// main.tsx captures the event at module scope and stashes it here; the
// InstallPrompt component subscribes rather than registering its own listener
// (an effect-based listener would miss an early event). Not part of the
// editor document.
// ---------------------------------------------------------------------------

import { create } from 'zustand';

/** Chrome-only event — not in the standard DOM lib types. */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt: () => Promise<void>;
}

const DISMISS_KEY = 'editor-install-dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

interface InstallState {
  /** The deferred native prompt, once the browser has offered one. */
  deferred: BeforeInstallPromptEvent | null;
  /** True after the app is installed (via our button or the browser UI). */
  installed: boolean;
  /** True once the user dismisses the banner (persisted so we don't nag). */
  dismissed: boolean;
  setDeferred: (e: BeforeInstallPromptEvent) => void;
  setInstalled: () => void;
  dismiss: () => void;
}

export const useInstallStore = create<InstallState>((set) => ({
  deferred: null,
  installed: false,
  dismissed: readDismissed(),
  setDeferred: (e) => set({ deferred: e }),
  setInstalled: () => set({ installed: true, deferred: null }),
  dismiss: () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* localStorage may be unavailable (private mode) — dismiss for the session only */
    }
    set({ dismissed: true });
  },
}));
