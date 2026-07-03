// ---------------------------------------------------------------------------
// Text overlay rendering logic.
//
// computeOverlayRender() is PURE and driven entirely by the playhead time, so
// an overlay animates identically whether the preview is playing or being
// scrubbed (forward or backward), and the exact same function can drive the
// frame-accurate export later. It must NOT rely on CSS transitions.
// ---------------------------------------------------------------------------

import type { CSSProperties } from 'react';
import type { SlideDirection, TextAnimation, TextOverlay, TextStyle } from '../types';

// Entrance/exit ramp length (seconds), each clamped to half the overlay length.
const ENTER = 0.4;
const EXIT = 0.4;
// Slide travel distance, as a percentage of the element's own size.
const SLIDE_DISTANCE = 60;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

const SLIDE_VECTOR: Record<SlideDirection, { x: number; y: number }> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

/** Enter/exit ramp lengths for an overlay, clamped to half its duration. */
export function overlayEnterExit(o: Pick<TextOverlay, 'startTime' | 'endTime'>): {
  enter: number;
  exit: number;
} {
  const dur = Math.max(0, o.endTime - o.startTime);
  return { enter: Math.min(ENTER, dur / 2), exit: Math.min(EXIT, dur / 2) };
}

/**
 * The NUMERIC animated state of an overlay at a global timeline time — the
 * shared core behind both renderers: the preview builds a CSS transform from
 * it (computeOverlayRender) and the export rasterizes it onto a canvas
 * (lib/overlayRaster.ts). Keeping one source guarantees they can't diverge.
 */
export interface OverlayMotion {
  visible: boolean; // is the playhead within [startTime, endTime]?
  opacity: number; // animated opacity (multiply by style.opacity at render)
  text: string; // possibly truncated (typewriter)
  dxPct: number; // translate offset, % of the element's own width
  dyPct: number; // translate offset, % of the element's own height
  scale: number; // uniform scale about the element center
}

export function computeOverlayMotion(o: TextOverlay, t: number): OverlayMotion {
  if (t < o.startTime || t > o.endTime) {
    return { visible: false, opacity: 0, text: o.text, dxPct: 0, dyPct: 0, scale: 1 };
  }

  const { enter, exit } = overlayEnterExit(o);
  const eIn = enter > 0 ? clamp01((t - o.startTime) / enter) : 1;
  const eOut = exit > 0 ? clamp01((o.endTime - t) / exit) : 1;
  const f = Math.min(eIn, eOut);

  const anim: TextAnimation = o.animation;
  let opacity = 1;
  let text = o.text;
  let dxPct = 0;
  let dyPct = 0;
  let scale = 1;

  switch (anim) {
    case 'none':
      opacity = 1;
      break;
    case 'fade':
      opacity = f;
      break;
    case 'slide': {
      const d = SLIDE_VECTOR[o.slideFrom];
      // one of the two terms is ~0 except for very short overlays
      const k = 1 - easeOutCubic(eIn) + (1 - easeOutCubic(eOut));
      dxPct = d.x * SLIDE_DISTANCE * k;
      dyPct = d.y * SLIDE_DISTANCE * k;
      opacity = f;
      break;
    }
    case 'pop': {
      scale = eOut < 1 ? eOut : easeOutBack(eIn);
      opacity = f;
      break;
    }
    case 'typewriter': {
      const chars = Math.ceil(eIn * o.text.length);
      text = o.text.slice(0, chars);
      // hidden until the first character appears; fades on exit
      opacity = chars === 0 ? 0 : easeOutCubic(eOut);
      break;
    }
  }

  return { visible: true, opacity, text, dxPct, dyPct, scale };
}

export interface OverlayRender {
  visible: boolean; // is the playhead within [startTime, endTime]?
  opacity: number; // animated opacity (multiply by style.opacity at render)
  transform: string; // animation transform only (compose with translate(-50%,-50%))
  text: string; // possibly truncated (typewriter)
}

/** Resolve an overlay's animated state as CSS, for the preview DOM. */
export function computeOverlayRender(o: TextOverlay, t: number): OverlayRender {
  const m = computeOverlayMotion(o, t);
  if (!m.visible) return { visible: false, opacity: 0, transform: 'none', text: o.text };

  let transform = 'none';
  if (o.animation === 'slide') transform = `translate(${m.dxPct}%, ${m.dyPct}%)`;
  else if (o.animation === 'pop') transform = `scale(${m.scale})`;

  return { visible: true, opacity: m.opacity, transform, text: m.text };
}

/** Static (non-animated) CSS for an overlay's text, frame-relative. */
export function overlayTextStyle(style: TextStyle): CSSProperties {
  const hasBg = style.background !== 'transparent' && style.background !== '';
  return {
    fontFamily: style.fontFamily,
    fontSize: `${style.fontSize}cqh`,
    color: style.color,
    textAlign: style.alignment,
    lineHeight: 1.15,
    WebkitTextStrokeWidth: style.outlineWidth > 0 ? `${style.outlineWidth}em` : undefined,
    WebkitTextStrokeColor: style.outlineColor,
    paintOrder: 'stroke fill', // keep the fill on top of the stroke
    textShadow: style.shadow ? '0 0.04em 0.12em rgba(0,0,0,0.75)' : undefined,
    background: hasBg ? style.background : undefined,
    padding: hasBg ? '0.12em 0.4em' : undefined,
    borderRadius: hasBg ? '0.18em' : undefined,
  };
}

// --- editor option lists ---------------------------------------------------

export const FONTS: { label: string; value: string }[] = [
  { label: 'Sans', value: 'Inter, system-ui, sans-serif' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono', value: '"Courier New", monospace' },
  { label: 'Impact', value: 'Impact, Haettenschweiler, sans-serif' },
  { label: 'Script', value: '"Brush Script MT", "Segoe Script", cursive' },
];

export const ANIMATIONS: { label: string; value: TextAnimation }[] = [
  { label: 'None', value: 'none' },
  { label: 'Fade', value: 'fade' },
  { label: 'Slide', value: 'slide' },
  { label: 'Pop', value: 'pop' },
  { label: 'Typewriter', value: 'typewriter' },
];

export interface TextPreset {
  name: string;
  style: Partial<TextStyle>;
  animation: TextAnimation;
}

export const TEXT_PRESETS: TextPreset[] = [
  {
    name: 'Bold Title',
    animation: 'pop',
    style: {
      fontFamily: 'Impact, Haettenschweiler, sans-serif',
      fontSize: 11,
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 0.07,
      shadow: true,
      background: 'transparent',
      alignment: 'center',
      opacity: 1,
    },
  },
  {
    name: 'Subtitle',
    animation: 'fade',
    style: {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: 6,
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 0.05,
      shadow: true,
      background: 'transparent',
      alignment: 'center',
      opacity: 1,
    },
  },
  {
    name: 'Caption Box',
    animation: 'fade',
    style: {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: 6,
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 0,
      shadow: false,
      background: 'rgba(0,0,0,0.6)',
      alignment: 'center',
      opacity: 1,
    },
  },
  {
    name: 'Neon',
    animation: 'fade',
    style: {
      fontFamily: 'Impact, Haettenschweiler, sans-serif',
      fontSize: 9,
      color: '#39ff14',
      outlineColor: '#0b3d0b',
      outlineWidth: 0.04,
      shadow: true,
      background: 'transparent',
      alignment: 'center',
      opacity: 1,
    },
  },
];
