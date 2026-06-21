// ---------------------------------------------------------------------------
// Editor store (Zustand)
//
// Design notes:
//  - Document state (clips/textOverlays/audioTracks/settings) is snapshotted
//    for undo/redo. UI state (playheadTime/selectedItemId) is NOT — undoing a
//    playhead nudge would be infuriating.
//  - Every action that can change video length builds a *candidate* clips
//    array, runs computeTotalDuration/exceedsMax on it, and rejects before
//    committing. The guard and the displayed total therefore always agree.
//  - Guarded actions return ActionResult so the UI can show `reason` instead
//    of the store throwing.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import type {
  ActionResult,
  AudioTrack,
  Clip,
  EditorDocument,
  ProjectSettings,
  TextAnimation,
  TextOverlay,
  TextStyle,
} from '../types';
import {
  MAX_TIMELINE_DURATION,
  computeTotalDuration,
  exceedsMax,
  sequenceClips,
} from '../lib/duration';

// ---- defaults -------------------------------------------------------------

const DEFAULT_SETTINGS: ProjectSettings = {
  aspectRatio: '9:16',
  exportResolution: '1080p',
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: 7, // cqh (~7% of frame height)
  color: '#ffffff',
  outlineColor: '#000000',
  outlineWidth: 0.06, // em
  opacity: 1,
  alignment: 'center',
  shadow: true,
  background: 'transparent',
};

// Cap history so a long session can't grow snapshots without bound.
const HISTORY_LIMIT = 100;

// ---- id generation --------------------------------------------------------

let idCounter = 0;
const uid = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

// ---- action input shapes --------------------------------------------------
// Adds take a friendly input where most fields are optional/defaulted; the
// store fills in ids, positions, and sensible defaults.

export interface NewClipInput {
  sourceFileName: string;
  src: string; // object URL for the source media
  sourceDuration: number;
  inPoint?: number; // default 0
  outPoint?: number; // default = sourceDuration (use whole clip)
  audioMuted?: boolean; // default false
}

export interface NewTextOverlayInput {
  text?: string;
  startTime?: number; // default = current playhead
  endTime?: number; // default = start + 3s
  style?: Partial<TextStyle>;
  animation?: TextAnimation;
}

export interface NewAudioInput {
  sourceFileName: string;
  sourceDuration?: number; // used to default outPoint
  inPoint?: number;
  outPoint?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

// ---- store shape ----------------------------------------------------------

export interface EditorState extends EditorDocument {
  // UI state (excluded from undo/redo)
  playheadTime: number;
  selectedItemId: string | null;
  isPlaying: boolean;

  // command history (snapshots of the document)
  past: EditorDocument[];
  future: EditorDocument[];

  // selectors
  totalDuration: () => number;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // clip actions
  addClip: (input: NewClipInput) => ActionResult;
  removeClip: (id: string) => void;
  updateClipTrim: (id: string, inPoint: number, outPoint: number) => ActionResult;
  reorderClips: (fromIndex: number, toIndex: number) => void;

  // text overlay actions
  addTextOverlay: (input?: NewTextOverlayInput) => string;
  updateTextOverlay: (
    id: string,
    // style may be a partial — it's merged onto the existing style
    patch: Partial<Omit<TextOverlay, 'id' | 'style'>> & { style?: Partial<TextStyle> },
    options?: { history?: boolean },
  ) => void;
  removeTextOverlay: (id: string) => void;

  // audio actions
  addAudioTrack: (input: NewAudioInput) => string;
  updateAudioTrack: (id: string, patch: Partial<Omit<AudioTrack, 'id'>>) => void;

  // ui actions
  setPlayhead: (time: number) => void;
  setSelected: (id: string | null) => void;
  setPlaying: (playing: boolean) => void;
  updateSettings: (patch: Partial<ProjectSettings>) => void;

  // history actions
  undo: () => void;
  redo: () => void;
  /** Manually snapshot current document to history — used at the start of a
   *  continuous gesture (drag/slider) whose intermediate updates pass
   *  { history: false }, so the whole gesture is a single undo step. */
  checkpoint: () => void;
}

// ---- history helpers ------------------------------------------------------

/** Extract the document slice (the part undo/redo cares about). */
const docOf = (s: EditorDocument): EditorDocument => ({
  clips: s.clips,
  textOverlays: s.textOverlays,
  audioTracks: s.audioTracks,
  settings: s.settings,
});

/**
 * Build the history fields for a mutation: push the *current* document onto
 * `past` and clear `future`. Spread the result into the same `set()` call that
 * applies the change, e.g. `set({ clips: next, ...pushHistory(get()) })`.
 * Reads state before the mutation is applied, so the snapshot is correct.
 */
const pushHistory = (s: EditorState): Pick<EditorState, 'past' | 'future'> => ({
  past: [...s.past, docOf(s)].slice(-HISTORY_LIMIT),
  future: [],
});

// ---- store ----------------------------------------------------------------

export const useEditorStore = create<EditorState>((set, get) => ({
  // initial document
  clips: [],
  textOverlays: [],
  audioTracks: [],
  settings: DEFAULT_SETTINGS,

  // initial UI state
  playheadTime: 0,
  selectedItemId: null,
  isPlaying: false,

  // initial history
  past: [],
  future: [],

  // ---- selectors ----
  totalDuration: () => computeTotalDuration(get().clips),
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  // ---- clip actions ----
  addClip: (input) => {
    const state = get();
    const inPoint = input.inPoint ?? 0;
    const outPoint = input.outPoint ?? input.sourceDuration;

    const newClip: Clip = {
      id: uid('clip'),
      sourceFileName: input.sourceFileName,
      src: input.src,
      sourceDuration: input.sourceDuration,
      inPoint,
      outPoint,
      position: 0, // assigned by sequenceClips below
      audioMuted: input.audioMuted ?? false,
    };

    const candidate = sequenceClips([...state.clips, newClip]);
    if (exceedsMax(candidate)) {
      return {
        ok: false,
        reason: `Adding this clip would make the video ${computeTotalDuration(
          candidate,
        ).toFixed(1)}s — over the ${MAX_TIMELINE_DURATION}s limit.`,
      };
    }

    set({ clips: candidate, ...pushHistory(state) });
    return { ok: true };
  },

  removeClip: (id) => {
    const state = get();
    if (!state.clips.some((c) => c.id === id)) return;
    const candidate = sequenceClips(state.clips.filter((c) => c.id !== id));
    set({
      clips: candidate,
      selectedItemId: state.selectedItemId === id ? null : state.selectedItemId,
      ...pushHistory(state),
    });
  },

  updateClipTrim: (id, inPoint, outPoint) => {
    const state = get();
    const target = state.clips.find((c) => c.id === id);
    if (!target) return { ok: false, reason: 'Clip not found.' };
    if (outPoint <= inPoint) {
      return { ok: false, reason: 'Trim end must come after the trim start.' };
    }
    if (inPoint < 0 || outPoint > target.sourceDuration) {
      return { ok: false, reason: 'Trim points fall outside the source media.' };
    }

    const candidate = sequenceClips(
      state.clips.map((c) => (c.id === id ? { ...c, inPoint, outPoint } : c)),
    );
    if (exceedsMax(candidate)) {
      return {
        ok: false,
        reason: `That trim would push the video over the ${MAX_TIMELINE_DURATION}s limit.`,
      };
    }

    set({ clips: candidate, ...pushHistory(state) });
    return { ok: true };
  },

  reorderClips: (fromIndex, toIndex) => {
    const state = get();
    const n = state.clips.length;
    if (
      fromIndex < 0 ||
      fromIndex >= n ||
      toIndex < 0 ||
      toIndex >= n ||
      fromIndex === toIndex
    ) {
      return;
    }
    const next = [...state.clips];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    // Reordering can't change total duration, but positions must be rebuilt.
    set({ clips: sequenceClips(next), ...pushHistory(state) });
  },

  // ---- text overlay actions (do not count toward the 60s video limit) ----
  addTextOverlay: (input = {}) => {
    const state = get();
    const total = computeTotalDuration(state.clips);
    // Keep the overlay inside the timeline, leaving at least a little duration.
    const start = Math.min(Math.max(0, input.startTime ?? state.playheadTime), Math.max(0, total - 0.5));
    const end = input.endTime ?? Math.min(start + 3, total);
    const overlay: TextOverlay = {
      id: uid('text'),
      text: input.text ?? 'Tap to edit',
      startTime: start,
      endTime: end,
      x: 50,
      y: 50,
      style: { ...DEFAULT_TEXT_STYLE, ...input.style },
      animation: input.animation ?? 'none',
      slideFrom: 'left',
    };
    set({ textOverlays: [...state.textOverlays, overlay], ...pushHistory(state) });
    return overlay.id;
  },

  updateTextOverlay: (id, patch, options) => {
    const state = get();
    if (!state.textOverlays.some((t) => t.id === id)) return;
    const textOverlays = state.textOverlays.map((t) =>
      t.id === id ? { ...t, ...patch, style: { ...t.style, ...patch.style } } : t,
    );
    // history: false during a gesture (a checkpoint was taken at gesture start).
    if (options?.history === false) set({ textOverlays });
    else set({ textOverlays, ...pushHistory(state) });
  },

  removeTextOverlay: (id) => {
    const state = get();
    if (!state.textOverlays.some((t) => t.id === id)) return;
    set({
      textOverlays: state.textOverlays.filter((t) => t.id !== id),
      selectedItemId: state.selectedItemId === id ? null : state.selectedItemId,
      ...pushHistory(state),
    });
  },

  // ---- audio actions ----
  addAudioTrack: (input) => {
    const state = get();
    const track: AudioTrack = {
      id: uid('audio'),
      sourceFileName: input.sourceFileName,
      inPoint: input.inPoint ?? 0,
      outPoint: input.outPoint ?? input.sourceDuration ?? 0,
      volume: input.volume ?? 1,
      fadeIn: input.fadeIn ?? 0,
      fadeOut: input.fadeOut ?? 0,
    };
    set({ audioTracks: [...state.audioTracks, track], ...pushHistory(state) });
    return track.id;
  },

  updateAudioTrack: (id, patch) => {
    const state = get();
    if (!state.audioTracks.some((a) => a.id === id)) return;
    set({
      audioTracks: state.audioTracks.map((a) =>
        a.id === id ? { ...a, ...patch } : a,
      ),
      ...pushHistory(state),
    });
  },

  // ---- ui actions (no history) ----
  setPlayhead: (time) => set({ playheadTime: Math.max(0, time) }),
  setSelected: (id) => set({ selectedItemId: id }),
  setPlaying: (playing) => set({ isPlaying: playing }),

  updateSettings: (patch) => {
    const state = get();
    set({ settings: { ...state.settings, ...patch }, ...pushHistory(state) });
  },

  // ---- history actions ----
  undo: () => {
    const state = get();
    if (state.past.length === 0) return;
    const previous = state.past[state.past.length - 1];
    set({
      ...previous,
      past: state.past.slice(0, -1),
      future: [docOf(state), ...state.future].slice(0, HISTORY_LIMIT),
    });
  },

  redo: () => {
    const state = get();
    if (state.future.length === 0) return;
    const next = state.future[0];
    set({
      ...next,
      past: [...state.past, docOf(state)].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
    });
  },

  checkpoint: () => set((s) => pushHistory(s)),
}));
