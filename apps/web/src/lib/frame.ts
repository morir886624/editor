// ---------------------------------------------------------------------------
// Decorative frames (stage 9A) — pure geometry + background art.
//
// The video is scaled down and composited inside a styled frame filling the
// project's aspect ratio. Everything is stored as parameters
// (ProjectSettings.frame); all sizes are PERCENTAGES OF THE OUTPUT'S SHORT
// SIDE so the same numbers produce the same look in the preview, in
// fullscreen, and at any export resolution.
//
// Two shared seams keep preview and export identical (same philosophy as
// clipColorOps for color):
//  - frameLayout() — where the video rectangle sits inside the frame, as
//    fractions of the frame's width/height plus a corner radius in % of the
//    short side. The preview positions its video viewport with these as CSS
//    percentages and rounds corners with border-radius in `cqmin` (1cqmin =
//    1% of the frame's short side — .preview__frame is a size container);
//    the export converts the SAME fractions to pixels
//    (exportFilters.framePixelLayout) and rounds corners by alphamerging a
//    canvas-drawn rounded-rect mask before overlaying.
//  - frameBackgroundSvg() — the frame's background art as one SVG string.
//    The preview paints it as a background-image data URL (vector, so it is
//    crisp at any panel size); the export rasterizes the SAME SVG to a W×H
//    PNG (lib/frameRaster.ts) and overlays the video onto it.
//
// The blurred-fill background has no SVG: it derives from the video itself
// (preview: low-res canvas copy + CSS blur; export: split/boxblur graph —
// a preview-grade approximation by design, like the temperature mapping).
// ---------------------------------------------------------------------------

import type { AspectRatio, FrameSettings, FrameType } from '../types';

export const DEFAULT_FRAME: FrameSettings = {
  type: 'none',
  inset: 6,
  cornerRadius: 3,
  color: '#000000',
  caption: '',
};

export const FRAME_TYPE_OPTIONS: { id: FrameType; label: string; hint: string }[] = [
  { id: 'none', label: 'None', hint: 'Video fills the frame' },
  { id: 'solid', label: 'Solid color', hint: 'Video inset on a solid background' },
  { id: 'polaroid', label: 'Polaroid', hint: 'Photo frame with a caption band' },
  { id: 'filmstrip', label: 'Film strip', hint: 'Sprocket holes along the edges' },
  { id: 'blur', label: 'Blurred fill', hint: 'Background is a blurred copy of the video' },
];

/** Slider ranges (% of the short side). */
export const FRAME_INSET_RANGE = { min: 0, max: 20, step: 0.5 } as const;
export const FRAME_RADIUS_RANGE = { min: 0, max: 20, step: 0.5 } as const;

/** Extra bottom band below the video on a polaroid, % of the short side. */
export const POLAROID_BOTTOM_EXTRA = 16;
/** Minimum polaroid border — a polaroid is never borderless. */
export const POLAROID_MIN_INSET = 3;
/** Minimum film-strip sprocket-bar thickness (needs room for the holes). */
export const FILMSTRIP_BAR_MIN = 11;

/** Blurred-fill parameters — shared by the preview canvas and the export
 *  boxblur graph so both renderers derive the same look. */
export const BLUR_ZOOM = 1.18; // background is a zoomed copy of the video
export const BLUR_RADIUS_PCT = 2; // blur radius, % of the short side
export const BLUR_DIM = 0.82; // brightness multiplier on the background

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Frame dimensions in "short units": the short side is exactly 1. */
export function aspectDims(aspect: AspectRatio): { w: number; h: number } {
  if (aspect === '9:16') return { w: 1, h: 16 / 9 };
  if (aspect === '16:9') return { w: 16 / 9, h: 1 };
  return { w: 1, h: 1 };
}

/** Where the video rectangle sits inside the frame. */
export interface FrameLayout {
  /** Video rectangle as fractions (0..1) of the frame's width/height. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Inner corner radius, % of the frame's short side (0 = square). */
  radiusPct: number;
}

const FULL_BLEED: FrameLayout = { x: 0, y: 0, w: 1, h: 1, radiusPct: 0 };

/**
 * Pure geometry: per-type edge insets -> video rectangle. The corner radius
 * is clamped at READ time against the video rectangle (radius can never
 * exceed half its smaller side), so any stored combination stays valid.
 */
export function frameLayout(frame: FrameSettings, aspect: AspectRatio): FrameLayout {
  if (frame.type === 'none') return FULL_BLEED;
  const { w: fw, h: fh } = aspectDims(aspect); // short side = 1

  const inset = clamp(frame.inset, FRAME_INSET_RANGE.min, FRAME_INSET_RANGE.max) / 100;
  let left = inset;
  let right = inset;
  let top = inset;
  let bottom = inset;

  if (frame.type === 'polaroid') {
    const side = Math.max(inset, POLAROID_MIN_INSET / 100);
    left = right = top = side;
    bottom = side + POLAROID_BOTTOM_EXTRA / 100;
  } else if (frame.type === 'filmstrip') {
    // Sprocket bars run along the LONG edges of the frame; the transverse
    // edges keep only a sliver of the inset so the strip reads as continuous.
    const bar = Math.max(inset, FILMSTRIP_BAR_MIN / 100);
    const across = inset * 0.35;
    if (fh >= fw) {
      left = right = bar;
      top = bottom = across;
    } else {
      top = bottom = bar;
      left = right = across;
    }
  }

  const vw = fw - left - right;
  const vh = fh - top - bottom;
  const radiusPct = Math.min(
    clamp(frame.cornerRadius, 0, FRAME_RADIUS_RANGE.max),
    (Math.min(vw, vh) / 2) * 100,
  );
  return { x: left / fw, y: top / fh, w: vw / fw, h: vh / fh, radiusPct };
}

// ---- background art (SVG, shared by preview + export) -----------------------

/** SVG viewBox units for the short side: 1 unit = 0.1% of it. */
const SVG_SHORT = 1000;

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Perceived luminance 0..1 of a #rrggbb color (for caption contrast). */
export function hexLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The frame's background as an SVG string, or null when the frame has none
 * ('none', and 'blur' whose background derives from the video). Pass pixel
 * dimensions at export so browsers rasterize the SVG at full output size
 * instead of upscaling its intrinsic size.
 */
export function frameBackgroundSvg(
  frame: FrameSettings,
  aspect: AspectRatio,
  pxWidth?: number,
  pxHeight?: number,
): string | null {
  if (frame.type === 'none' || frame.type === 'blur') return null;
  const { w: fw, h: fh } = aspectDims(aspect);
  const W = r1(fw * SVG_SHORT);
  const H = r1(fh * SVG_SHORT);
  const l = frameLayout(frame, aspect);
  const vx = r1(l.x * W);
  const vy = r1(l.y * H);
  const vw = r1(l.w * W);
  const vh = r1(l.h * H);
  const radius = r1(l.radiusPct * (SVG_SHORT / 100));

  const parts: string[] = [];

  if (frame.type === 'filmstrip') {
    parts.push(`<rect width="${W}" height="${H}" fill="#0d0d0f"/>`);
    // Sprocket holes centered in each bar, evenly spaced along the strip.
    const vertical = fh >= fw;
    const bar = vertical ? vx : vy; // bar thickness in svg units
    const along = vertical ? H : W; // strip length
    const holeAlong = r1(bar * 0.42); // hole size along the strip
    const holeAcross = r1(bar * 0.34);
    const rx = r1(holeAcross * 0.32);
    const pitch = bar * 0.8;
    const count = Math.max(1, Math.floor(along / pitch));
    const start = (along - count * pitch) / 2 + (pitch - holeAlong) / 2;
    for (let k = 0; k < count; k++) {
      const a = r1(start + k * pitch);
      for (const center of [bar / 2, (vertical ? W : H) - bar / 2]) {
        const across = r1(center - holeAcross / 2);
        parts.push(
          vertical
            ? `<rect x="${across}" y="${a}" width="${holeAcross}" height="${holeAlong}" rx="${rx}" fill="#e9e7dc"/>`
            : `<rect x="${a}" y="${across}" width="${holeAlong}" height="${holeAcross}" rx="${rx}" fill="#e9e7dc"/>`,
        );
      }
    }
  } else {
    parts.push(`<rect width="${W}" height="${H}" fill="${escapeXml(frame.color)}"/>`);
  }

  if (frame.type === 'polaroid') {
    // Subtle "photo well" shadow line around the video opening.
    parts.push(
      `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="${radius}"` +
        ` fill="none" stroke="rgba(0,0,0,0.22)" stroke-width="7"/>`,
    );
    const caption = frame.caption.trim();
    if (caption) {
      const bandTop = vy + vh;
      const bandH = H - bandTop;
      const fontSize = r1(Math.min(bandH * 0.42, 90));
      const fill = hexLuminance(frame.color) > 0.55 ? '#41403c' : '#ece9e2';
      parts.push(
        `<text x="${r1(W / 2)}" y="${r1(bandTop + bandH / 2)}" text-anchor="middle"` +
          ` dominant-baseline="central" font-family="'Segoe Script','Bradley Hand',cursive"` +
          ` font-size="${fontSize}" fill="${fill}">${escapeXml(caption)}</text>`,
      );
    }
  }

  const size = pxWidth && pxHeight ? ` width="${pxWidth}" height="${pxHeight}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"${size}>` +
    parts.join('') +
    '</svg>'
  );
}

/** The background SVG as a data URL for CSS background-image (null = none). */
export function frameBackgroundUrl(frame: FrameSettings, aspect: AspectRatio): string | null {
  const svg = frameBackgroundSvg(frame, aspect);
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
}
