import { useEditorStore } from '../store/editorStore';
import {
  FRAME_INSET_RANGE,
  FRAME_RADIUS_RANGE,
  FRAME_TYPE_OPTIONS,
} from '../lib/frame';
import type { FrameSettings, FrameType } from '../types';

/** Quick background swatches for solid/polaroid frames. */
const FRAME_COLORS: { color: string; label: string }[] = [
  { color: '#000000', label: 'Black' },
  { color: '#ffffff', label: 'White' },
  { color: '#f3ead8', label: 'Cream' },
  { color: '#101728', label: 'Navy' },
];

/**
 * Decorative-frame editor (stage 9A) — a PROJECT setting, not a selection
 * inspector: the frame is the package the whole short ships in, so it lives
 * in ProjectSettings.frame (undo/redo covers it via the document history).
 * Sliders follow the checkpoint + { history: false } gesture pattern; the
 * preview reacts live and the export reproduces the same parameters.
 */
export function FramePanel() {
  const frame = useEditorStore((s) => s.settings.frame);
  const updateSettings = useEditorStore((s) => s.updateSettings);
  const checkpoint = useEditorStore((s) => s.checkpoint);

  const setFrame = (patch: Partial<FrameSettings>, options?: { history?: boolean }) =>
    updateSettings({ frame: { ...frame, ...patch } }, options);

  const pickType = (type: FrameType) => {
    const patch: Partial<FrameSettings> = { type };
    // Ergonomic default: a polaroid on the stock black background reads as a
    // bug — switch it to white unless the user already picked a color.
    if (type === 'polaroid' && frame.color === '#000000') patch.color = '#ffffff';
    setFrame(patch);
  };

  const showColor = frame.type === 'solid' || frame.type === 'polaroid';
  const active = frame.type !== 'none';

  const slider = (
    label: string,
    key: 'inset' | 'cornerRadius',
    range: { min: number; max: number; step: number },
  ) => (
    <label className="texted__field texted__field--row">
      <span>{label}</span>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={frame[key]}
        onPointerDown={checkpoint}
        onChange={(e) => setFrame({ [key]: Number(e.target.value) }, { history: false })}
      />
      <em>{frame[key]}%</em>
    </label>
  );

  return (
    <aside className="texted" aria-label="Frame editor">
      <div className="texted__body">
        <div className="texted__field">
          <span>Frame</span>
          <div className="texted__presets">
            {FRAME_TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={'texted__preset' + (frame.type === opt.id ? ' is-active' : '')}
                title={opt.hint}
                onClick={() => pickType(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {active && (
          <>
            {slider(
              frame.type === 'filmstrip' ? 'Bar size' : 'Inset',
              'inset',
              FRAME_INSET_RANGE,
            )}
            {slider('Corners', 'cornerRadius', FRAME_RADIUS_RANGE)}
          </>
        )}

        {showColor && (
          <div className="texted__field">
            <span>Background</span>
            <div className="framepanel__colors">
              {FRAME_COLORS.map((c) => (
                <button
                  key={c.color}
                  type="button"
                  className={
                    'framepanel__swatch' +
                    (frame.color.toLowerCase() === c.color ? ' is-active' : '')
                  }
                  style={{ background: c.color }}
                  title={c.label}
                  onClick={() => setFrame({ color: c.color })}
                />
              ))}
              <input
                type="color"
                value={frame.color}
                title="Custom color"
                onChange={(e) => setFrame({ color: e.target.value }, { history: false })}
                onFocus={checkpoint}
              />
            </div>
          </div>
        )}

        {frame.type === 'polaroid' && (
          <label className="texted__field">
            <span>Caption (drawn in the bottom band)</span>
            <input
              type="text"
              className="texted__textarea"
              value={frame.caption}
              placeholder="Summer 2026…"
              maxLength={60}
              onChange={(e) => setFrame({ caption: e.target.value })}
            />
          </label>
        )}

        {frame.type === 'blur' && (
          <p className="framepanel__hint">
            The background is a blurred, zoomed copy of the video — great for fitting
            landscape footage into 9:16.
          </p>
        )}

        {active && (
          <p className="framepanel__hint">
            The frame applies to the whole project, sizes scale with the aspect ratio, and the
            export reproduces it exactly. Text overlays render on top — they can sit on the
            border too.
          </p>
        )}
      </div>
    </aside>
  );
}
