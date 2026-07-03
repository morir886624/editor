// ---------------------------------------------------------------------------
// Export UI store (Zustand).
//
// Transient runtime status for the export dialog — like ffmpegStore, this is
// not part of the document and never touches undo/redo. One export can run at
// a time; its progress/phase stream in from the exporter callback.
//
// Cancellation: flips the run's token AND kills the wasm worker via
// resetFFmpeg() so a long exec aborts immediately. The worker's MEMFS dies
// with it; the next ffmpeg use (thumbnails or another export) reloads the
// core, so ffmpegStore's status is reset to reflect that.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import {
  runExport,
  ExportCancelledError,
  type CancelToken,
  type ExportOptions,
} from '../lib/exporter';
import { resetFFmpeg } from '../lib/ffmpeg';
import { useFFmpegStore } from './ffmpegStore';

export type ExportStatus = 'idle' | 'running' | 'done' | 'error';

export interface ExportResultInfo {
  url: string; // object URL of the finished MP4
  filename: string;
  sizeBytes: number;
}

interface ExportState {
  isOpen: boolean;
  status: ExportStatus;
  phase: string;
  progress: number; // 0..1
  startedAt: number | null; // ms epoch, for the ETA estimate
  result: ExportResultInfo | null;
  error: string | null;

  open: () => void;
  close: () => void;
  start: (opts: ExportOptions) => Promise<void>;
  cancel: () => void;
}

let activeToken: CancelToken | null = null;

export const useExportStore = create<ExportState>((set, get) => ({
  isOpen: false,
  status: 'idle',
  phase: '',
  progress: 0,
  startedAt: null,
  result: null,
  error: null,

  open: () => set({ isOpen: true }),

  close: () => {
    // The dialog blocks closing while running; guard anyway.
    if (get().status === 'running') return;
    set({ isOpen: false });
  },

  start: async (opts) => {
    if (get().status === 'running') return;

    const previous = get().result;
    if (previous) URL.revokeObjectURL(previous.url);

    const token: CancelToken = { cancelled: false };
    activeToken = token;
    set({
      status: 'running',
      phase: 'Starting…',
      progress: 0,
      startedAt: Date.now(),
      result: null,
      error: null,
    });

    try {
      const { blob, filename } = await runExport(
        opts,
        ({ phase, progress }) => {
          // Ignore late events from a cancelled/superseded run.
          if (activeToken === token && !token.cancelled) set({ phase, progress });
        },
        token,
      );
      if (token.cancelled) return; // cancel() already reset the state
      set({
        status: 'done',
        phase: 'Done',
        progress: 1,
        result: { url: URL.createObjectURL(blob), filename, sizeBytes: blob.size },
      });
    } catch (e) {
      if (token.cancelled || e instanceof ExportCancelledError) return; // handled by cancel()
      set({
        status: 'error',
        error: e instanceof Error ? e.message : 'Export failed.',
      });
    }
  },

  cancel: () => {
    if (get().status !== 'running') return;
    if (activeToken) activeToken.cancelled = true;
    // Kill the worker so an in-flight encode stops NOW (not at the next step).
    resetFFmpeg();
    useFFmpegStore.setState({ status: 'idle', error: null });
    set({ status: 'idle', phase: '', progress: 0, startedAt: null });
  },
}));
