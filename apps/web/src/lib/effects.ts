// ---------------------------------------------------------------------------
// Visual effects: filter presets + manual adjustments -> color operations.
//
// Everything is stored in the document as data (FilterPreset id + numeric
// adjustments + speed). This module translates that data into an ordered list
// of primitive COLOR OPS (the CSS filter functions: brightness/contrast/
// saturate/sepia/grayscale/hue-rotate). The ops are the single source of
// truth consumed by BOTH renderers:
//  - preview: buildClipFilter() renders the ops as a CSS `filter` string;
//  - export:  lib/exportFilters.ts renders the SAME ops as FFmpeg
//    colorchannelmixer/lutrgb filters (each CSS function is an affine RGB
//    transform per the W3C Filter Effects spec, so the look matches).
// Nothing here may bake state irreversibly.
// ---------------------------------------------------------------------------

import type { Clip, ClipAdjustments, FilterPreset } from '../types';

/** Neutral adjustments — the values at which clipColorOps adds nothing. */
export const DEFAULT_ADJUSTMENTS: ClipAdjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  temperature: 0,
};

/**
 * One primitive color operation ≡ one CSS filter function. Ops apply in list
 * order with clamping between steps (CSS filter primitives also clamp).
 */
export type ColorOp =
  | { type: 'brightness' | 'contrast' | 'saturate' | 'sepia' | 'grayscale'; value: number }
  | { type: 'hueRotate'; degrees: number };

/**
 * One-tap LUT-style presets, defined as op lists (CSS + FFmpeg derive from
 * these). All are generic color grades built from the affine CSS primitives —
 * looks that would need true split-toning or per-channel curves (e.g. the
 * orange-and-teal "cinematic" grade, cross-process) are approximated with
 * sepia/hue-rotate/saturate combos, the same approximation grade as the
 * temperature slider. The payoff: preview and export render the SAME ops,
 * so they match exactly at every intensity.
 */
export const FILTER_PRESETS: { id: FilterPreset; label: string; ops: ColorOp[] }[] = [
  { id: 'none', label: 'None', ops: [] },
  {
    id: 'warm',
    label: 'Warm',
    ops: [
      { type: 'sepia', value: 0.28 },
      { type: 'saturate', value: 1.3 },
      { type: 'brightness', value: 1.03 },
    ],
  },
  {
    id: 'cool',
    label: 'Cool',
    ops: [
      { type: 'saturate', value: 1.1 },
      { type: 'hueRotate', degrees: 12 },
      { type: 'brightness', value: 1.02 },
    ],
  },
  {
    id: 'bw',
    label: 'B&W',
    ops: [
      { type: 'grayscale', value: 1 },
      { type: 'contrast', value: 1.08 },
    ],
  },
  {
    id: 'vivid',
    label: 'Vivid',
    ops: [
      { type: 'saturate', value: 1.55 },
      { type: 'contrast', value: 1.12 },
    ],
  },
  {
    id: 'vintage',
    label: 'Vintage',
    ops: [
      { type: 'sepia', value: 0.42 },
      { type: 'contrast', value: 0.92 },
      { type: 'brightness', value: 1.05 },
      { type: 'saturate', value: 0.85 },
    ],
  },
  {
    // warm mids pushed orange, overall shift toward teal via contrast+hue
    id: 'cinematic',
    label: 'Cinematic',
    ops: [
      { type: 'contrast', value: 1.12 },
      { type: 'saturate', value: 1.3 },
      { type: 'sepia', value: 0.18 },
      { type: 'hueRotate', degrees: -8 },
    ],
  },
  {
    // lifted blacks (low contrast raises the floor), muted color, slight green cast
    id: 'film',
    label: 'Film',
    ops: [
      { type: 'contrast', value: 0.88 },
      { type: 'brightness', value: 1.04 },
      { type: 'saturate', value: 0.82 },
      { type: 'sepia', value: 0.14 },
      { type: 'hueRotate', degrees: 8 },
    ],
  },
  {
    id: 'airy',
    label: 'Bright & airy',
    ops: [
      { type: 'brightness', value: 1.12 },
      { type: 'contrast', value: 0.9 },
      { type: 'saturate', value: 0.88 },
      { type: 'hueRotate', degrees: 4 },
    ],
  },
  {
    id: 'moody',
    label: 'Moody',
    ops: [
      { type: 'brightness', value: 0.86 },
      { type: 'contrast', value: 1.2 },
      { type: 'saturate', value: 0.8 },
      { type: 'hueRotate', degrees: 12 },
    ],
  },
  {
    id: 'golden',
    label: 'Golden hour',
    ops: [
      { type: 'sepia', value: 0.45 },
      { type: 'saturate', value: 1.25 },
      { type: 'brightness', value: 1.06 },
      { type: 'hueRotate', degrees: -12 },
    ],
  },
  {
    id: 'winter',
    label: 'Cold winter',
    ops: [
      { type: 'hueRotate', degrees: 18 },
      { type: 'saturate', value: 0.85 },
      { type: 'brightness', value: 1.05 },
      { type: 'contrast', value: 1.05 },
    ],
  },
  {
    id: 'pastel',
    label: 'Faded pastel',
    ops: [
      { type: 'contrast', value: 0.78 },
      { type: 'saturate', value: 0.75 },
      { type: 'brightness', value: 1.08 },
    ],
  },
  {
    id: 'pop',
    label: 'Vibrant pop',
    ops: [
      { type: 'saturate', value: 1.7 },
      { type: 'contrast', value: 1.15 },
      { type: 'brightness', value: 1.02 },
    ],
  },
  {
    id: 'matte',
    label: 'Matte',
    ops: [
      { type: 'contrast', value: 0.82 },
      { type: 'brightness', value: 1.02 },
      { type: 'saturate', value: 0.95 },
      { type: 'sepia', value: 0.08 },
    ],
  },
  {
    id: 'hcbw',
    label: 'B&W punch',
    ops: [
      { type: 'grayscale', value: 1 },
      { type: 'contrast', value: 1.35 },
      { type: 'brightness', value: 1.02 },
    ],
  },
  {
    id: 'sepia',
    label: 'Sepia',
    ops: [
      { type: 'sepia', value: 0.85 },
      { type: 'contrast', value: 0.95 },
      { type: 'brightness', value: 1.03 },
    ],
  },
  {
    // high contrast + saturation with a green/yellow shift, like crossed chemistry
    id: 'crossprocess',
    label: 'Cross-process',
    ops: [
      { type: 'contrast', value: 1.22 },
      { type: 'saturate', value: 1.28 },
      { type: 'sepia', value: 0.18 },
      { type: 'hueRotate', degrees: 28 },
    ],
  },
];

/** Playback speed choices offered by the effects panel (0.25x..4x). */
export const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** Slider ranges for the manual adjustments. */
export const ADJUSTMENT_RANGES = {
  brightness: { min: 50, max: 150, step: 1 },
  contrast: { min: 50, max: 150, step: 1 },
  saturation: { min: 0, max: 200, step: 1 },
  temperature: { min: -50, max: 50, step: 1 },
} as const;

/**
 * Blend a preset's ops toward "no-op" by strength k (0..1): multiplicative
 * ops lerp toward 1, additive ops (sepia/grayscale) toward 0, hue toward 0°.
 * Each CSS primitive is affine in its parameter, so lerping the parameter
 * lerps the transform — and both renderers consume the blended list, so
 * preview and export agree at every intensity.
 */
export function blendOps(ops: ColorOp[], k: number): ColorOp[] {
  if (k >= 1) return ops;
  if (k <= 0) return [];
  return ops.map((op): ColorOp => {
    if (op.type === 'hueRotate') return { type: 'hueRotate', degrees: op.degrees * k };
    if (op.type === 'sepia' || op.type === 'grayscale')
      return { type: op.type, value: op.value * k };
    return { type: op.type, value: 1 + (op.value - 1) * k };
  });
}

/**
 * The full ordered op list for a clip: preset ops (scaled by the clip's
 * filterIntensity) first, then manual adjustments. Temperature is approximated
 * as warm = sepia + slight negative hue shift, cool = positive hue shift — a
 * preview-grade stand-in for a real color-temperature curve, but preview and
 * export share it, so they match.
 */
export function clipColorOps(
  clip: Pick<Clip, 'filter' | 'filterIntensity' | 'adjustments'>,
): ColorOp[] {
  const preset = FILTER_PRESETS.find((p) => p.id === clip.filter);
  const ops: ColorOp[] = blendOps(preset?.ops ?? [], clip.filterIntensity / 100);

  const a = clip.adjustments;
  if (a.brightness !== 100) ops.push({ type: 'brightness', value: a.brightness / 100 });
  if (a.contrast !== 100) ops.push({ type: 'contrast', value: a.contrast / 100 });
  if (a.saturation !== 100) ops.push({ type: 'saturate', value: a.saturation / 100 });
  if (a.temperature > 0) {
    ops.push({ type: 'sepia', value: a.temperature / 125 });
    ops.push({ type: 'hueRotate', degrees: -a.temperature * 0.2 });
  } else if (a.temperature < 0) {
    ops.push({ type: 'hueRotate', degrees: -a.temperature * 0.35 });
  }
  return ops;
}

// Up to 3 decimals, trailing zeros trimmed (0.28 -> "0.28", 12 -> "12").
const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

const CSS_NAME: Record<Exclude<ColorOp['type'], 'hueRotate'>, string> = {
  brightness: 'brightness',
  contrast: 'contrast',
  saturate: 'saturate',
  sepia: 'sepia',
  grayscale: 'grayscale',
};

/** Render an op list as a CSS `filter` value ('none' when empty). */
export function opsToCssFilter(ops: ColorOp[]): string {
  if (ops.length === 0) return 'none';
  return ops
    .map((op) =>
      op.type === 'hueRotate'
        ? `hue-rotate(${fmt(op.degrees)}deg)`
        : `${CSS_NAME[op.type]}(${fmt(op.value)})`,
    )
    .join(' ');
}

/** Render a clip's ops as a CSS `filter` value for the preview <video>. */
export function buildClipFilter(
  clip: Pick<Clip, 'filter' | 'filterIntensity' | 'adjustments'>,
): string {
  return opsToCssFilter(clipColorOps(clip));
}

/** CSS filter for a preset swatch at full strength (the panel's thumbnail grid). */
export function presetCssFilter(id: FilterPreset): string {
  return opsToCssFilter(FILTER_PRESETS.find((p) => p.id === id)?.ops ?? []);
}
