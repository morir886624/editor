import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
import { PIXELS_PER_SECOND, secondsToPx, pxToSeconds } from '../lib/timeline';
import type { TextOverlay } from '../types';

const MIN_OVERLAY_DURATION = 0.3; // seconds
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

type DragMode = 'move' | 'left' | 'right';

/**
 * The dedicated TEXT track row on the timeline. Each overlay is a block placed
 * by startTime and sized by its duration; it can be dragged to move in time and
 * has edges to resize start/end. All edits stay within [0, total]. One history
 * checkpoint per gesture (live updates pass { history: false }).
 */
export function TextTrack({ total }: { total: number }) {
  const overlays = useEditorStore((s) => s.textOverlays);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const setSelected = useEditorStore((s) => s.setSelected);
  const updateTextOverlay = useEditorStore((s) => s.updateTextOverlay);
  const checkpoint = useEditorStore((s) => s.checkpoint);

  const beginDrag = (e: ReactPointerEvent, overlay: TextOverlay, mode: DragMode) => {
    e.stopPropagation(); // don't let the timeline scrub
    e.preventDefault();
    setSelected(overlay.id);
    if (overlay.locked) return; // locked = selectable but not movable in time

    const startX = e.clientX;
    const origStart = overlay.startTime;
    const origEnd = overlay.endTime;
    const dur = origEnd - origStart;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        checkpoint();
        moved = true;
      }
      const delta = pxToSeconds(ev.clientX - startX);
      let patch: Partial<TextOverlay>;
      if (mode === 'move') {
        const ns = clamp(origStart + delta, 0, Math.max(0, total - dur));
        patch = { startTime: ns, endTime: ns + dur };
      } else if (mode === 'left') {
        const ns = clamp(origStart + delta, 0, origEnd - MIN_OVERLAY_DURATION);
        patch = { startTime: ns };
      } else {
        const ne = clamp(origEnd + delta, origStart + MIN_OVERLAY_DURATION, total);
        patch = { endTime: ne };
      }
      updateTextOverlay(overlay.id, patch, { history: false });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="text-track">
      {overlays.length === 0 && <span className="text-track__hint">Text</span>}
      {overlays.map((o) => {
        const selected = o.id === selectedItemId;
        const width = Math.max(PIXELS_PER_SECOND * MIN_OVERLAY_DURATION, secondsToPx(o.endTime - o.startTime));
        return (
          <div
            key={o.id}
            className={'text-block' + (selected ? ' text-block--selected' : '')}
            style={{ left: secondsToPx(o.startTime), width }}
            title={o.text}
            onPointerDown={(e) => beginDrag(e, o, 'move')}
            onClick={(e) => {
              e.stopPropagation();
              setSelected(o.id);
            }}
          >
            <span
              className="text-block__handle text-block__handle--left"
              onPointerDown={(e) => beginDrag(e, o, 'left')}
            />
            <span className="text-block__label">
              {o.locked ? '🔒 ' : ''}
              {o.text || 'Text'}
            </span>
            <span
              className="text-block__handle text-block__handle--right"
              onPointerDown={(e) => beginDrag(e, o, 'right')}
            />
          </div>
        );
      })}
    </div>
  );
}
