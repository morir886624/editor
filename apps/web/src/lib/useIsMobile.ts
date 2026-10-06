import { useSyncExternalStore } from 'react';
import { getPlatform } from './platform';

/** Phone-width breakpoint: below this the app renders the mobile shell
 *  (vertical CapCut-style layout) instead of the dockable workspace. */
const MOBILE_QUERY = '(max-width: 768px)';
/** Native shell: a PHONE stays in the mobile shell in landscape too (its
 *  long side can exceed 768px); only tablets get the dockable workspace. */
const NATIVE_PHONE_QUERY = '(max-width: 768px), (max-height: 600px)';

const mql = () =>
  window.matchMedia(getPlatform().prefersMobileLayout() ? NATIVE_PHONE_QUERY : MOBILE_QUERY);

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
