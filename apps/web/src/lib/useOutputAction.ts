import { useCallback, useState } from 'react';
import { useNoticeStore } from '../store/noticeStore';

/**
 * Runs a platform output action (save to gallery / share) with a busy flag,
 * surfacing the optional success message and any failure as a notice — so
 * the dialogs stay presentational and never throw into React.
 */
export function useOutputAction() {
  const [busy, setBusy] = useState(false);
  const notify = useNoticeStore((s) => s.push);

  const run = useCallback(
    async (action: () => Promise<string | void>) => {
      setBusy(true);
      try {
        const message = await action();
        if (message) notify({ type: 'success', message });
      } catch (e) {
        notify({
          type: 'error',
          message: e instanceof Error ? e.message : String(e || 'Could not save the file.'),
        });
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );

  return { busy, run };
}
