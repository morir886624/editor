// ---------------------------------------------------------------------------
// Export-side rasterization for decorative frames (stage 9A).
//
// Two PNGs feed the FFmpeg frame-composite graph (exportFilters.
// frameCompositeGraph):
//  - the background: the SAME SVG the preview shows as a CSS background,
//    rasterized by the browser at the full output size (the SVG carries
//    explicit width/height so engines rasterize at target resolution rather
//    than upscaling an intrinsic size);
//  - the rounded-corner mask: a white rounded rectangle on black, drawn with
//    canvas arcs from the same pixel geometry as the preview's border-radius.
//    FFmpeg alphamerges it onto the scaled video — a per-pixel alpha copy,
//    orders of magnitude faster in wasm than a geq expression mask.
// ---------------------------------------------------------------------------

import type { AspectRatio, FrameSettings } from '../types';
import { frameBackgroundSvg } from './frame';

/** canvas -> PNG bytes (same pattern as the overlay rasterizer). */
const pngBytes = (canvas: HTMLCanvasElement): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Rendering the frame graphics failed.'));
        return;
      }
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, 'image/png');
  });

/** Rasterize the frame's background SVG to a W×H PNG. */
export async function rasterizeFrameBackground(
  frame: FrameSettings,
  aspect: AspectRatio,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const svg = frameBackgroundSvg(frame, aspect, width, height);
  if (!svg) throw new Error('This frame type has no background to render.');
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Rendering the frame background failed.'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas for the frame background.');
  ctx.drawImage(img, 0, 0, width, height);
  return pngBytes(canvas);
}

/** Manual rounded-rect path (arcs) — no dependency on ctx.roundRect. */
function pathRoundedRect(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(w - radius, 0);
  ctx.arc(w - radius, radius, radius, -Math.PI / 2, 0);
  ctx.lineTo(w, h - radius);
  ctx.arc(w - radius, h - radius, radius, 0, Math.PI / 2);
  ctx.lineTo(radius, h);
  ctx.arc(radius, h - radius, radius, Math.PI / 2, Math.PI);
  ctx.lineTo(0, radius);
  ctx.arc(radius, radius, radius, Math.PI, (3 * Math.PI) / 2);
  ctx.closePath();
}

/**
 * Grayscale alpha mask for the video's rounded corners: white rounded rect on
 * black, at the exact pixel size the video is scaled to before alphamerge.
 */
export async function renderRoundedMask(
  width: number,
  height: number,
  radiusPx: number,
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas for the corner mask.');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  pathRoundedRect(ctx, width, height, radiusPx);
  ctx.fill();
  return pngBytes(canvas);
}
