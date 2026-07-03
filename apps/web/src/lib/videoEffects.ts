// ---------------------------------------------------------------------------
// Trending video effects (stage 8) — pure, playhead-driven rendering.
//
// Effects are stored on the clip as parameters (ClipEffect[]) and rendered by
// computeEffectsFrame(clip, localT): a pure function of the clip's LOCAL
// timeline time (t − clip.position), so an effect looks identical while
// playing, scrubbing forward/backward, and — batch 4 — at export. Same
// philosophy as computeOverlayRender for text: the playhead-derived value IS
// the animation; no CSS transitions/animations on the affected props.
//
// Batch 1 effects render as CSS on the preview:
//  - zoom (Ken Burns) / shake  -> a transform composed onto the <video>
//    element AFTER any transition transform;
//  - vignette / grain / flash  -> dedicated overlay layers inside the frame
//    (radial gradient, tiled noise texture, white wash), driven per frame.
// Shake uses a sum-of-sines pseudo-noise — smooth, deterministic, and
// expressible later as an FFmpeg rotate/crop expression (sin() exists there).
// Grain's noise TEXTURE is generated once per session (random), only its
// per-frame offset is deterministic; export will use FFmpeg's noise filter —
// same character, not bit-identical (accepted preview-grade gap, like the
// temperature color mapping).
// ---------------------------------------------------------------------------

import type { Clip, ClipEffect, VideoEffectType } from '../types';
import { clipDuration } from './duration';

export const EFFECT_OPTIONS: { id: VideoEffectType; label: string; hint: string }[] = [
  { id: 'zoom', label: 'Ken Burns', hint: 'Slow push in / pull out' },
  { id: 'shake', label: 'Shake', hint: 'Handheld camera shake' },
  { id: 'vignette', label: 'Vignette', hint: 'Darkened corners' },
  { id: 'grain', label: 'Film grain', hint: 'Animated noise texture' },
  { id: 'flash', label: 'Flash', hint: 'White burst at the effect start' },
];

export const DEFAULT_EFFECT_INTENSITY = 50;

/**
 * Canonical stacking order (spec: "effects render in a defined order").
 * Transforms compose zoom-then-shake; the overlay effects are independent
 * layers painted above the video in this order. The clip's array order is
 * the user's ADD order; rendering always re-sorts by this list.
 */
export const EFFECT_RENDER_ORDER: VideoEffectType[] = [
  'zoom',
  'shake',
  'vignette',
  'grain',
  'flash',
];

/** Seconds a flash burst takes to decay back to zero. */
export const FLASH_DECAY = 0.45;

/** Everything the preview needs to draw one frame of a clip's effect stack. */
export interface EffectsFrame {
  /** CSS transform fragment ('' = identity), composed after any transition
   *  transform on the <video> element. */
  transform: string;
  vignette: number; // 0..1 opacity of the vignette layer
  grain: { opacity: number; x: number; y: number } | null; // offset in px
  flash: number; // 0..1 opacity of the white layer
}

export const IDENTITY_EFFECTS_FRAME: EffectsFrame = {
  transform: '',
  vignette: 0,
  grain: null,
  flash: 0,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The effect's active window clamped against the clip's CURRENT duration —
 * read-time clamping, so stored times survive trims (cf. transitions).
 */
export function effectWindow(
  effect: Pick<ClipEffect, 'start' | 'end'>,
  duration: number,
): { start: number; end: number } {
  const start = clamp(effect.start ?? 0, 0, duration);
  const end = clamp(effect.end ?? duration, start, duration);
  return { start, end };
}

/** Deterministic handheld-shake offsets (percent of frame + degrees). */
export function shakeOffsets(t: number, intensity: number) {
  const a = 3 * (intensity / 100); // max ±3% of the frame at 100
  const w = 2 * Math.PI;
  return {
    x: a * (0.6 * Math.sin(w * 2.7 * t) + 0.4 * Math.sin(w * 7.3 * t + 1.3)),
    y: a * (0.6 * Math.sin(w * 3.1 * t + 2.1) + 0.4 * Math.sin(w * 8.9 * t + 0.7)),
    rot: a * 0.4 * Math.sin(w * 5.3 * t + 0.5), // degrees
  };
}

/** Ken Burns scale at progress p (0..1) of the effect window. */
export function kenBurnsScale(p: number, intensity: number, direction: 'in' | 'out') {
  const k = 0.5 * (intensity / 100); // up to +50% at 100
  return direction === 'out' ? 1 + k * (1 - p) : 1 + k * p;
}

// Cheap deterministic hash -> [0,1), for the grain's per-frame jitter.
const hash01 = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Render a clip's effect stack at local timeline time `localT` (seconds since
 * the clip's start on the timeline). Pure — no DOM, no randomness beyond the
 * deterministic hash.
 */
export function computeEffectsFrame(clip: Clip, localT: number): EffectsFrame {
  const effects = clip.effects;
  if (!effects || effects.length === 0) return IDENTITY_EFFECTS_FRAME;

  const duration = clipDuration(clip);
  const ordered = [...effects].sort(
    (a, b) => EFFECT_RENDER_ORDER.indexOf(a.type) - EFFECT_RENDER_ORDER.indexOf(b.type),
  );

  const transforms: string[] = [];
  let vignette = 0;
  let flash = 0;
  let grain: EffectsFrame['grain'] = null;

  for (const fx of ordered) {
    const { start, end } = effectWindow(fx, duration);
    if (end <= start || localT < start || localT >= end) continue;
    const k = fx.intensity / 100;

    switch (fx.type) {
      case 'zoom': {
        const p = (localT - start) / (end - start);
        const scale = kenBurnsScale(p, fx.intensity, fx.direction ?? 'in');
        transforms.push(`scale(${scale.toFixed(4)})`);
        break;
      }
      case 'shake': {
        const o = shakeOffsets(localT, fx.intensity);
        transforms.push(
          `translate(${o.x.toFixed(3)}%, ${o.y.toFixed(3)}%) rotate(${o.rot.toFixed(3)}deg)`,
        );
        break;
      }
      case 'vignette':
        vignette = Math.max(vignette, k);
        break;
      case 'grain': {
        const opacity = 0.6 * k;
        if (!grain || opacity > grain.opacity) {
          const frame = Math.floor(localT * 24); // re-jitter at ~24fps
          grain = {
            opacity,
            x: Math.floor(hash01(frame) * 96),
            y: Math.floor(hash01(frame + 0.5) * 96),
          };
        }
        break;
      }
      case 'flash': {
        const dt = localT - start; // burst at the window start, then decay
        flash = Math.max(flash, k * Math.max(0, 1 - dt / FLASH_DECAY));
        break;
      }
    }
  }

  return { transform: transforms.join(' '), vignette, grain, flash };
}

// ---- grain texture ---------------------------------------------------------
// A small tiled gray-noise PNG, generated once per session. Neutral gray plus
// random deviation works with mix-blend-mode: overlay (128 = no change).

let grainUrl: string | null = null;

export function grainTextureUrl(): string {
  if (grainUrl) return grainUrl;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 96 + Math.floor(Math.random() * 64); // gray around 128
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grainUrl = canvas.toDataURL('image/png');
  return grainUrl;
}
