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
  ClipAdjustments,
  ClipCrop,
  ClipEffect,
  ClipTransition,
  EditorDocument,
  ImportedSource,
  ProjectSettings,
  SlideDirection,
  VideoEffectType,
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
import { DEFAULT_ADJUSTMENTS } from '../lib/effects';
import { clampCrop } from '../lib/crop';
import { DEFAULT_FRAME } from '../lib/frame';
import { DEFAULT_EFFECT_INTENSITY } from '../lib/videoEffects';
import { maxTransitionAt } from '../lib/transitions';

// ---- defaults -------------------------------------------------------------

const DEFAULT_SETTINGS: ProjectSettings = {
  aspectRatio: '9:16',
  exportResolution: '1080p',
  frame: { ...DEFAULT_FRAME },
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

export interface NewSourceInput {
  fileName: string;
  url: string; // object URL for the source media
  duration: number;
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
  src: string; // object URL for the source audio
  sourceDuration: number;
  inPoint?: number;
  outPoint?: number; // default = min(sourceDuration, 60s)
  offset?: number; // default 0 (start of timeline)
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** Patch shape for updateClip — the stage-5 effect parameters plus mute.
 *  `adjustments` may be partial; it is merged onto the existing adjustments. */
export type ClipEffectsPatch = Partial<
  Pick<Clip, 'filter' | 'filterIntensity' | 'speed' | 'audioMuted'>
> & { adjustments?: Partial<ClipAdjustments> };

/** What "copy style" carries between overlays: the full visual style plus the
 *  animation — but NOT position, time window, rotation or lock (placement). */
export interface OverlayStyleClipboard {
  style: TextStyle;
  animation: TextAnimation;
  slideFrom: SlideDirection;
}

// ---- store shape ----------------------------------------------------------

export interface EditorState extends EditorDocument {
  // UI state (excluded from undo/redo)
  playheadTime: number;
  selectedItemId: string | null;
  /** Id of the LEFT clip of the selected transition seam (opens the
   *  transition panel). Mutually exclusive with selectedItemId. */
  selectedTransitionId: string | null;
  isPlaying: boolean;
  clipsPanel: { isOpen: boolean };
  /** Imported video files (the Clips panel's library). Outside undo history:
   *  undoing an import removes the clip but keeps the source available. */
  sources: ImportedSource[];

  // command history (snapshots of the document)
  past: EditorDocument[];
  future: EditorDocument[];

  // selectors
  totalDuration: () => number;
  canUndo: () => boolean;
  canRedo: () => boolean;

  /** Register an imported file in the library (opens the Clips panel on the
   *  first one). Returns the new source's id. */
  addSource: (input: NewSourceInput) => string;

  // clip actions
  addClip: (input: NewClipInput) => ActionResult;
  /** Replace clip `id` with a fresh clip built from `input`, at the same
   *  timeline index (the Clips panel's "switch working piece"). Effects/trim
   *  of the replaced clip are dropped (undo restores them); runs the uniform
   *  60s guard. */
  replaceClip: (id: string, input: NewClipInput) => ActionResult;
  removeClip: (id: string) => void;
  updateClipTrim: (id: string, inPoint: number, outPoint: number) => ActionResult;
  reorderClips: (fromIndex: number, toIndex: number) => void;
  /** Update effect params (filter/adjustments/speed) or mute. Speed changes the
   *  clip's effective duration, so they run the uniform 60s guard. */
  updateClip: (
    id: string,
    patch: ClipEffectsPatch,
    options?: { history?: boolean },
  ) => ActionResult;
  /** Set/replace/remove (null) the transition between clip `leftClipId` and
   *  the next clip. Duration is clamped to what the neighbors allow. Removing
   *  a transition LENGTHENS the timeline, so the uniform 60s guard runs. */
  setTransition: (
    leftClipId: string,
    transition: ClipTransition | null,
    options?: { history?: boolean },
  ) => ActionResult;
  /** Set (or clear with null) a clip's crop rectangle. Pure parameter edit —
   *  the crop never changes duration, so no 60s guard. Drag gestures on the
   *  preview use checkpoint + { history: false }. */
  setClipCrop: (id: string, crop: ClipCrop | null, options?: { history?: boolean }) => void;

  // crop editor UI state (not in undo history)
  /** Clip currently being reframed on the preview (null = no crop session). */
  cropEditingClipId: string | null;
  /** Pixel aspect the crop editor's handles keep (null = free-form). */
  cropAspectLock: number | null;
  setCropEditing: (id: string | null) => void;
  setCropAspectLock: (ratio: number | null) => void;

  // trending-effect actions (stage 8) — pure parameter edits, no duration
  // change, so no 60s guard. Sliders use checkpoint + { history: false }.
  addClipEffect: (clipId: string, type: VideoEffectType) => void;
  updateClipEffect: (
    clipId: string,
    effectId: string,
    patch: Partial<Omit<ClipEffect, 'id' | 'type'>>,
    options?: { history?: boolean },
  ) => void;
  removeClipEffect: (clipId: string, effectId: string) => void;

  // text overlay actions
  addTextOverlay: (input?: NewTextOverlayInput) => string;
  updateTextOverlay: (
    id: string,
    // style may be a partial — it's merged onto the existing style
    patch: Partial<Omit<TextOverlay, 'id' | 'style'>> & { style?: Partial<TextStyle> },
    options?: { history?: boolean },
  ) => void;
  removeTextOverlay: (id: string) => void;
  /** Clone overlay `id` (same style/rotation/duration), placed at the current
   *  playhead and nudged a few % so the copy is visibly separate. Selects the
   *  copy. Returns its id, or null if the source doesn't exist. */
  duplicateTextOverlay: (id: string) => string | null;
  /** Move overlay `id` one step up ('forward' = drawn later = on top) or down
   *  in the stacking order (= array order, see TextOverlay docs). */
  moveTextOverlayLayer: (id: string, direction: 'forward' | 'backward') => void;
  /** Style clipboard (UI state, not in undo history). */
  styleClipboard: OverlayStyleClipboard | null;
  copyOverlayStyle: (id: string) => void;
  pasteOverlayStyle: (id: string) => void;

  // audio actions
  addAudioTrack: (input: NewAudioInput) => string;
  updateAudioTrack: (
    id: string,
    patch: Partial<Omit<AudioTrack, 'id'>>,
    options?: { history?: boolean },
  ) => void;
  removeAudioTrack: (id: string) => void;

  // ui actions
  setPlayhead: (time: number) => void;
  setSelected: (id: string | null) => void;
  setSelectedTransition: (leftClipId: string | null) => void;
  setPlaying: (playing: boolean) => void;
  /** Settings edits snapshot history like document edits; the frame panel's
   *  sliders pass { history: false } after a checkpoint() (gesture pattern). */
  updateSettings: (patch: Partial<ProjectSettings>, options?: { history?: boolean }) => void;
  toggleClipsPanel: () => void;

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
  selectedTransitionId: null,
  cropEditingClipId: null,
  cropAspectLock: null,
  isPlaying: false,
  clipsPanel: { isOpen: false },
  sources: [],

  // initial history
  past: [],
  future: [],

  // ---- selectors ----
  totalDuration: () => computeTotalDuration(get().clips),
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  // ---- source library ----
  addSource: (input) => {
    const state = get();
    const source: ImportedSource = {
      id: uid('src'),
      fileName: input.fileName,
      url: input.url,
      duration: input.duration,
    };
    set({
      sources: [...state.sources, source],
      clipsPanel: state.sources.length === 0 ? { isOpen: true } : state.clipsPanel,
    });
    return source.id;
  },

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
      filter: 'none',
      filterIntensity: 100,
      adjustments: { ...DEFAULT_ADJUSTMENTS },
      speed: 1,
      effects: [],
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

    // Auto-open clips panel when first clip is added
    const shouldOpenPanel = state.clips.length === 0;
    set({
      clips: candidate,
      clipsPanel: shouldOpenPanel ? { isOpen: true } : state.clipsPanel,
      ...pushHistory(state),
    });
    return { ok: true };
  },

  replaceClip: (id, input) => {
    const state = get();
    const index = state.clips.findIndex((c) => c.id === id);
    if (index < 0) return { ok: false, reason: 'Clip not found.' };

    const newClip: Clip = {
      id: uid('clip'),
      sourceFileName: input.sourceFileName,
      src: input.src,
      sourceDuration: input.sourceDuration,
      inPoint: input.inPoint ?? 0,
      outPoint: input.outPoint ?? input.sourceDuration,
      position: 0, // assigned by sequenceClips below
      audioMuted: input.audioMuted ?? false,
      filter: 'none',
      filterIntensity: 100,
      adjustments: { ...DEFAULT_ADJUSTMENTS },
      speed: 1,
      effects: [],
    };

    const candidate = sequenceClips(state.clips.map((c, i) => (i === index ? newClip : c)));
    if (exceedsMax(candidate)) {
      return {
        ok: false,
        reason: `Switching to this piece would make the video ${computeTotalDuration(
          candidate,
        ).toFixed(1)}s — over the ${MAX_TIMELINE_DURATION}s limit.`,
      };
    }

    set({
      clips: candidate,
      selectedItemId: state.selectedItemId === id ? newClip.id : state.selectedItemId,
      selectedTransitionId:
        state.selectedTransitionId === id ? null : state.selectedTransitionId,
      cropEditingClipId: state.cropEditingClipId === id ? null : state.cropEditingClipId,
      ...pushHistory(state),
    });
    return { ok: true };
  },

  removeClip: (id) => {
    const state = get();
    if (!state.clips.some((c) => c.id === id)) return;
    const candidate = sequenceClips(state.clips.filter((c) => c.id !== id));
    set({
      clips: candidate,
      selectedItemId: state.selectedItemId === id ? null : state.selectedItemId,
      selectedTransitionId:
        state.selectedTransitionId === id ? null : state.selectedTransitionId,
      cropEditingClipId: state.cropEditingClipId === id ? null : state.cropEditingClipId,
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

  updateClip: (id, patch, options) => {
    const state = get();
    const target = state.clips.find((c) => c.id === id);
    if (!target) return { ok: false, reason: 'Clip not found.' };

    const merged: Clip = {
      ...target,
      ...patch,
      adjustments: { ...target.adjustments, ...patch.adjustments },
    };
    // Speed changes effective duration — re-lay positions and run the guard.
    const candidate = sequenceClips(state.clips.map((c) => (c.id === id ? merged : c)));
    if (patch.speed !== undefined && exceedsMax(candidate)) {
      return {
        ok: false,
        reason: `That speed would push the video over the ${MAX_TIMELINE_DURATION}s limit.`,
      };
    }

    // history: false during a slider gesture (a checkpoint was taken at start).
    if (options?.history === false) set({ clips: candidate });
    else set({ clips: candidate, ...pushHistory(state) });
    return { ok: true };
  },

  setTransition: (leftClipId, transition, options) => {
    const state = get();
    const index = state.clips.findIndex((c) => c.id === leftClipId);
    if (index < 0) return { ok: false, reason: 'Clip not found.' };
    if (index === state.clips.length - 1) {
      return { ok: false, reason: 'The last clip has no next clip to transition into.' };
    }

    let next: ClipTransition | undefined;
    if (transition) {
      const max = maxTransitionAt(state.clips, index);
      const duration = Math.min(transition.duration, max);
      if (duration < 0.1) {
        return { ok: false, reason: 'The neighboring clips are too short for a transition.' };
      }
      next = { type: transition.type, duration };
    }

    const candidate = sequenceClips(
      state.clips.map((c, k) => (k === index ? { ...c, transitionAfter: next } : c)),
    );
    // Adding a transition shortens the video; removing/shortening one grows it
    // back, which can re-break the cap — same uniform guard as everywhere.
    if (exceedsMax(candidate)) {
      return {
        ok: false,
        reason: `Removing this transition would push the video over the ${MAX_TIMELINE_DURATION}s limit.`,
      };
    }

    // history: false during the duration-slider gesture (checkpoint at start).
    if (options?.history === false) set({ clips: candidate });
    else set({ clips: candidate, ...pushHistory(state) });
    return { ok: true };
  },

  setClipCrop: (id, crop, options) => {
    const state = get();
    if (!state.clips.some((c) => c.id === id)) return;
    const clips = state.clips.map((c) =>
      c.id === id ? { ...c, crop: crop ? clampCrop(crop) : undefined } : c,
    );
    // history: false during a drag gesture (a checkpoint was taken at start).
    if (options?.history === false) set({ clips });
    else set({ clips, ...pushHistory(state) });
  },

  setCropEditing: (id) => set({ cropEditingClipId: id }),
  setCropAspectLock: (ratio) => set({ cropAspectLock: ratio }),

  // ---- trending-effect actions (stage 8) ----
  addClipEffect: (clipId, type) => {
    const state = get();
    if (!state.clips.some((c) => c.id === clipId)) return;
    const effect: ClipEffect = {
      id: uid('fx'),
      type,
      intensity: DEFAULT_EFFECT_INTENSITY,
      ...(type === 'zoom' ? { direction: 'in' as const } : {}),
    };
    set({
      clips: state.clips.map((c) =>
        c.id === clipId ? { ...c, effects: [...c.effects, effect] } : c,
      ),
      ...pushHistory(state),
    });
  },

  updateClipEffect: (clipId, effectId, patch, options) => {
    const state = get();
    const clip = state.clips.find((c) => c.id === clipId);
    if (!clip || !clip.effects.some((e) => e.id === effectId)) return;
    const clips = state.clips.map((c) =>
      c.id === clipId
        ? {
            ...c,
            effects: c.effects.map((e) => (e.id === effectId ? { ...e, ...patch } : e)),
          }
        : c,
    );
    if (options?.history === false) set({ clips });
    else set({ clips, ...pushHistory(state) });
  },

  removeClipEffect: (clipId, effectId) => {
    const state = get();
    const clip = state.clips.find((c) => c.id === clipId);
    if (!clip || !clip.effects.some((e) => e.id === effectId)) return;
    set({
      clips: state.clips.map((c) =>
        c.id === clipId ? { ...c, effects: c.effects.filter((e) => e.id !== effectId) } : c,
      ),
      ...pushHistory(state),
    });
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
      rotation: 0,
      locked: false,
      style: { ...DEFAULT_TEXT_STYLE, ...input.style },
      animation: input.animation ?? 'none',
      slideFrom: 'left',
    };
    set({ textOverlays: [...state.textOverlays, overlay], ...pushHistory(state) });
    return overlay.id;
  },

  duplicateTextOverlay: (id) => {
    const state = get();
    const src = state.textOverlays.find((t) => t.id === id);
    if (!src) return null;
    const total = computeTotalDuration(state.clips);
    // Same duration, placed at the playhead (clamped inside the timeline);
    // if that collapses (playhead at the very end), keep the source's window.
    const dur = src.endTime - src.startTime;
    let start = Math.min(Math.max(0, state.playheadTime), Math.max(0, total - 0.5));
    let end = Math.min(start + dur, total);
    if (end - start < 0.1) {
      start = src.startTime;
      end = src.endTime;
    }
    const copy: TextOverlay = {
      ...src,
      id: uid('text'),
      style: { ...src.style },
      startTime: start,
      endTime: end,
      x: Math.min(95, src.x + 3),
      y: Math.min(95, src.y + 3),
      locked: false, // a fresh copy is there to be moved
    };
    set({
      textOverlays: [...state.textOverlays, copy],
      selectedItemId: copy.id,
      selectedTransitionId: null,
      ...pushHistory(state),
    });
    return copy.id;
  },

  moveTextOverlayLayer: (id, direction) => {
    const state = get();
    const i = state.textOverlays.findIndex((t) => t.id === id);
    const j = direction === 'forward' ? i + 1 : i - 1;
    if (i < 0 || j < 0 || j >= state.textOverlays.length) return;
    const next = [...state.textOverlays];
    [next[i], next[j]] = [next[j], next[i]];
    set({ textOverlays: next, ...pushHistory(state) });
  },

  styleClipboard: null,
  copyOverlayStyle: (id) => {
    const t = get().textOverlays.find((o) => o.id === id);
    if (!t) return;
    // UI state only — copying is not an undoable document edit.
    set({
      styleClipboard: { style: { ...t.style }, animation: t.animation, slideFrom: t.slideFrom },
    });
  },
  pasteOverlayStyle: (id) => {
    const state = get();
    const clip = state.styleClipboard;
    if (!clip || !state.textOverlays.some((t) => t.id === id)) return;
    set({
      textOverlays: state.textOverlays.map((t) =>
        t.id === id
          ? { ...t, style: { ...clip.style }, animation: clip.animation, slideFrom: clip.slideFrom }
          : t,
      ),
      ...pushHistory(state),
    });
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

  // ---- audio actions (audio does not count toward the 60s video limit) ----
  addAudioTrack: (input) => {
    const state = get();
    const track: AudioTrack = {
      id: uid('audio'),
      sourceFileName: input.sourceFileName,
      src: input.src,
      sourceDuration: input.sourceDuration,
      inPoint: input.inPoint ?? 0,
      // The timeline ruler only spans 60s, so cap the default trim there.
      outPoint: input.outPoint ?? Math.min(input.sourceDuration, MAX_TIMELINE_DURATION),
      offset: input.offset ?? 0,
      volume: input.volume ?? 1,
      fadeIn: input.fadeIn ?? 0,
      fadeOut: input.fadeOut ?? 0,
    };
    set({ audioTracks: [...state.audioTracks, track], ...pushHistory(state) });
    return track.id;
  },

  updateAudioTrack: (id, patch, options) => {
    const state = get();
    if (!state.audioTracks.some((a) => a.id === id)) return;
    const audioTracks = state.audioTracks.map((a) =>
      a.id === id ? { ...a, ...patch } : a,
    );
    // history: false during a drag/slider gesture (checkpoint taken at start).
    if (options?.history === false) set({ audioTracks });
    else set({ audioTracks, ...pushHistory(state) });
  },

  removeAudioTrack: (id) => {
    const state = get();
    if (!state.audioTracks.some((a) => a.id === id)) return;
    // NOTE: like Clip.src, the object URL is NOT revoked here — undo could
    // restore the track. See the lifecycle note in useImportAudio.
    set({
      audioTracks: state.audioTracks.filter((a) => a.id !== id),
      selectedItemId: state.selectedItemId === id ? null : state.selectedItemId,
      ...pushHistory(state),
    });
  },

  // ---- ui actions (no history) ----
  setPlayhead: (time) => set({ playheadTime: Math.max(0, time) }),
  // The two selection kinds are mutually exclusive so at most one editor
  // panel is open at a time (App renders panels off whichever is set).
  setSelected: (id) => set({ selectedItemId: id, selectedTransitionId: null }),
  setSelectedTransition: (leftClipId) =>
    set({ selectedTransitionId: leftClipId, selectedItemId: null }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  toggleClipsPanel: () => {
    const state = get();
    set({ clipsPanel: { isOpen: !state.clipsPanel.isOpen } });
  },

  updateSettings: (patch, options) => {
    const state = get();
    const settings = { ...state.settings, ...patch };
    if (options?.history === false) set({ settings });
    else set({ settings, ...pushHistory(state) });
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
