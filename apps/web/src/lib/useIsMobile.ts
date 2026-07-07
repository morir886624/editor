import { useSyncExternalStore } from 'react';

/** Phone-width breakpoint: below this the app renders the mobile shell
 *  (vertical CapCut-style layout) instead of the dockable workspace. */
const MOBILE_QUERY = '(max-width: 768px)';

const mql = () => window.matchMedia(MOBILE_QUERY);

/**
 * True on phone-sized viewports, live across resizes/rotation. Backed by
 * matchMedia via useSyncExternalStore so the layout switch is tear-free.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = mql();
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => mql().matches,
  );
}
