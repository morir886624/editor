// ---------------------------------------------------------------------------
// "Split into shorts" UI store (Zustand).
//
// Transient runtime status for the split dialog — like exportStore, never
// part of the document / undo-redo. Segments stream in as they are cut so
// the list fills live.
//
// The picked SOURCE (the original long video) also lives here — not in the
// dialog — so it survives closing/reopening the dialog: the "adjust" flow
// needs the original File to re-cut a segment with better bounds after the
// user noticed (while editing) that the blind cut landed mid-sentence.
//
// Object-URL lifecycle: each result owns its url; urls of a PREVIOUS run are
// revoked when a new run starts (or the source is replaced). Importing a
// segment into the editor must therefore create a fresh URL from seg.file —
// clip URLs are never revoked (undo), result URLs are.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import {
  recutSegment,
  runSplit,
  SplitCancelledError,
  type SplitSegment,
} from '../lib/splitter';
import type { CancelToken } from '../lib/exporter';
import { resetFFmpeg } from '../lib/ffmpeg';
import { useFFmpegStore } from './ffmpegStore';

export type SplitStatus = 'idle' | 'running' | 'done' | 'error';

/** The original long video the shorts are cut from. */
export interface SplitSource {
  file: File;
  duration: number; // seconds
  /** Object URL — owned by this store; revoked when the source is replaced. */
  url: string;
}

interface SplitState {
  isOpen: boolean;
  status: SplitStatus;
  phase: string;
  progress: number; // 0..1
  segmentsDone: number;
  segmentsTotal: number;
  segments: SplitSegment[];
  source: SplitSource | null;
  error: string | null;

  open: () => void;
  close: () => void;
  /** Replace the picked source. Clears previous results — segments only make
   *  sense against the source that produced them (the adjust flow re-cuts
   *  from the CURRENT source). */
  setSource: (source: SplitSource) => void;
  start: (segmentLength: number) => Promise<void>;
  /** Re-cut segment `index` to [start, end] seconds of the source (the
   *  "adjust framing" flow). Resolves true when the segment was replaced. */
  recut: (index: number, start: number, end: number) => Promise<boolean>;
  /** Cut a one-off [start, end] window of the source for segment `index` —
   *  used by "Edit" to hand the editor a MARGIN-padded copy of a short (so
   *  trim/slip can recover speech the blind cut clipped). Does NOT touch the
   *  results list; the caller owns the returned segment (and its url). */
  cutForEdit: (index: number, start: number, end: number) => Promise<SplitSegment | null>;
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
  source: null,
  error: null,

  open: () => set({ isOpen: true }),

  close: () => {
    if (get().status === 'running') return; // cancel first
    set({ isOpen: false });
  },

  setSource: (source) => {
    const s = get();
    if (s.status === 'running') {
      URL.revokeObjectURL(source.url); // UI prevents this; don't leak anyway
      return;
    }
    if (s.source) URL.revokeObjectURL(s.source.url);
    revokeAll(s.segments);
    set({
      source,
      segments: [],
      status: 'idle',
      phase: '',
      progress: 0,
      segmentsDone: 0,
      segmentsTotal: 0,
      error: null,
    });
  },

  start: async (segmentLength) => {
    const { source, status, segments } = get();
    if (!source || status === 'running') return;

    revokeAll(segments); // previous run's results

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
        source.file,
        source.duration,
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

  recut: async (index, start, end) => {
    const { source, status, segments } = get();
    if (!source || status === 'running') return false;
    const old = segments.find((s) => s.index === index);
    if (!old) return false;

    const token: CancelToken = { cancelled: false };
    activeToken = token;
    const phase = `Re-cutting short ${index + 1}…`;
    set({ status: 'running', phase, progress: 0, error: null });

    try {
      const next = await recutSegment(
        source.file,
        source.duration,
        start,
        end,
        index,
        old.filename,
        token,
        (fraction) => {
          if (activeToken === token && !token.cancelled) set({ progress: fraction });
        },
      );
      if (token.cancelled) return false;
      URL.revokeObjectURL(old.url);
      set({
        segments: get().segments.map((s) => (s.index === index ? next : s)),
        status: 'done',
        phase: 'Done',
        progress: 1,
      });
      return true;
    } catch (e) {
      if (token.cancelled || e instanceof SplitCancelledError) return false;
      set({
        status: 'error',
        error: e instanceof Error ? e.message : 'Re-cutting failed.',
      });
      return false;
    }
  },

  cutForEdit: async (index, start, end) => {
    const { source, status, segments } = get();
    if (!source || status === 'running') return null;
    const seg = segments.find((s) => s.index === index);
    if (!seg) return null;
    const statusBefore = status;

    const token: CancelToken = { cancelled: false };
    activeToken = token;
    set({
      status: 'running',
      phase: `Preparing short ${index + 1} for the editor…`,
      progress: 0,
      error: null,
    });

    try {
      const padded = await recutSegment(
        source.file,
        source.duration,
        start,
        end,
        index,
        seg.filename,
        token,
        (fraction) => {
          if (activeToken === token && !token.cancelled) set({ progress: fraction });
        },
      );
      if (token.cancelled) return null;
      set({ status: statusBefore, phase: '', progress: 0 });
      return padded;
    } catch (e) {
      if (token.cancelled || e instanceof SplitCancelledError) return null;
      set({
        status: 'error',
        error: e instanceof Error ? e.message : 'Preparing the short failed.',
      });
      return null;
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
