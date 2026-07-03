import { useCallback, useRef } from 'react';
import { type PointerEvent as ReactPointerEvent } from 'react';

/** Minimum gap kept between a panel and the viewport edge while dragging. */
const EDGE = 8;

// Last offset per panel key, module-level so a panel closed and reopened
// (the components unmount/hide when dismissed) comes back where the user
// left it.
const savedOffsets = new Map<string, { x: number; y: number }>();

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Makes a fixed-position panel draggable by its header. The panel keeps its
 * CSS-defined resting spot; dragging applies a translate() offset written
 * imperatively (no re-render per move). Attach `ref` to the panel element and
 * `onHeaderPointerDown` to its header; interactive children of the header
 * (buttons, inputs) are left alone so ✕ still closes.
 *
 * `ref` is a callback ref on purpose: several panels stay mounted and render
 * null while hidden, so the saved offset must be re-applied every time the
 * element actually attaches, not once per component lifetime.
 */
export function useDraggablePanel<T extends HTMLElement>(panelKey: string) {
  const elRef = useRef<T | null>(null);
  const offsetRef = useRef(savedOffsets.get(panelKey) ?? { x: 0, y: 0 });

  const apply = (x: number, y: number) => {
    if (elRef.current) elRef.current.style.transform = `translate(${x}px, ${y}px)`;
  };

  // Fires whenever the panel element attaches: restore the saved offset,
  // re-clamped in case the viewport or the panel's size changed meanwhile.
  const ref = useCallback(
    (el: T | null) => {
      elRef.current = el;
      if (!el) return;
      apply(offsetRef.current.x, offsetRef.current.y);
      const rect = el.getBoundingClientRect();
      const left = clamp(rect.left, EDGE, Math.max(EDGE, window.innerWidth - rect.width - EDGE));
      const top = clamp(rect.top, EDGE, Math.max(EDGE, window.innerHeight - rect.height - EDGE));
      if (left !== rect.left || top !== rect.top) {
        offsetRef.current = {
          x: offsetRef.current.x + (left - rect.left),
          y: offsetRef.current.y + (top - rect.top),
        };
        savedOffsets.set(panelKey, offsetRef.current);
        apply(offsetRef.current.x, offsetRef.current.y);
      }
    },
    [panelKey],
  );

  const onHeaderPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      // Header controls (✕, badges that become buttons…) keep their own behaviour.
      if ((e.target as HTMLElement).closest('button, input, select, a, textarea')) return;
      const el = elRef.current;
      if (!el) return;
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const base = { ...offsetRef.current };
      const rect = el.getBoundingClientRect(); // already includes `base`

      const onMove = (ev: PointerEvent) => {
        const left = clamp(
          rect.left + (ev.clientX - startX),
          EDGE,
          Math.max(EDGE, window.innerWidth - rect.width - EDGE),
        );
        const top = clamp(
          rect.top + (ev.clientY - startY),
          EDGE,
          Math.max(EDGE, window.innerHeight - rect.height - EDGE),
        );
        offsetRef.current = { x: base.x + (left - rect.left), y: base.y + (top - rect.top) };
        apply(offsetRef.current.x, offsetRef.current.y);
      };
      const onUp = () => {
        savedOffsets.set(panelKey, offsetRef.current);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [panelKey],
  );

  return { ref, onHeaderPointerDown };
}
