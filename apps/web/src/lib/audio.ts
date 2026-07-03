// ---------------------------------------------------------------------------
// Pure audio-track time/gain math.
//
// Like lib/playback.ts for video and lib/overlay.ts for text: everything is
// computed from the timeline time, so the mix is identical whether playing or
// scrubbing, and reproducible at export. The preview mixer evaluates
// audioGainAt() every frame instead of scheduling ramps — the playhead-derived
// value IS the fade.
// ---------------------------------------------------------------------------

import type { AudioTrack } from '../types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Audible (trimmed) length of the track in seconds. */
export function audioTrackDuration(track: Pick<AudioTrack, 'inPoint' | 'outPoint'>): number {
  return Math.max(0, track.outPoint - track.inPoint);
}

/** The [start, end) timeline window during which the track is audible. */
export function audioWindow(track: AudioTrack): { start: number; end: number } {
  const start = track.offset;
  return { start, end: start + audioTrackDuration(track) };
}

/** Source time the track should be playing at timeline time `t` (unclamped —
 *  callers check isAudioActiveAt / the window first). */
export function audioSourceTimeAt(track: AudioTrack, t: number): number {
  return track.inPoint + (t - track.offset);
}

/** True when timeline time `t` falls inside the track's audible window. */
export function isAudioActiveAt(track: AudioTrack, t: number): boolean {
  const { start, end } = audioWindow(track);
  return t >= start && t < end;
}

/**
 * Effective gain (0..1) of the track at timeline time `t`:
 * base volume × fade-in factor × fade-out factor, 0 outside the window.
 * If fadeIn + fadeOut exceed the track duration the factors simply overlap
 * (multiply), which stays well-behaved.
 */
export function audioGainAt(track: AudioTrack, t: number): number {
  const dur = audioTrackDuration(track);
  if (dur <= 0) return 0;
  const local = t - track.offset;
  if (local < 0 || local >= dur) return 0;

  let gain = clamp01(track.volume);
  if (track.fadeIn > 0) gain *= clamp01(local / track.fadeIn);
  if (track.fadeOut > 0) gain *= clamp01((dur - local) / track.fadeOut);
  return gain;
}
