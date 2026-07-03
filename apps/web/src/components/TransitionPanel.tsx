import { useEditorStore } from '../store/editorStore';
import { useNoticeStore } from '../store/noticeStore';
import { useDraggablePanel } from '../lib/useDraggablePanel';
import { effectiveTransitionDurations } from '../lib/duration';
import {
  DEFAULT_TRANSITION,
  TRANSITION_DURATION_RANGE,
  TRANSITION_OPTIONS,
  maxTransitionAt,
} from '../lib/transitions';
import type { TransitionType } from '../types';

/**
 * Editor for the transition on the selected seam (selectedTransitionId = left
 * clip's id). The transition is data on that clip; duration is guarded/clamped
 * by the store, and the slider follows the checkpoint + { history: false }
 * gesture pattern. Reuses the .texted panel styles.
 */
export function TransitionPanel() {
  const clips = useEditorStore((s) => s.clips);
  const selectedTransitionId = useEditorStore((s) => s.selectedTransitionId);
  const setSelectedTransition = useEditorStore((s) => s.setSelectedTransition);
  const setTransition = useEditorStore((s) => s.setTransition);
  const checkpoint = useEditorStore((s) => s.checkpoint);
  const notify = useNoticeStore((s) => s.push);
  const { ref, onHeaderPointerDown } = useDraggablePanel<HTMLElement>('texted');

  const index = clips.findIndex((c) => c.id === selectedTransitionId);
  if (index < 0 || index >= clips.length - 1) return null;

  const left = clips[index];
  const right = clips[index + 1];
  const current = left.transitionAfter ?? null;
  const effective = effectiveTransitionDurations(clips)[index] ?? 0;
  const maxDuration = Math.min(TRANSITION_DURATION_RANGE.max, maxTransitionAt(clips, index));
  const canHost = maxDuration >= 0.1;

  const apply = (
    transition: { type: TransitionType; duration: number } | null,
    options?: { history?: boolean },
  ) => {
    const res = setTransition(left.id, transition, options);
    if (!res.ok) notify({ type: 'error', message: res.reason });
  };

  const pickType = (type: TransitionType) =>
    apply({ type, duration: current?.duration ?? DEFAULT_TRANSITION.duration });

  return (
    <aside ref={ref} className="texted" aria-label="Transition editor">
      <header className="texted__header" onPointerDown={onHeaderPointerDown}>
        <strong>Transition</strong>
        <button
          type="button"
          className="texted__close"
          onClick={() => setSelectedTransition(null)}
        >
          ✕
        </button>
      </header>

      <div className="texted__body">
        <div className="texted__field">
          <span>Between</span>
          <div className="texted__filename" title={`${left.sourceFileName} → ${right.sourceFileName}`}>
            {left.sourceFileName} → {right.sourceFileName}
          </div>
        </div>

        {!canHost && !current && (
          <p className="texted__hint">
            These clips are too short to overlap — trim less or pick longer clips to
            add a transition here.
          </p>
        )}

        <div className="texted__field">
          <span>Style</span>
          <div className="texted__presets texted__presets--three">
            <button
              type="button"
              className={'texted__preset' + (current ? '' : ' is-active')}
              onClick={() => apply(null)}
            >
              None
            </button>
            {TRANSITION_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={'texted__preset' + (current?.type === opt.id ? ' is-active' : '')}
                disabled={!canHost && !current}
                onClick={() => pickType(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {current && (
          <label className="texted__field texted__field--row">
            <span>Duration</span>
            <input
              type="range"
              min={TRANSITION_DURATION_RANGE.min}
              max={Math.max(TRANSITION_DURATION_RANGE.min, maxDuration)}
              step={TRANSITION_DURATION_RANGE.step}
              value={Math.min(current.duration, maxDuration)}
              onPointerDown={checkpoint}
              onChange={(e) =>
                apply({ type: current.type, duration: Number(e.target.value) }, { history: false })
              }
            />
            <em>{effective.toFixed(2)}s</em>
          </label>
        )}

        {current && effective < current.duration - 0.01 && (
          <p className="texted__hint">
            Shortened to {effective.toFixed(2)}s — a transition can't be longer than
            its neighboring clips.
          </p>
        )}
      </div>
    </aside>
  );
}
