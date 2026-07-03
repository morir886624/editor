// ---------------------------------------------------------------------------
// Export-side translation of stored effect data into FFmpeg filter strings,
// plus resolution/aspect geometry and speed helpers.
//
// Color fidelity: every CSS filter function the preview uses (brightness /
// contrast / saturate / sepia / grayscale / hue-rotate) is defined by the W3C
// Filter Effects spec as an affine transform of non-premultiplied sRGB. We
// emit ONE FFmpeg filter per op, in op order, exactly mirroring how CSS
// applies (and clamps between) filter primitives:
//  - pure-matrix ops -> colorchannelmixer (coefficients from the spec);
//  - contrast (matrix + offset) -> lutrgb with an affine expression.
// Both operate on gamma-encoded RGB like CSS, so preview and export match up
// to yuv<->rgb conversion rounding.
// ---------------------------------------------------------------------------

import type { AspectRatio, ExportResolution, FrameSettings, TransitionType } from '../types';
import type { ColorOp } from './effects';
import { BLUR_DIM, BLUR_RADIUS_PCT, BLUR_ZOOM, frameLayout } from './frame';

// ---- geometry ---------------------------------------------------------------

export const RESOLUTION_OPTIONS: { id: ExportResolution; label: string; short: number }[] = [
  { id: '480p', label: '480p', short: 480 },
  { id: '720p', label: '720p (HD)', short: 720 },
  { id: '1080p', label: '1080p (Full HD)', short: 1080 },
  { id: '1440p', label: '1440p (2K)', short: 1440 },
  { id: '2160p', label: '2160p (4K)', short: 2160 },
];

const even = (n: number) => 2 * Math.round(n / 2);

/** Output pixel dimensions for a resolution (short side) + aspect ratio. */
export function exportDimensions(
  aspect: AspectRatio,
  resolution: ExportResolution,
): { width: number; height: number } {
  const short = RESOLUTION_OPTIONS.find((r) => r.id === resolution)?.short ?? 1080;
  const long = even((short * 16) / 9);
  if (aspect === '9:16') return { width: short, height: long };
  if (aspect === '16:9') return { width: long, height: short };
  return { width: short, height: short };
}

// ---- quality ---------------------------------------------------------------

export type ExportQuality = 'high' | 'small';

/** x264 settings per quality toggle (preset kept fast — wasm is the bottleneck). */
export const QUALITY_SETTINGS: Record<ExportQuality, { crf: number; preset: string; label: string }> = {
  high: { crf: 18, preset: 'veryfast', label: 'High quality' },
  small: { crf: 28, preset: 'veryfast', label: 'Smaller file' },
};

// ---- color op -> FFmpeg filter ----------------------------------------------

type Mat3 = number[]; // 9 numbers, row-major; rows produce R', G', B'

// Matrices from the W3C Filter Effects spec (feColorMatrix equivalents).
function saturateMatrix(s: number): Mat3 {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
}

const SEPIA_FULL: Mat3 = [
  0.393, 0.769, 0.189,
  0.349, 0.686, 0.168,
  0.272, 0.534, 0.131,
];
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function sepiaMatrix(a: number): Mat3 {
  return SEPIA_FULL.map((v, i) => v * a + IDENTITY[i] * (1 - a));
}

function hueRotateMatrix(degrees: number): Mat3 {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}

const f6 = (n: number) => n.toFixed(6);

function channelMixer(m: Mat3): string {
  return (
    `colorchannelmixer=` +
    `rr=${f6(m[0])}:rg=${f6(m[1])}:rb=${f6(m[2])}:` +
    `gr=${f6(m[3])}:gg=${f6(m[4])}:gb=${f6(m[5])}:` +
    `br=${f6(m[6])}:bg=${f6(m[7])}:bb=${f6(m[8])}`
  );
}

/** CSS contrast(c): x' = x*c + (0.5 - 0.5c), per RGB channel, clamped. */
function contrastLut(c: number): string {
  const expr = `clip(val*${f6(c)}+${f6(0.5 - 0.5 * c)}*maxval\\,minval\\,maxval)`;
  return `lutrgb=r='${expr}':g='${expr}':b='${expr}'`;
}

/**
 * One FFmpeg filter per color op, in order. Emitting per-op (instead of one
 * composed matrix) both matches CSS's per-primitive clamping and keeps every
 * colorchannelmixer coefficient inside its allowed [-2, 2] range.
 */
export function colorOpFilters(ops: ColorOp[]): string[] {
  return ops.map((op) => {
    switch (op.type) {
      case 'brightness': {
        const b = op.value;
        return channelMixer([b, 0, 0, 0, b, 0, 0, 0, b]);
      }
      case 'contrast':
        return contrastLut(op.value);
      case 'saturate':
        return channelMixer(saturateMatrix(op.value));
      case 'grayscale':
        // CSS grayscale(a) is saturate(1 - a).
        return channelMixer(saturateMatrix(1 - op.value));
      case 'sepia':
        return channelMixer(sepiaMatrix(op.value));
      case 'hueRotate':
        return channelMixer(hueRotateMatrix(op.degrees));
    }
  });
}

// ---- decorative frame (stage 9A) ---------------------------------------------

/** The video rectangle inside the W×H output, in pixels. */
export interface FramePixelLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Inner corner radius in pixels (0 = square, no mask needed). */
  radius: number;
}

/**
 * frameLayout()'s fractions converted to output pixels. Width/height and
 * x/y are rounded to EVEN values so the scaled video and its overlay offset
 * stay chroma-aligned in yuv420p.
 */
export function framePixelLayout(
  frame: FrameSettings,
  aspect: AspectRatio,
  W: number,
  H: number,
): FramePixelLayout {
  const l = frameLayout(frame, aspect);
  const w = Math.max(2, even(l.w * W));
  const h = Math.max(2, even(l.h * H));
  const x = Math.max(0, Math.min(even(l.x * W), W - w));
  const y = Math.max(0, Math.min(even(l.y * H), H - h));
  const radius = Math.min(
    Math.round((l.radiusPct / 100) * Math.min(W, H)),
    Math.floor(Math.min(w, h) / 2),
  );
  return { x, y, w, h, radius };
}

/**
 * filter_complex compositing the joined timeline video ([0:v], W×H) into the
 * project frame, labeled [vout]:
 *   background  — either the looped background PNG (input `bgIndex`), or for
 *                 blurred-fill (bgIndex = -1) a zoomed + boxblurred + dimmed
 *                 split of the video itself (BLUR_* constants shared with the
 *                 preview canvas);
 *   video       — scaled down to the layout rectangle; when the corners are
 *                 rounded (maskIndex >= 0) the single-frame mask PNG is
 *                 alphamerged on as the alpha channel (framesync repeatlast
 *                 holds the frame, so the merge ends WITH the video — a
 *                 looped mask would keep the graph alive forever);
 *   composite   — overlay at the layout offset. shortest=1 ends the output
 *                 with the video when the background is an endlessly looped
 *                 still.
 */
export function frameCompositeGraph(
  layout: FramePixelLayout,
  W: number,
  H: number,
  bgIndex: number,
  maskIndex: number,
): string {
  const parts: string[] = [];
  let fgIn = '[0:v]';
  let bgLabel: string;

  if (bgIndex >= 0) {
    bgLabel = `[${bgIndex}:v]`;
  } else {
    const zw = even(W * BLUR_ZOOM);
    const zh = even(H * BLUR_ZOOM);
    const r = Math.max(2, Math.round((BLUR_RADIUS_PCT / 100) * Math.min(W, H)));
    const dim = colorOpFilters([{ type: 'brightness', value: BLUR_DIM }]).join(',');
    parts.push('[0:v]split=2[xfb][xff]');
    parts.push(`[xfb]scale=${zw}:${zh},crop=${W}:${H},boxblur=${r}:2,${dim}[xfbg]`);
    fgIn = '[xff]';
    bgLabel = '[xfbg]';
  }

  if (maskIndex >= 0) {
    parts.push(`${fgIn}scale=${layout.w}:${layout.h},format=yuva420p[xffg]`);
    parts.push(`[xffg][${maskIndex}:v]alphamerge[xfa]`);
  } else {
    parts.push(`${fgIn}scale=${layout.w}:${layout.h}[xfa]`);
  }

  parts.push(
    `${bgLabel}[xfa]overlay=x=${layout.x}:y=${layout.y}:shortest=1,format=yuv420p[vout]`,
  );
  return parts.join(';');
}

// ---- transitions --------------------------------------------------------------

/** Our transition ids -> FFmpeg xfade transition names. */
const XFADE_NAMES: Record<TransitionType, string> = {
  crossfade: 'fade',
  fadeblack: 'fadeblack',
  slide: 'slideleft',
  zoom: 'zoomin',
};

/** One seam between segment i and i+1: a transition, or null for a hard cut. */
export type SeamSpec = { type: TransitionType; duration: number } | null;

const sec4 = (n: number) => Math.max(0, n).toFixed(4);

/**
 * filter_complex joining N normalized video segments (inputs [0:v]..[N-1:v],
 * identical size/fps/format) into one stream labeled [vout]. Transition seams
 * use xfade (the incoming segment overlaps the accumulated stream's tail by
 * the transition duration — `offset` is where the overlap starts in the
 * accumulated stream); hard cuts use the concat filter. The accumulated
 * running duration therefore mirrors sequenceClips()/buildSegments() exactly.
 */
export function transitionVideoGraph(segDurations: number[], seams: SeamSpec[]): string {
  const parts: string[] = [];
  let label = '0:v';
  let acc = segDurations[0] ?? 0;
  for (let i = 0; i < seams.length; i++) {
    const out = i === seams.length - 1 ? 'vout' : `vx${i}`;
    const seam = seams[i];
    if (seam) {
      parts.push(
        `[${label}][${i + 1}:v]xfade=transition=${XFADE_NAMES[seam.type]}` +
          `:duration=${sec4(seam.duration)}:offset=${sec4(acc - seam.duration)}[${out}]`,
      );
      acc += segDurations[i + 1] - seam.duration;
    } else {
      parts.push(`[${label}][${i + 1}:v]concat=n=2:v=1:a=0[${out}]`);
      acc += segDurations[i + 1];
    }
    label = out;
  }
  return parts.join(';');
}

/**
 * Audio counterpart: joins N PCM segments (inputs [0:a]..) into [aout].
 * acrossfade's default triangular curves are linear gain ramps — the same
 * blend the preview mixer applies during a transition.
 */
export function transitionAudioGraph(seams: SeamSpec[]): string {
  const parts: string[] = [];
  let label = '0:a';
  for (let i = 0; i < seams.length; i++) {
    const out = i === seams.length - 1 ? 'aout' : `ax${i}`;
    const seam = seams[i];
    if (seam) {
      parts.push(`[${label}][${i + 1}:a]acrossfade=d=${sec4(seam.duration)}[${out}]`);
    } else {
      parts.push(`[${label}][${i + 1}:a]concat=n=2:v=0:a=1[${out}]`);
    }
    label = out;
  }
  return parts.join(';');
}

// ---- speed ------------------------------------------------------------------

/**
 * atempo filter chain for a playback speed. A single atempo instance accepts
 * [0.5, 100]; slower speeds are factored into repeated 0.5 stages
 * (0.25 -> atempo=0.5,atempo=0.5). The factors multiply back to `speed`.
 */
export function atempoChain(speed: number): string[] {
  const parts: string[] = [];
  let s = speed > 0 ? speed : 1;
  while (s < 0.5) {
    parts.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-9) parts.push(`atempo=${f6(s)}`);
  return parts;
}
