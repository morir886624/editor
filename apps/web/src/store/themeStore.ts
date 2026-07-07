// ---------------------------------------------------------------------------
// Theme (dark / light) store — Zustand, matches the app's many-small-stores
// convention (exportStore, splitStore, …). Purely UI, never part of the
// document / undo-redo.
//
// The single source of truth for the palette is CSS: `:root` is dark, and
// `:root[data-theme='light']` overrides the variables. This store just flips
// that attribute on <html>, persists the choice, and exposes it to React.
//
// Initial value is resolved and APPLIED at module load (before React renders)
// so there's no dark→light flash for users who prefer/last-picked light.
// ---------------------------------------------------------------------------

import { create } from 'zustand';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'editor-theme';

function readInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* private mode / storage blocked — fall through to OS preference */
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

const initialTheme = readInitialTheme();
applyTheme(initialTheme);

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialTheme,
  setTheme: (theme) => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore persistence failure — the in-memory choice still applies */
    }
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));
