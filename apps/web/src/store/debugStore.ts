// ---------------------------------------------------------------------------
// Store-debug panel visibility — Zustand, matches the app's many-small-stores
// convention (exportStore, splitStore, themeStore…). Purely UI, never part of
// the document / undo-redo.
//
// The debug panel is a floating dev window; unlike the Dockview panels it lives
// at app level, so its open/closed state can't ride the dock layout. This store
// gives it the same "closeable, reopenable, remembered" behaviour: a ✕ in its
// header closes it, the toolbar's Panels menu reopens it, and the choice is
// persisted to localStorage.
// ---------------------------------------------------------------------------

import { create } from 'zustand';

const STORAGE_KEY = 'editor-debug-open';

function readInitialOpen(): boolean {
  try {
    // Default: open (previous behaviour) unless the user closed it last time.
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true; // storage blocked — fall back to the historical default
  }
}

interface DebugState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useDebugStore = create<DebugState>((set, get) => ({
  open: readInitialOpen(),
  setOpen: (open) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(open));
    } catch {
      /* ignore persistence failure — the in-memory choice still applies */
    }
    set({ open });
  },
  toggle: () => get().setOpen(!get().open),
}));
