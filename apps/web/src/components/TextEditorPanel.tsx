import { useRef, type ChangeEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useNoticeStore } from '../store/noticeStore';
import { useDraggablePanel } from '../lib/useDraggablePanel';
import { ANIMATIONS, TEXT_PRESETS } from '../lib/overlay';
import {
  ARABIC_SAMPLES,
  FONT_GROUPS,
  KFGQPC_FAMILY,
  importFontFile,
  overlayLineHeight,
  useFontStore,
} from '../lib/fonts';
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
  const duplicateTextOverlay = useEditorStore((s) => s.duplicateTextOverlay);
  const moveTextOverlayLayer = useEditorStore((s) => s.moveTextOverlayLayer);
  const copyOverlayStyle = useEditorStore((s) => s.copyOverlayStyle);
  const pasteOverlayStyle = useEditorStore((s) => s.pasteOverlayStyle);
  const styleClipboard = useEditorStore((s) => s.styleClipboard);
  const setSelected = useEditorStore((s) => s.setSelected);
  const checkpoint = useEditorStore((s) => s.checkpoint);
  const pushNotice = useNoticeStore((s) => s.push);
  const importedFamilies = useFontStore((s) => s.importedFamilies);
  const fontFileRef = useRef<HTMLInputElement>(null);
  const { ref, onHeaderPointerDown } = useDraggablePanel<HTMLElement>('texted');

  const kfgqpcReady = importedFamilies.includes(KFGQPC_FAMILY);

  const overlay = overlays.find((o) => o.id === selectedItemId);
  if (!overlay) return null;

  const id = overlay.id;
  const style = overlay.style;
  const overlayIndex = overlays.findIndex((o) => o.id === id);

  // discrete edit (one undo step)
  const setOverlay = (patch: Parameters<typeof updateTextOverlay>[1]) =>
    updateTextOverlay(id, patch);
  const setStyle = (patch: Partial<TextStyle>) => updateTextOverlay(id, { style: patch });
  // live edit during a drag gesture (no per-tick history)
  const liveStyle = (patch: Partial<TextStyle>) =>
    updateTextOverlay(id, { style: patch }, { history: false });

  // KFGQPC HAFS is user-imported (session-only), never bundled — see the
  // license note below and /public/fonts/LICENSE.md.
  const kfgqpcStack = FONT_GROUPS.flatMap((g) => g.fonts).find((f) => f.requiresImport)!;
  const onImportKfgqpc = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    try {
      await importFontFile(file, KFGQPC_FAMILY);
      setStyle({ fontFamily: kfgqpcStack.value });
      pushNotice({ type: 'success', message: 'KFGQPC HAFS imported for this session.' });
    } catch {
      pushNotice({
        type: 'error',
        message: 'Could not load that file as a font (.ttf / .otf / .woff2 expected).',
      });
    }
  };

  return (
    <aside ref={ref} className="texted" aria-label="Text editor">
      <header className="texted__header" onPointerDown={onHeaderPointerDown}>
        <strong>Text</strong>
        <button type="button" className="texted__close" onClick={() => setSelected(null)}>
          ✕
        </button>
      </header>

      <div className="texted__body">
        {/* manipulation actions (Part 1): duplicate / copy-paste style /
            lock / z-order. Layer order = array order (last = on top). */}
        <div className="texted__actions">
          <button
            type="button"
            className="texted__action"
            title="Duplicate this overlay (Ctrl+D)"
            onClick={() => duplicateTextOverlay(id)}
          >
            ⧉ Duplicate
          </button>
          <button
            type="button"
            className={'texted__action' + (overlay.locked ? ' is-active' : '')}
            title={overlay.locked ? 'Unlock (allow moving in the preview)' : 'Lock position'}
            onClick={() => setOverlay({ locked: !overlay.locked })}
          >
            {overlay.locked ? '🔒 Locked' : '🔓 Lock'}
          </button>
          <button
            type="button"
            className="texted__action"
            title="Copy this overlay's style + animation"
            onClick={() => copyOverlayStyle(id)}
          >
            ⎘ Copy style
          </button>
          <button
            type="button"
            className="texted__action"
            title={styleClipboard ? 'Apply the copied style here' : 'Copy a style first'}
            disabled={!styleClipboard}
            onClick={() => pasteOverlayStyle(id)}
          >
            ⎗ Paste style
          </button>
          <button
            type="button"
            className="texted__action"
            title="Bring forward (draw on top of the next overlay)"
            disabled={overlayIndex >= overlays.length - 1}
            onClick={() => moveTextOverlayLayer(id, 'forward')}
          >
            ▲ Forward
          </button>
          <button
            type="button"
            className="texted__action"
            title="Send backward (draw behind the previous overlay)"
            disabled={overlayIndex <= 0}
            onClick={() => moveTextOverlayLayer(id, 'backward')}
          >
            ▼ Backward
          </button>
        </div>

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
            dir="auto"
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
            {FONT_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.fonts.map((f) => (
                  <option
                    key={f.label}
                    value={f.value}
                    disabled={f.requiresImport && !kfgqpcReady}
                    style={{ fontFamily: f.value }}
                  >
                    {f.label + (f.requiresImport && !kfgqpcReady ? ' — import below' : '')}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {/* Arabic / Quran: sample texts + user-imported KFGQPC font */}
        <div className="texted__arabic">
          <div className="texted__group-title">Arabic / Quran</div>
          <div className="texted__presets">
            {ARABIC_SAMPLES.map((s) => (
              <button
                key={s.name}
                type="button"
                className="texted__preset"
                onClick={() => setOverlay({ text: s.text, style: s.style })}
              >
                {s.name}
              </button>
            ))}
          </div>
          <p className="texted__note">
            Samples are for convenience only — verify Quranic text against an authentic
            source (a trusted mushaf or tanzil.net) before publishing.
          </p>
          {kfgqpcReady ? (
            <p className="texted__note texted__note--ok">
              KFGQPC HAFS is loaded for this session (re-import after a reload).
            </p>
          ) : (
            <>
              <button
                type="button"
                className="texted__import"
                onClick={() => fontFileRef.current?.click()}
              >
                Import KFGQPC HAFS font file…
              </button>
              <input
                ref={fontFileRef}
                type="file"
                accept=".ttf,.otf,.woff,.woff2"
                hidden
                onChange={onImportKfgqpc}
              />
            </>
          )}
          <p className="texted__note">
            KFGQPC HAFS (Uthmani) is licensed by the King Fahd Glorious Quran Printing
            Complex — free for displaying the Quran, but it must not be modified or sold,
            so it is not bundled. Get it from fonts.qurancomplex.gov.sa; you are
            responsible for complying with its license.
          </p>
        </div>

        <label className="texted__field texted__field--row">
          <span>Size</span>
          <input
            type="range"
            min={2}
            max={32}
            step={0.5}
            value={style.fontSize}
            onPointerDown={checkpoint}
            onChange={(e) => liveStyle({ fontSize: Number(e.target.value) })}
          />
          <em>{style.fontSize}</em>
        </label>

        {/* rotation (also draggable via the preview's rotate handle) */}
        <label className="texted__field texted__field--row">
          <span>Rotate</span>
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            value={Math.round(overlay.rotation)}
            onPointerDown={checkpoint}
            onChange={(e) =>
              updateTextOverlay(id, { rotation: Number(e.target.value) }, { history: false })
            }
          />
          <em>{Math.round(overlay.rotation)}°</em>
        </label>

        {/* line height: explicit multiplier, or automatic per font group
            (1.15 Latin / 1.7 Arabic — tall marks need the extra room) */}
        <div className="texted__field texted__field--row">
          <span>Line h.</span>
          <input
            type="range"
            min={0.8}
            max={2.5}
            step={0.05}
            value={overlayLineHeight(style)}
            onPointerDown={checkpoint}
            onChange={(e) => liveStyle({ lineHeight: Number(e.target.value) })}
          />
          <em>{style.lineHeight != null ? overlayLineHeight(style).toFixed(2) : 'auto'}</em>
          <button
            type="button"
            className="texted__mini"
            title="Back to automatic (per font)"
            disabled={style.lineHeight == null}
            onClick={() => setStyle({ lineHeight: undefined })}
          >
            auto
          </button>
        </div>

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
