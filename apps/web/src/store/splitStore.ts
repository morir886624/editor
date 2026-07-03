// ---------------------------------------------------------------------------
// "Split into shorts" UI store (Zustand).
//
// Transient runtime status for the split dialog — like exportStore, never
// part of the document / undo-redo. Segments stream in as they are cut so
// the list fills live.
//
// Object-URL lifecycle: each result owns its url; urls of a PREVIOUS run are
// revoked when a new run starts (or the store is cleared). Importing a
// segment into the editor must therefore create a fresh URL from seg.file —
// clip URLs are never revoked (undo), result URLs are.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import {
  runSplit,
  SplitCancelledError,
  type SplitSegment,
} from '../lib/splitter';
import type { CancelToken } from '../lib/exporter';
import { resetFFmpeg } from '../lib/ffmpeg';
import { useFFmpegStore } from './ffmpegStore';

export type SplitStatus = 'idle' | 'running' | 'done' | 'error';

interface SplitState {
  isOpen: boolean;
  status: SplitStatus;
  phase: string;
  progress: number; // 0..1
  segmentsDone: number;
  segmentsTotal: number;
  segments: SplitSegment[];
  error: string | null;

  open: () => void;
  close: () => void;
  start: (file: File, sourceDuration: number, segmentLength: number) => Promise<void>;
  cancel: () => void;
}

let activeToken: CancelToken | null = null;

const revokeAll = (segments: SplitSegment[]) => {
  for (const s of segments) URL.revokeObjectURL(s.url);
};

export const useSplitStore = create<SplitState>((set, get) => ({
  isOpen: false,
  status: 'idle',
  phase: '',
  progress: 0,
  segmentsDone: 0,
  segmentsTotal: 0,
  segments: [],
  error: null,

  open: () => set({ isOpen: true }),

  close: () => {
    if (get().status === 'running') return; // cancel first
    set({ isOpen: false });
  },

  start: async (file, sourceDuration, segmentLength) => {
    if (get().status === 'running') return;

    revokeAll(get().segments); // previous run's results

    const token: CancelToken = { cancelled: false };
    activeToken = token;
    set({
      status: 'running',
      phase: 'Starting…',
      progress: 0,
      segmentsDone: 0,
      segmentsTotal: 0,
      segments: [],
      error: null,
    });

    try {
      await runSplit(
        file,
        sourceDuration,
        segmentLength,
        ({ phase, progress, segmentsDone, segmentsTotal }) => {
          if (activeToken === token && !token.cancelled) {
            set({ phase, progress, segmentsDone, segmentsTotal });
          }
        },
        token,
        (segment) => {
          if (activeToken === token && !token.cancelled) {
            set({ segments: [...get().segments, segment] });
          }
        },
      );
      if (token.cancelled) return; // cancel() already reset the state
      set({ status: 'done', phase: 'Done', progress: 1 });
    } catch (e) {
      if (token.cancelled || e instanceof SplitCancelledError) return;
      set({
        status: 'error',
        error: e instanceof Error ? e.message : 'Splitting failed.',
      });
    }
  },

  cancel: () => {
    if (get().status !== 'running') return;
    if (activeToken) activeToken.cancelled = true;
    // Kill the worker so the in-flight cut stops NOW; the WORKERFS mount and
    // MEMFS die with it. Segments already produced are KEPT (they're useful).
    resetFFmpeg();
    useFFmpegStore.setState({ status: 'idle', error: null });
    const produced = get().segments.length;
    set({
      status: produced > 0 ? 'done' : 'idle',
      phase: produced > 0 ? `Stopped after ${produced} short${produced > 1 ? 's' : ''}` : '',
      progress: 0,
    });
  },
}));
