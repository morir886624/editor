// ---------------------------------------------------------------------------
// FFmpeg load-status store (Zustand).
//
// Drives the "loading video engine…" UI. Kept separate from the editor
// document store because it is transient runtime status, not part of the
// project and not something undo/redo should ever touch.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import { loadFFmpeg } from '../lib/ffmpeg';

export type FFmpegStatus = 'idle' | 'loading' | 'ready' | 'error';

interface FFmpegState {
  status: FFmpegStatus;
  error: string | null;
  /** Idempotently load the wasm core, updating status as it progresses. */
  ensureLoaded: () => Promise<void>;
}

export const useFFmpegStore = create<FFmpegState>((set, get) => ({
  status: 'idle',
  error: null,
  ensureLoaded: async () => {
    const { status } = get();
    if (status === 'ready') return;
    if (status !== 'loading') set({ status: 'loading', error: null });
    try {
      await loadFFmpeg();
      set({ status: 'ready', error: null });
    } catch (e) {
      set({
        status: 'error',
        error: e instanceof Error ? e.message : 'Failed to load the video engine.',
      });
    }
  },
}));
