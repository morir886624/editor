import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useDraggablePanel } from '../lib/useDraggablePanel';
import { useSourceAspect } from '../lib/useSourceAspect';
import { CROP_ASPECT_OPTIONS, aspectCrop, isFullCrop } from '../lib/crop';
import { clipDuration } from '../lib/duration';

/**
 * Crop / reframe editor for the selected clip. The actual framing happens on
 * the preview: "Adjust on preview" starts a crop session (store's
 * cropEditingClipId) — the preview then shows the full source with a
 * draggable/resizable rectangle (CropOverlay). This panel holds the session
 * toggle, aspect-ratio presets (which also lock the handles) and reset.
 * The crop is stored as data on the clip (never baked), so preview and export
 * render it identically. Reuses the .texted panel styles.
 */
export function CropPanel() {
  const clips = useEditorStore((s) => s.clips);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const cropEditingClipId = useEditorStore((s) => s.cropEditingClipId);
  const aspectLock = useEditorStore((s) => s.cropAspectLock);
  const setClipCrop = useEditorStore((s) => s.setClipCrop);
  const setCropEditing = useEditorStore((s) => s.setCropEditing);
  const setCropAspectLock = useEditorStore((s) => s.setCropAspectLock);
  const setSelected = useEditorStore((s) => s.setSelected);
  const { ref, onHeaderPointerDown } = useDraggablePanel<HTMLElement>('texted');

  const clip = clips.find((c) => c.id === selectedItemId);
  const clipId = clip?.id ?? null;
  const srcAspect = useSourceAspect(clip?.src);

  // Leaving this clip (selection change or panel unmount) ends its session.
  useEffect(() => {
    if (!clipId) return;
    return () => {
      const s = useEditorStore.getState();
      if (s.cropEditingClipId === clipId) s.setCropEditing(null);
    };
  }, [clipId]);

  if (!clip) return null;

  const editing = cropEditingClipId === clip.id;
  const hasCrop = !isFullCrop(clip.crop);

  const startSession = () => {
    const s = useEditorStore.getState();
    s.setPlaying(false);
    // Park the playhead inside the clip so the preview displays it.
    const dur = clipDuration(clip);
    if (s.playheadTime < clip.position || s.playheadTime > clip.position + dur) {
      s.setPlayhead(clip.position + dur / 2);
    }
    setCropEditing(clip.id);
  };

  const applyAspect = (ratio: number | null) => {
    setCropAspectLock(ratio);
    // A ratio preset immediately reframes to the largest centered rect of
    // that shape; "Free" only unlocks the handles (keeps the current rect).
    if (ratio && srcAspect) setClipCrop(clip.id, aspectCrop(srcAspect, ratio));
    if (!editing) startSession();
  };

  return (
    <aside ref={ref} className="texted" aria-label="Crop editor">
      <header className="texted__header" onPointerDown={onHeaderPointerDown}>
        <strong>Crop</strong>
        <button type="button" className="texted__close" onClick={() => setSelected(null)}>
          ✕
        </button>
      </header>

      <div className="texted__body">
        <div className="texted__field">
          <span>Clip</span>
          <div className="texted__filename" title={clip.sourceFileName}>
            {clip.sourceFileName} · {clipDuration(clip).toFixed(1)}s on timeline
          </div>
        </div>

        <button
          type="button"
          className={'texted__preset' + (editing ? ' is-active' : '')}
          onClick={() => (editing ? setCropEditing(null) : startSession())}
        >
          {editing ? 'Done — apply framing' : 'Adjust on preview'}
        </button>

        <div className="texted__field">
          <span>Aspect</span>
          <div className="texted__presets texted__presets--four">
            {CROP_ASPECT_OPTIONS.map((opt) => {
              const active = opt.ratio === aspectLock;
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={'texted__preset' + (active ? ' is-active' : '')}
                  onClick={() => applyAspect(opt.ratio)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {hasCrop && clip.crop && (
          <div className="texted__field">
            <span>
              Showing {Math.round(clip.crop.w * 100)}% × {Math.round(clip.crop.h * 100)}% of the
              source
            </span>
          </div>
        )}

        {hasCrop && (
          <button
            type="button"
            className="texted__preset"
            onClick={() => {
              setClipCrop(clip.id, null);
              setCropAspectLock(null);
            }}
          >
            Reset crop
          </button>
        )}

        <p className="cropper__hint">
          Drag the rectangle on the preview to reframe the shot; drag its corners to resize. A
          ratio preset locks the corners to that shape.
        </p>
      </div>
    </aside>
  );
}
