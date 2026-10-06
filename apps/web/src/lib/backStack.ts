import { useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// "Back" handling for the native shell (Android hardware/gesture back).
// Open layers — a bottom sheet, a modal, a sub-view inside a modal — register
// a handler while they're visible; the most recently registered one wins, so
// back peels layers off top-down. The web build never calls handleBack(), so
// registering is a harmless no-op there.
// ---------------------------------------------------------------------------

type BackHandler = () => void;

const stack: { handler: React.RefObject<BackHandler> }[] = [];

/**
 * Let the topmost open layer consume a back press.
 * @returns true if a layer handled it, false if nothing was open.
 */
export function handleBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.handler.current();
  return true;
}

/**
 * Register `onBack` while `active` is true. Layers mounted later sit above
 * earlier ones. The latest `onBack` is always used (kept in a ref), so callers
 * can pass inline closures without re-registering every render.
 */
export function useBackHandler(active: boolean, onBack: BackHandler): void {
  const ref = useRef<BackHandler>(onBack);
  useEffect(() => {
    ref.current = onBack;
  });
  useEffect(() => {
    if (!active) return;
    const entry = { handler: ref };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i !== -1) stack.splice(i, 1);
    };
  }, [active]);
}
