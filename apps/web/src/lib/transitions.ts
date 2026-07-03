// ---------------------------------------------------------------------------
// Clip transitions — preview-side rendering + shared constants.
//
// A transition is stored as data on the LEFT clip ({ type, duration }) and
// overlaps the two clips it joins (see effectiveTransitionDurations). This
// module renders a transition frame PURELY from its progress: the preview
// applies the returned opacity/transform to its two <video> elements, so the
// blend is identical while playing or scrubbing (forward/backward). Export
// maps the same type ids to FFmpeg xfade transitions (lib/exportFilters.ts);
// `slide`/`zoom` easing is a preview-grade approximation of xfade's curves by
// design, `crossfade`/`fadeblack` match exactly (both are linear).
// ---------------------------------------------------------------------------

import type { Clip, ClipTransition, TransitionType } from '../types';
import { clipDuration, effectiveTransitionDurations } from './duration';

export const TRANSITION_OPTIONS: { id: TransitionType; label: string }[] = [
  { id: 'crossfade', label: 'Crossfade' },
  { id: 'fadeblack', label: 'Fade to black' },
  { id: 'slide', label: 'Slide' },
  { id: 'zoom', label: 'Zoom' },
];

export const DEFAULT_TRANSITION: ClipTransition = { type: 'crossfade', duration: 0.5 };

/** UI slider bounds; the real max is further clamped by maxTransitionAt(). */
export const TRANSITION_DURATION_RANGE = { min: 0.2, max: 2.5, step: 0.05 };

/** Style for one of the two <video> layers during a transition. */
export interface TransitionLayerStyle {
  opacity: number; // 0..1
  transform: string; // CSS transform ('none' when identity)
}

export interface TransitionFrame {
  from: TransitionLayerStyle; // outgoing clip (rendered BELOW)
  to: TransitionLayerStyle; // incoming clip (rendered ON TOP)
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Blend styles for a transition at `progress` (0..1). The incoming layer is
 * composited OVER the outgoing one against the frame's black background:
 *  - crossfade: incoming fades in over the fully-opaque outgoing frame —
 *    out*(1−p) + in*p, exactly xfade `fade`;
 *  - fadeblack: outgoing fades to black in the first half, incoming fades up
 *    from black in the second (matches xfade `fadeblack`);
 *  - slide: incoming pushes the outgoing frame out to the left (xfade
 *    `slideleft`);
 *  - zoom: outgoing zooms in while the incoming frame dissolves over it late
 *    in the transition (approximates xfade `zoomin`).
 */
export function computeTransitionFrame(type: TransitionType, progress: number): TransitionFrame {
  const p = clamp01(progress);
  switch (type) {
    case 'crossfade':
      return { from: { opacity: 1, transform: 'none' }, to: { opacity: p, transform: 'none' } };
    case 'fadeblack':
      return {
        from: { opacity: clamp01(1 - 2 * p), transform: 'none' },
        to: { opacity: clamp01(2 * p - 1), transform: 'none' },
      };
    case 'slide':
      return {
        from: { opacity: 1, transform: `translateX(${(-p * 100).toFixed(3)}%)` },
        to: { opacity: 1, transform: `translateX(${((1 - p) * 100).toFixed(3)}%)` },
      };
    case 'zoom': {
      const fade = clamp01((p - 0.4) / 0.6); // dissolve begins at 40%
      return {
        from: { opacity: 1, transform: `scale(${(1 + 0.5 * p).toFixed(4)})` },
        to: { opacity: fade, transform: 'none' },
      };
    }
  }
}

/** Neutral layer style (no transition in effect). */
export const IDENTITY_LAYER: TransitionLayerStyle = { opacity: 1, transform: 'none' };

/**
 * Longest duration the seam after clip `index` can host: limited by both
 * neighboring clips, minus whatever their OTHER seams' transitions already
 * consume. Pure companion to effectiveTransitionDurations — a duration within
 * this bound is never clamped.
 */
export function maxTransitionAt(clips: Clip[], index: number): number {
  if (index < 0 || index >= clips.length - 1) return 0;
  // Evaluate the neighboring seams as if this one didn't exist.
  const stripped = clips.map((c, k) =>
    k === index ? { ...c, transitionAfter: undefined } : c,
  );
  const eff = effectiveTransitionDurations(stripped);
  const left = clipDuration(clips[index]) - (index > 0 ? eff[index - 1] : 0);
  const right =
    clipDuration(clips[index + 1]) - (index + 1 < clips.length - 1 ? eff[index + 1] : 0);
  return Math.max(0, Math.min(left, right));
}
