// ---------------------------------------------------------------------------
// Pure global-time <-> clip-time mapping.
//
// The timeline is a gapless sequence of clips. "Global time" runs 0 → total
// duration; each clip contributes its trimmed length [inPoint, outPoint]. These
// pure functions convert between a global timeline time and the concrete
// (clip + source time) it corresponds to. They are the heart of playback and
// are reused at export time, so they take `clips` explicitly and hold no state.
// ---------------------------------------------------------------------------

import type { Clip, TransitionType } from '../types';
import { clipDuration, effectiveTransitionDurations } from './duration';

export interface TimelineSegment {
  clip: Clip;
  index: number;
  start: number; // global start time of this clip (seconds)
  end: number; // global end time of this clip (seconds)
}

/**
 * Lay clips along the timeline and return each one's global [start, end)
 * window. Where a transition joins clip i and i+1, the windows OVERLAP by the
 * transition's effective duration (both clips render during the overlap); the
 * timeline is otherwise gapless.
 */
export function buildSegments(clips: Clip[]): TimelineSegment[] {
  const transitions = effectiveTransitionDurations(clips);
  let cursor = 0;
  return clips.map((clip, index) => {
    const start = cursor;
    const end = start + clipDuration(clip);
    cursor = end - (transitions[index] ?? 0);
    return { clip, index, start, end };
  });
}

/** Total timeline duration (sum of trimmed clip lengths). */
export function totalTimelineDuration(clips: Clip[]): number {
  const segments = buildSegments(clips);
  return segments.length ? segments[segments.length - 1].end : 0;
}

export interface PlaybackLocation {
  index: number; // clip index in the timeline
  clip: Clip;
  segment: TimelineSegment;
  localTime: number; // SOURCE time within the clip (between inPoint and outPoint)
  globalTime: number; // the (clamped) global time this maps from
}

/**
 * Resolve a global timeline time to { clip, source time }.
 *
 * Boundary rules:
 *  - clamps the input to [0, total];
 *  - at an exact clip seam, returns the LATER clip at its inPoint (so playback
 *    shows the next clip starting), except at the very end where it returns the
 *    last clip at its outPoint;
 *  - inside a transition overlap, returns the OUTGOING clip — it stays the
 *    "primary" until it actually ends; use locateTransition() to also get the
 *    incoming clip and blend progress;
 *  - returns null only when there are no clips.
 */
export function locate(clips: Clip[], globalTime: number): PlaybackLocation | null {
  const segments = buildSegments(clips);
  if (segments.length === 0) return null;

  const total = segments[segments.length - 1].end;
  const time = Math.min(Math.max(globalTime, 0), total);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    if (time < seg.end || isLast) {
      const offset = time - seg.start; // into the trimmed window (timeline seconds)
      // Timeline seconds advance 1:speed against source seconds.
      const speed = seg.clip.speed > 0 ? seg.clip.speed : 1;
      const localTime = Math.min(seg.clip.inPoint + offset * speed, seg.clip.outPoint);
      return { index: i, clip: seg.clip, segment: seg, localTime, globalTime: time };
    }
  }
  return null;
}

/** Inverse of locate's offset: a source time within a segment -> global time. */
export function sourceToGlobal(segment: TimelineSegment, sourceTime: number): number {
  const speed = segment.clip.speed > 0 ? segment.clip.speed : 1;
  return segment.start + (sourceTime - segment.clip.inPoint) / speed;
}

/** The inverse mapping for any segment: global time -> source time (clamped
 *  to the clip's trim window). */
export function globalToSource(segment: TimelineSegment, globalTime: number): number {
  const speed = segment.clip.speed > 0 ? segment.clip.speed : 1;
  const src = segment.clip.inPoint + (globalTime - segment.start) * speed;
  return Math.min(Math.max(src, segment.clip.inPoint), segment.clip.outPoint);
}

export interface TransitionLocation {
  from: TimelineSegment; // outgoing clip
  to: TimelineSegment; // incoming clip
  type: TransitionType;
  duration: number; // EFFECTIVE transition duration (seconds)
  progress: number; // 0 (transition starts) .. 1 (outgoing clip ends)
}

/**
 * If `globalTime` falls inside a transition's overlap window, return both
 * segments and how far through the transition we are. Pure — drives the
 * preview blend identically while playing or scrubbing, and its window math
 * matches the xfade offsets used at export.
 */
export function locateTransition(
  clips: Clip[],
  globalTime: number,
): TransitionLocation | null {
  const transitions = effectiveTransitionDurations(clips);
  if (!transitions.some((d) => d > 0)) return null;
  const segments = buildSegments(clips);
  for (let i = 0; i < transitions.length; i++) {
    const d = transitions[i];
    if (d <= 0) continue;
    const start = segments[i + 1].start; // = segments[i].end - d
    const end = segments[i].end;
    if (globalTime >= start && globalTime < end) {
      return {
        from: segments[i],
        to: segments[i + 1],
        type: clips[i].transitionAfter!.type,
        duration: d,
        progress: (globalTime - start) / d,
      };
    }
  }
  return null;
}
