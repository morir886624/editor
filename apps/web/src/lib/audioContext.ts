// ---------------------------------------------------------------------------
// Shared Web Audio context for PLAYBACK (the preview mixer's GainNodes).
//
// Created lazily on first use — the mixer only touches it from the play loop,
// i.e. after a user gesture, so it starts in the 'running' state and avoids
// autoplay-policy warnings. Waveform DECODING deliberately does not use this
// context (it runs at import time, before any gesture) — see lib/waveform.ts,
// which decodes through a throwaway OfflineAudioContext instead.
// ---------------------------------------------------------------------------

let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}
