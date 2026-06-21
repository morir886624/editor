import { useEditorStore } from '../store/editorStore';
import { ANIMATIONS, FONTS, TEXT_PRESETS } from '../lib/overlay';
import type { SlideDirection, TextAlignment, TextAnimation, TextStyle } from '../types';

/**
 * Editor for the selected text overlay. Presentational: every change writes
 * straight to the store. Continuous controls (sliders, color pickers) take one
 * history checkpoint on pointer-down and then commit with { history: false } so
 * a drag is a single undo step; discrete controls commit normally.
 */
export function TextEditorPanel() {
  const overlays = useEditorStore((s) => s.textOverlays);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const updateTextOverlay = useEditorStore((s) => s.updateTextOverlay);
  const removeTextOverlay = useEditorStore((s) => s.removeTextOverlay);
  const setSelected = useEditorStore((s) => s.setSelected);
  const checkpoint = useEditorStore((s) => s.checkpoint);

  const overlay = overlays.find((o) => o.id === selectedItemId);
  if (!overlay) return null;

  const id = overlay.id;
  const style = overlay.style;

  // discrete edit (one undo step)
  const setOverlay = (patch: Parameters<typeof updateTextOverlay>[1]) =>
    updateTextOverlay(id, patch);
  const setStyle = (patch: Partial<TextStyle>) => updateTextOverlay(id, { style: patch });
  // live edit during a drag gesture (no per-tick history)
  const liveStyle = (patch: Partial<TextStyle>) =>
    updateTextOverlay(id, { style: patch }, { history: false });

  return (
    <aside className="texted" aria-label="Text editor">
      <header className="texted__header">
        <strong>Text</strong>
        <button type="button" className="texted__close" onClick={() => setSelected(null)}>
          ✕
        </button>
      </header>

      <div className="texted__body">
        {/* presets */}
        <div className="texted__presets">
          {TEXT_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className="texted__preset"
              onClick={() => setOverlay({ style: p.style, animation: p.animation })}
            >
              {p.name}
            </button>
          ))}
        </div>

        {/* text content */}
        <label className="texted__field">
          <span>Content</span>
          <textarea
            className="texted__textarea"
            rows={2}
            value={overlay.text}
            onChange={(e) => setOverlay({ text: e.target.value })}
          />
        </label>

        {/* font + size */}
        <label className="texted__field">
          <span>Font</span>
          <select
            value={style.fontFamily}
            onChange={(e) => setStyle({ fontFamily: e.target.value })}
          >
            {FONTS.map((f) => (
              <option key={f.label} value={f.value} style={{ fontFamily: f.value }}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <label className="texted__field texted__field--row">
          <span>Size</span>
          <input
            type="range"
            min={2}
            max={20}
            step={0.5}
            value={style.fontSize}
            onPointerDown={checkpoint}
            onChange={(e) => liveStyle({ fontSize: Number(e.target.value) })}
          />
          <em>{style.fontSize}</em>
        </label>

        {/* alignment */}
        <div className="texted__field texted__field--row">
          <span>Align</span>
          <div className="texted__seg">
            {(['left', 'center', 'right'] as TextAlignment[]).map((a) => (
              <button
                key={a}
                type="button"
                className={'texted__seg-btn' + (style.alignment === a ? ' is-active' : '')}
                onClick={() => setStyle({ alignment: a })}
              >
                {a === 'left' ? '⬅' : a === 'center' ? '⬌' : '➡'}
              </button>
            ))}
          </div>
        </div>

        {/* color + outline */}
        <div className="texted__field texted__field--row">
          <span>Color</span>
          <input
            type="color"
            value={style.color}
            onPointerDown={checkpoint}
            onChange={(e) => liveStyle({ color: e.target.value })}
          />
          <span>Outline</span>
          <input
            type="color"
            value={style.outlineColor}
            onPointerDown={checkpoint}
            onChange={(e) => liveStyle({ outlineColor: e.target.value })}
          />
        </div>

        <label className="texted__field texted__field--row">
          <span>Outline w.</span>
          <input
            type="range"
            min={0}
            max={0.2}
            step={0.01}
            value={style.outlineWidth}
            onPointerDown={checkpoint}
            onChange={(e) => liveStyle({ outlineWidth: Number(e.target.value) })}
          />
          <em>{style.outlineWidth.toFixed(2)}</em>
        </label>

        <label className="texted__field texted__field--row">
          <span>Opacity</span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={style.opacity}
            onPointerDown={checkpoint}
            onChange={(e) => liveStyle({ opacity: Number(e.target.value) })}
          />
          <em>{style.opacity.toFixed(2)}</em>
        </label>

        {/* shadow toggle */}
        <label className="texted__field texted__field--row">
          <span>Shadow</span>
          <input
            type="checkbox"
            checked={style.shadow}
            onChange={(e) => setStyle({ shadow: e.target.checked })}
          />
        </label>

        {/* animation */}
        <label className="texted__field">
          <span>Animation</span>
          <select
            value={overlay.animation}
            onChange={(e) => setOverlay({ animation: e.target.value as TextAnimation })}
          >
            {ANIMATIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        {overlay.animation === 'slide' && (
          <label className="texted__field">
            <span>Slide from</span>
            <select
              value={overlay.slideFrom}
              onChange={(e) => setOverlay({ slideFrom: e.target.value as SlideDirection })}
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
          </label>
        )}

        <button
          type="button"
          className="texted__delete"
          onClick={() => removeTextOverlay(id)}
        >
          Delete overlay
        </button>
      </div>
    </aside>
  );
}
