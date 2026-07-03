// ---------------------------------------------------------------------------
// Timeline scale + time formatting.
// ---------------------------------------------------------------------------

import { MAX_TIMELINE_DURATION } from './duration';

/** Horizontal scale of the timeline. Tweak to zoom the whole timeline. */
export const PIXELS_PER_SECOND = 16;

/** Spacing between ruler ticks (seconds). */
export const RULER_TICK_SECONDS = 5;

export const secondsToPx = (seconds: number): number => seconds * PIXELS_PER_SECOND;
export const pxToSeconds = (px: number): number => px / PIXELS_PER_SECOND;

/** Full pixel width of the 0–60s budget — the timeline content width. */
export const TIMELINE_WIDTH = secondsToPx(MAX_TIMELINE_DURATION);

/** Format seconds as mm:ss (e.g. 75 -> "01:15"). */
export function formatTime(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(whole / 60);
  const ss = whole % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** Format seconds as mm:ss.cs (centiseconds), e.g. 75.42 -> "01:15.42". */
export function formatTimecode(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(mm)}:${pad(ss)}.${pad(cs)}`;
}
