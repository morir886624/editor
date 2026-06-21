import { useEditorStore } from '../store/editorStore';
import { useFFmpegStore } from '../store/ffmpegStore';
import {
  MAX_TIMELINE_DURATION,
  computeTotalDuration,
  remainingDuration,
} from '../lib/duration';

/**
 * Tiny dev panel to verify the store works end-to-end.
 *
 * It prints live store stats AND exposes a handful of throwaway buttons that
 * exercise the actions / guard / undo-redo. These controls are Stage-1 scaffold
 * only — real toolbar wiring comes later — but they let you confirm the store
 * behaves before we build the UI on top of it.
 */
export function DebugPanel() {
  const clips = useEditorStore((s) => s.clips);
  const textOverlays = useEditorStore((s) => s.textOverlays);
  const audioTracks = useEditorStore((s) => s.audioTracks);
  const playheadTime = useEditorStore((s) => s.playheadTime);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const past = useEditorStore((s) => s.past);
  const future = useEditorStore((s) => s.future);
  const ffmpegStatus = useFFmpegStore((s) => s.status);

  const removeClip = useEditorStore((s) => s.removeClip);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  // Computed via the same function the guard uses — they can never disagree.
  const total = computeTotalDuration(clips);
  const remaining = remainingDuration(clips);

  return (
    <aside className="debug" aria-label="Debug panel">
      <header className="debug__header">
        <strong>Store debug</strong>
        <span
          className={
            'debug__badge' +
            (total > MAX_TIMELINE_DURATION ? ' debug__badge--over' : '')
          }
        >
          {total.toFixed(1)}s / {MAX_TIMELINE_DURATION}s
        </span>
      </header>

      <dl className="debug__stats">
        <div>
          <dt>Clips</dt>
          <dd>{clips.length}</dd>
        </div>
        <div>
          <dt>Total duration</dt>
          <dd>{total.toFixed(2)}s</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{remaining.toFixed(2)}s</dd>
        </div>
        <div>
          <dt>Text overlays</dt>
          <dd>{textOverlays.length}</dd>
        </div>
        <div>
          <dt>Audio tracks</dt>
          <dd>{audioTracks.length}</dd>
        </div>
        <div>
          <dt>Playhead</dt>
          <dd>{playheadTime.toFixed(2)}s</dd>
        </div>
        <div>
          <dt>Selected</dt>
          <dd>{selectedItemId ?? '—'}</dd>
        </div>
        <div>
          <dt>History</dt>
          <dd>
            ↶{past.length} / ↷{future.length}
          </dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd>{ffmpegStatus}</dd>
        </div>
      </dl>

      <div className="debug__actions">
        <button
          type="button"
          onClick={() => clips.length && removeClip(clips[clips.length - 1].id)}
          disabled={clips.length === 0}
        >
          − Last clip
        </button>
        <button type="button" onClick={() => setPlayhead(playheadTime + 1)}>
          Playhead +1s
        </button>
        <button type="button" onClick={undo} disabled={past.length === 0}>
          Undo
        </button>
        <button type="button" onClick={redo} disabled={future.length === 0}>
          Redo
        </button>
      </div>
    </aside>
  );
}
