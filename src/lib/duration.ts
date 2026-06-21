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

/** Trimmed length a single clip occupies on the timeline. */
export function clipDuration(clip: Pick<Clip, 'inPoint' | 'outPoint'>): number {
  return Math.max(0, clip.outPoint - clip.inPoint);
}

/** Total trimmed video duration of the main track. */
export function computeTotalDuration(clips: Clip[]): number {
  return clips.reduce((sum, clip) => sum + clipDuration(clip), 0);
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
 * Re-lay clips gaplessly along the timeline based on array order, assigning
 * each clip's `position`. Call this after any add / remove / reorder / trim
 * so stored positions never drift out of sync with order + durations.
 */
export function sequenceClips(clips: Clip[]): Clip[] {
  let cursor = 0;
  return clips.map((clip) => {
    const positioned: Clip = { ...clip, position: cursor };
    cursor += clipDuration(clip);
    return positioned;
  });
}
