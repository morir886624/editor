// ---------------------------------------------------------------------------
// Export-side text overlay rasterization.
//
// The preview renders overlays as DOM; FFmpeg's drawtext cannot reproduce the
// same fonts, outline, shadow, background box, or easing curves. So the export
// draws the overlay layer onto a transparent canvas — using the SAME pure
// motion math (computeOverlayMotion) and the same browser text engine as the
// preview — and feeds the frames to FFmpeg as a timed PNG sequence composited
// with one `overlay` filter.
//
// To keep the frame count (and MEMFS memory) small, sampling is ADAPTIVE:
//  - intervals where some visible overlay is inside its enter/exit ramp are
//    sampled at the output fps;
//  - intervals where the layer is static (or empty) become a single frame
//    held for the whole interval (FFmpeg concat-demuxer `duration` entries).
// ---------------------------------------------------------------------------

import { computeOverlayMotion, overlayEnterExit } from './overlay';
import type { TextOverlay, TextStyle } from '../types';

// Matches the preview CSS: .overlay-item { max-width: 92% } and
// overlayTextStyle() (line-height 1.15, bg padding 0.12em/0.4em, radius
// 0.18em, shadow '0 0.04em 0.12em rgba(0,0,0,0.75)').
const MAX_WIDTH_FRAC = 0.92;
const LINE_HEIGHT = 1.15;
const BG_PAD_X_EM = 0.4;
const BG_PAD_Y_EM = 0.12;
const BG_RADIUS_EM = 0.18;
const SHADOW_Y_EM = 0.04;
const SHADOW_BLUR_EM = 0.12;
const SHADOW_COLOR = 'rgba(0,0,0,0.75)';

const EPS = 1e-4;

// ---- sample planning --------------------------------------------------------

/** One overlay-layer frame: render at `t`, hold for `duration` seconds. */
export interface OverlaySample {
  t: number;
  duration: number;
}

const isVisibleAt = (o: TextOverlay, t: number) => t >= o.startTime && t <= o.endTime;

/** Is any visible overlay mid-animation (enter/exit ramp) at time t? */
function isAnimatedAt(overlays: TextOverlay[], t: number): boolean {
  return overlays.some((o) => {
    if (o.animation === 'none' || !isVisibleAt(o, t)) return false;
    const { enter, exit } = overlayEnterExit(o);
    return t < o.startTime + enter || t > o.endTime - exit;
  });
}

/**
 * Split [0, total] at every overlay event (start/end and ramp boundaries) and
 * emit either fps-rate samples (animated interval) or a single held frame.
 */
export function planOverlaySamples(
  overlays: TextOverlay[],
  total: number,
  fps: number,
): OverlaySample[] {
  if (total <= 0) return [];

  const cuts = new Set<number>([0, total]);
  for (const o of overlays) {
    if (o.endTime <= o.startTime) continue;
    const events = [o.startTime, o.endTime];
    if (o.animation !== 'none') {
      // Ramp boundaries only matter when there is an animation to sample.
      const { enter, exit } = overlayEnterExit(o);
      events.push(o.startTime + enter, o.endTime - exit);
    }
    for (const t of events) {
      if (t > 0 && t < total) cuts.add(t);
    }
  }
  const points = [...cuts].sort((a, b) => a - b);

  const samples: OverlaySample[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = b - a;
    if (len <= EPS) continue;

    if (isAnimatedAt(overlays, (a + b) / 2)) {
      // The -1e-6 guards against float error turning an exact multiple of the
      // frame duration into one extra frame (0.4 * 30 -> 12.000000000000002).
      const n = Math.max(1, Math.ceil(len * fps - 1e-6));
      const step = len / n;
      for (let k = 0; k < n; k++) {
        samples.push({ t: a + k * step, duration: step });
      }
    } else {
      // Static (or empty) — one frame held for the interval; render state at
      // the midpoint, away from the boundary where a ramp begins/ends.
      samples.push({ t: (a + b) / 2, duration: len });
    }
  }
  return samples;
}

// ---- canvas rendering -------------------------------------------------------

interface Line {
  text: string;
  width: number;
}

/** Word-wrap like the DOM (pre-wrap + word-break: break-word) at maxWidth px. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): Line[] {
  const lines: Line[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push({ text: '', width: 0 });
      continue;
    }
    let current = '';
    const flush = () => {
      lines.push({ text: current, width: ctx.measureText(current).width });
      current = '';
    };
    for (const word of paragraph.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (ctx.measureText(candidate).width <= maxWidth || current === '') {
        current = candidate;
        // A single word wider than the box breaks at character level.
        while (ctx.measureText(current).width > maxWidth && current.length > 1) {
          let fit = current.length - 1;
          while (fit > 1 && ctx.measureText(current.slice(0, fit)).width > maxWidth) fit--;
          lines.push({ text: current.slice(0, fit), width: ctx.measureText(current.slice(0, fit)).width });
          current = current.slice(fit);
        }
      } else {
        flush();
        current = word;
      }
    }
    flush();
  }
  return lines;
}

function drawOverlayAt(
  ctx: CanvasRenderingContext2D,
  o: TextOverlay,
  t: number,
  W: number,
  H: number,
): boolean {
  const m = computeOverlayMotion(o, t);
  const alpha = m.opacity * o.style.opacity;
  if (!m.visible || alpha <= 0.001 || m.scale <= 0.001) return false;

  const style: TextStyle = o.style;
  const fontPx = (style.fontSize / 100) * H; // cqh -> px of frame height
  ctx.font = `${fontPx}px ${style.fontFamily}`;

  const hasBg = style.background !== 'transparent' && style.background !== '';
  const padX = hasBg ? BG_PAD_X_EM * fontPx : 0;
  const padY = hasBg ? BG_PAD_Y_EM * fontPx : 0;
  const maxContent = MAX_WIDTH_FRAC * W - 2 * padX;

  const lines = wrapText(ctx, m.text, maxContent);
  const contentW = lines.reduce((w, l) => Math.max(w, l.width), 0);
  const lineH = LINE_HEIGHT * fontPx;
  const boxW = contentW + 2 * padX;
  const boxH = lines.length * lineH + 2 * padY;
  if (boxW <= 0 || boxH <= 0) return false;

  // Font vertical metrics for baseline placement inside each line box.
  const probe = ctx.measureText('Mg');
  const ascent = probe.fontBoundingBoxAscent ?? 0.8 * fontPx;
  const descent = probe.fontBoundingBoxDescent ?? 0.2 * fontPx;

  // DOM geometry: left/top at (x%, y%), transform translate(-50%,-50%) + anim
  // => element CENTER lands at the anchor, shifted by the slide offset
  // (a % of the element's own size), then scaled about that center.
  const cx = (o.x / 100) * W + (m.dxPct / 100) * boxW;
  const cy = (o.y / 100) * H + (m.dyPct / 100) * boxH;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.scale(m.scale, m.scale);

  if (hasBg) {
    ctx.fillStyle = style.background;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, BG_RADIUS_EM * fontPx);
    } else {
      ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH);
    }
    ctx.fill();
  }

  const strokeW = style.outlineWidth > 0 ? style.outlineWidth * fontPx : 0;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';

  lines.forEach((line, i) => {
    if (line.text === '') return;
    const lineTop = -boxH / 2 + padY + i * lineH;
    const baseline = lineTop + (lineH - (ascent + descent)) / 2 + ascent;

    let x: number;
    if (style.alignment === 'left') {
      ctx.textAlign = 'left';
      x = -boxW / 2 + padX;
    } else if (style.alignment === 'right') {
      ctx.textAlign = 'right';
      x = boxW / 2 - padX;
    } else {
      ctx.textAlign = 'center';
      x = 0;
    }

    // Shadow rides on the first paint pass (CSS paints one text-shadow).
    const applyShadow = () => {
      if (!style.shadow) return;
      ctx.shadowColor = SHADOW_COLOR;
      ctx.shadowOffsetY = SHADOW_Y_EM * fontPx;
      ctx.shadowBlur = SHADOW_BLUR_EM * fontPx;
    };
    const clearShadow = () => {
      ctx.shadowColor = 'transparent';
      ctx.shadowOffsetY = 0;
      ctx.shadowBlur = 0;
    };

    if (strokeW > 0) {
      // paint-order: stroke fill — stroke behind, fill on top.
      applyShadow();
      ctx.lineWidth = strokeW;
      ctx.strokeStyle = style.outlineColor;
      ctx.strokeText(line.text, x, baseline);
      clearShadow();
      ctx.fillStyle = style.color;
      ctx.fillText(line.text, x, baseline);
    } else {
      applyShadow();
      ctx.fillStyle = style.color;
      ctx.fillText(line.text, x, baseline);
      clearShadow();
    }
  });

  ctx.restore();
  return true;
}

/**
 * Clear the canvas and draw every visible overlay at time `t` (array order =
 * stacking order, matching the preview layer). Returns whether anything was
 * drawn, so the caller can substitute a shared blank frame.
 */
export function renderOverlayLayer(
  ctx: CanvasRenderingContext2D,
  overlays: TextOverlay[],
  t: number,
  W: number,
  H: number,
): boolean {
  ctx.clearRect(0, 0, W, H);
  let drew = false;
  for (const o of overlays) {
    if (drawOverlayAt(ctx, o, t, W, H)) drew = true;
  }
  return drew;
}
