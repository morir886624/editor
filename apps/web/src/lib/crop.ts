// ---------------------------------------------------------------------------
// Crop geometry — pure math shared by the preview's video-element layout, the
// interactive crop editor overlay and (via exportFilters.cropFilter) the
// FFmpeg crop at export.
//
// A ClipCrop is frame-relative: x/y/w/h are fractions (0..1) of the SOURCE
// frame, so one rectangle is valid at any resolution. Rendering is always
// "crop region contain-fitted into the output frame" — the preview lays the
// <video> out to that geometry, the export runs crop -> scale/pad to it.
// ---------------------------------------------------------------------------

import type { ClipCrop } from '../types';

/** Identity crop (whole source). Stored as `undefined` on the clip. */
export const FULL_CROP: ClipCrop = { x: 0, y: 0, w: 1, h: 1 };

/** Smallest croppable side, as a fraction of the source dimension. */
export const MIN_CROP_FRACTION = 0.1;

const EPS = 1e-4;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** True when the crop shows (effectively) the whole source frame. */
export const isFullCrop = (c: ClipCrop | undefined): boolean =>
  !c || (c.x <= EPS && c.y <= EPS && c.w >= 1 - EPS && c.h >= 1 - EPS);

/** Sanitize a crop rect: sides at least MIN_CROP_FRACTION, fully inside the
 *  source. All store writes go through this, so stored crops are always valid. */
export function clampCrop(c: ClipCrop): ClipCrop {
  const w = clamp(c.w, MIN_CROP_FRACTION, 1);
  const h = clamp(c.h, MIN_CROP_FRACTION, 1);
  return { x: clamp(c.x, 0, 1 - w), y: clamp(c.y, 0, 1 - h), w, h };
}

/** Contain-fit content of a given aspect into a box: the centered rectangle
 *  it fills, as fractions of the box. */
export function containRect(
  contentAspect: number,
  boxAspect: number,
): { left: number; top: number; w: number; h: number } {
  const w = contentAspect >= boxAspect ? 1 : contentAspect / boxAspect;
  const h = contentAspect >= boxAspect ? boxAspect / contentAspect : 1;
  return { left: (1 - w) / 2, top: (1 - h) / 2, w, h };
}

/** Largest centered crop whose PIXEL aspect ratio is `targetAspect`
 *  (srcAspect/targetAspect are width/height ratios). */
export function aspectCrop(srcAspect: number, targetAspect: number): ClipCrop {
  const w = targetAspect >= srcAspect ? 1 : targetAspect / srcAspect;
  const h = targetAspect >= srcAspect ? srcAspect / targetAspect : 1;
  return clampCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

/** Ratio presets offered by the crop panel (null = free-form handles). */
export const CROP_ASPECT_OPTIONS: { id: string; label: string; ratio: number | null }[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
];

/**
 * How the <video> element must be laid out inside its viewport-sized wrapper
 * so that exactly the crop region shows, contain-fitted — the same picture
 * the export's crop -> scale/pad produces. left/top/w/h are fractions of the
 * VIEWPORT (the element spans the full source, object-fit: fill); clipPath
 * hides the source outside the crop rect, in fractions of the ELEMENT.
 */
export interface CropLayout {
  left: number;
  top: number;
  w: number;
  h: number;
  clipPath: string;
}

export function computeCropLayout(
  crop: ClipCrop | undefined,
  srcAspect: number,
  viewportAspect: number,
): CropLayout {
  const c = crop ?? FULL_CROP;
  // Where the crop REGION sits on screen: contain-fit its pixel aspect.
  const region = containRect(srcAspect * (c.w / c.h), viewportAspect);
  // Blow the full source up so its crop rect lands exactly on that region.
  const w = region.w / c.w;
  const h = region.h / c.h;
  const left = region.left - c.x * w;
  const top = region.top - c.y * h;
  const pct = (v: number) => `${(v * 100).toFixed(4)}%`;
  const clipPath = isFullCrop(c)
    ? 'none'
    : `inset(${pct(c.y)} ${pct(1 - c.x - c.w)} ${pct(1 - c.y - c.h)} ${pct(c.x)})`;
  return { left, top, w, h, clipPath };
}
