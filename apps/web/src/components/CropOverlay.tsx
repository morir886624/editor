import { type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useEditorStore } from '../store/editorStore';
import { FULL_CROP, MIN_CROP_FRACTION, containRect } from '../lib/crop';
import { useSourceAspect } from '../lib/useSourceAspect';
import type { Clip } from '../types';

type Corner = 'nw' | 'ne' | 'sw' | 'se';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

interface CropOverlayProps {
  clip: Clip;
  /** Width/height ratio of the frame viewport this overlay fills. */
  viewportAspect: number;
  viewportRef: RefObject<HTMLDivElement | null>;
}

/**
 * Interactive crop editor drawn inside the preview viewport while a clip is
 * in a crop session (store.cropEditingClipId). The video under it shows the
 * FULL source (PreviewPlayer's applyCropLayout suspends the crop for that
 * clip); this overlay dims everything outside the crop rect and lets the user
 * drag it (move) or its corner handles (resize, honoring the panel's aspect
 * lock). Same gesture conventions as text overlays: pointerdown + window
 * listeners, one history checkpoint at first movement, then live updates with
 * { history: false } so the whole gesture is a single undo step.
 */
export function CropOverlay({ clip, viewportAspect, viewportRef }: CropOverlayProps) {
  const setClipCrop = useEditorStore((s) => s.setClipCrop);
  const checkpoint = useEditorStore((s) => s.checkpoint);
  const aspectLock = useEditorStore((s) => s.cropAspectLock);
  const srcAspect = useSourceAspect(clip.src);
  if (!srcAspect) return null;

  const crop = clip.crop ?? FULL_CROP;
  // Where the FULL source sits on screen (contain-fitted), viewport fractions.
  const region = containRect(srcAspect, viewportAspect);

  /** Checkpoint-once wrapper + window listener wiring (same shape as the
   *  overlay gestures in PreviewPlayer). */
  const runGesture = (apply: (ev: PointerEvent) => void) => {
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        checkpoint();
        moved = true;
      }
      apply(ev);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const beginMove = (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = crop;
    runGesture((ev) => {
      // Pointer pixels -> fractions of the displayed source.
      const dx = (ev.clientX - startX) / (rect.width * region.w);
      const dy = (ev.clientY - startY) / (rect.height * region.h);
      setClipCrop(
        clip.id,
        { ...orig, x: orig.x + dx, y: orig.y + dy }, // store clamps
        { history: false },
      );
    });
  };

  const beginResize = (e: ReactPointerEvent, corner: Corner) => {
    e.stopPropagation();
    e.preventDefault();
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const west = corner === 'nw' || corner === 'sw';
    const north = corner === 'nw' || corner === 'ne';
    // The OPPOSITE corner stays anchored, in source fractions.
    const ax = west ? crop.x + crop.w : crop.x;
    const ay = north ? crop.y + crop.h : crop.y;
    runGesture((ev) => {
      // Pointer position in source fractions.
      const fx = clamp01(((ev.clientX - rect.left) / rect.width - region.left) / region.w);
      const fy = clamp01(((ev.clientY - rect.top) / rect.height - region.top) / region.h);
      let w = west
        ? clamp(ax - fx, MIN_CROP_FRACTION, ax)
        : clamp(fx - ax, MIN_CROP_FRACTION, 1 - ax);
      let h = north
        ? clamp(ay - fy, MIN_CROP_FRACTION, ay)
        : clamp(fy - ay, MIN_CROP_FRACTION, 1 - ay);
      if (aspectLock) {
        // Lock is a PIXEL aspect; in fraction space w/h = lock / srcAspect.
        const maxW = west ? ax : 1 - ax;
        const maxH = north ? ay : 1 - ay;
        h = (w * srcAspect) / aspectLock;
        if (h > maxH) {
          h = maxH;
          w = (h * aspectLock) / srcAspect;
        }
        if (h < MIN_CROP_FRACTION) {
          h = MIN_CROP_FRACTION;
          w = (h * aspectLock) / srcAspect;
        }
        w = clamp(w, MIN_CROP_FRACTION, maxW);
      }
      const x = west ? ax - w : ax;
      const y = north ? ay - h : ay;
      setClipCrop(clip.id, { x, y, w, h }, { history: false }); // store clamps
    });
  };

  const pct = (v: number) => `${(v * 100).toFixed(4)}%`;

  return (
    <div className="cropper" aria-label="Crop editor">
      <div
        className="cropper__rect"
        style={{
          left: pct(region.left + crop.x * region.w),
          top: pct(region.top + crop.y * region.h),
          width: pct(crop.w * region.w),
          height: pct(crop.h * region.h),
        }}
        onPointerDown={beginMove}
      >
        <span className="ovh ovh--nw" onPointerDown={(e) => beginResize(e, 'nw')} />
        <span className="ovh ovh--ne" onPointerDown={(e) => beginResize(e, 'ne')} />
        <span className="ovh ovh--sw" onPointerDown={(e) => beginResize(e, 'sw')} />
        <span className="ovh ovh--se" onPointerDown={(e) => beginResize(e, 'se')} />
      </div>
    </div>
  );
}
