// ---------------------------------------------------------------------------
// Duration math — the single source of truth for the 60s constraint.
//
// Every place that needs "how long is the video" (the selector, the debug
// panel, and the guard inside each store action) MUST go through
// computeTotalDuration(). That guarantees the guard can never disagree with
// what the UI displays, because they run the identical function.
// ---------------------------------------------------------------------------

import type { Clip } from '../types';

/** Hard product limit: total trimmed video duration may not exceed this. */
export const MAX_TIMELINE_DURATION = 60; // seconds

// Float sums of trim points can land a hair over an exact boundary; this slack
// stops an edit that lands on exactly 60.000000001s from being rejected.
const EPSILON = 1e-6;

/**
 * EFFECTIVE length a single clip occupies on the timeline: trimmed source
 * length divided by playback speed (2x speed → half the timeline time).
 * This is the single seam through which speed affects the 60s cap, block
 * widths, and global-time mapping.
 */
export function clipDuration(clip: Pick<Clip, 'inPoint' | 'outPoint' | 'speed'>): number {
  const speed = clip.speed > 0 ? clip.speed : 1;
  return Math.max(0, clip.outPoint - clip.inPoint) / speed;
}

/**
 * Transitions shorter than this (after clamping) are treated as none — a
 * sub-frame xfade would be invisible and can produce degenerate filter args.
 */
export const MIN_EFFECTIVE_TRANSITION = 0.05; // seconds

/**
 * EFFECTIVE duration of the transition after each clip (length = clips.length
 * − 1; entry i sits between clip i and clip i+1; 0 = hard cut).
 *
 * A transition overlaps its two clips, so its stored duration is clamped at
 * READ time (never rewritten in the store) against what the neighbors can
 * give: it can't exceed the incoming clip, and can't reach back into the part
 * of the outgoing clip already consumed by the PREVIOUS seam's transition
 * (left-to-right priority). Deriving here — like clipDuration does for speed —
 * means the 60s guard, sequenceClips, playback and export all agree even after
 * a trim shrinks a neighbor under a stored duration.
 */
export function effectiveTransitionDurations(clips: Clip[]): number[] {
  const out: number[] = [];
  let prev = 0; // effective duration of the previous seam's transition
  for (let i = 0; i < clips.length - 1; i++) {
    const t = clips[i].transitionAfter;
    let e = 0;
    if (t && t.duration > 0) {
      e = Math.min(t.duration, clipDuration(clips[i]) - prev, clipDuration(clips[i + 1]));
      if (e < MIN_EFFECTIVE_TRANSITION) e = 0;
    }
    out.push(e);
    prev = e;
  }
  return out;
}

/** Total video duration of the main track: trimmed clip lengths minus the
 *  transition overlaps (each transition shortens the timeline). */
export function computeTotalDuration(clips: Clip[]): number {
  const overlap = effectiveTransitionDurations(clips).reduce((a, b) => a + b, 0);
  return clips.reduce((sum, clip) => sum + clipDuration(clip), 0) - overlap;
}

/** True when a candidate clip set would break the 60s limit. */
export function exceedsMax(clips: Clip[]): boolean {
  return computeTotalDuration(clips) > MAX_TIMELINE_DURATION + EPSILON;
}

/** Seconds of headroom left before hitting the limit (never negative). */
export function remainingDuration(clips: Clip[]): number {
  return Math.max(0, MAX_TIMELINE_DURATION - computeTotalDuration(clips));
}

/**
 * Re-lay clips along the timeline based on array order, assigning each clip's
 * `position`. Call this after any add / remove / reorder / trim so stored
 * positions never drift out of sync with order + durations. Where a transition
 * joins two clips, the next clip starts EARLY by the transition's effective
 * duration (the overlap window is where both clips render).
 */
export function sequenceClips(clips: Clip[]): Clip[] {
  const transitions = effectiveTransitionDurations(clips);
  let cursor = 0;
  return clips.map((clip, i) => {
    const positioned: Clip = { ...clip, position: cursor };
    cursor += clipDuration(clip) - (transitions[i] ?? 0);
    return positioned;
  });
}
