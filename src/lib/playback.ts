// ---------------------------------------------------------------------------
// Pure global-time <-> clip-time mapping.
//
// The timeline is a gapless sequence of clips. "Global time" runs 0 → total
// duration; each clip contributes its trimmed length [inPoint, outPoint]. These
// pure functions convert between a global timeline time and the concrete
// (clip + source time) it corresponds to. They are the heart of playback and
// are reused at export time, so they take `clips` explicitly and hold no state.
// ---------------------------------------------------------------------------

import type { Clip } from '../types';
import { clipDuration } from './duration';

export interface TimelineSegment {
  clip: Clip;
  index: number;
  start: number; // global start time of this clip (seconds)
  end: number; // global end time of this clip (seconds)
}

/** Lay clips end-to-end and return each one's global [start, end) window. */
export function buildSegments(clips: Clip[]): TimelineSegment[] {
  let cursor = 0;
  return clips.map((clip, index) => {
    const start = cursor;
    const end = cursor + clipDuration(clip);
    cursor = end;
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
      const offset = time - seg.start; // into the trimmed window
      const localTime = Math.min(seg.clip.inPoint + offset, seg.clip.outPoint);
      return { index: i, clip: seg.clip, segment: seg, localTime, globalTime: time };
    }
  }
  return null;
}

/** Inverse of locate's offset: a source time within a segment -> global time. */
export function sourceToGlobal(segment: TimelineSegment, sourceTime: number): number {
  return segment.start + (sourceTime - segment.clip.inPoint);
}
