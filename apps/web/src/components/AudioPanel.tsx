import { useEditorStore } from '../store/editorStore';
import { useDraggablePanel } from '../lib/useDraggablePanel';
import { audioTrackDuration } from '../lib/audio';
import { formatTime } from '../lib/timeline';

/**
 * Editor for the selected audio track: volume (0–100%), fade in/out seconds,
 * and delete. Same gesture pattern as the text panel: sliders checkpoint once
 * on pointer-down, then commit live updates with { history: false } so a drag
 * is a single undo step. Reuses the .texted panel styles.
 */
export function AudioPanel() {
  const audioTracks = useEditorStore((s) => s.audioTracks);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const updateAudioTrack = useEditorStore((s) => s.updateAudioTrack);
  const removeAudioTrack = useEditorStore((s) => s.removeAudioTrack);
  const setSelected = useEditorStore((s) => s.setSelected);
  const checkpoint = useEditorStore((s) => s.checkpoint);
  const { ref, onHeaderPointerDown } = useDraggablePanel<HTMLElement>('texted');

  const track = audioTracks.find((a) => a.id === selectedItemId);
  if (!track) return null;

  const id = track.id;
  const dur = audioTrackDuration(track);
  // live edit during a slider gesture (no per-tick history)
  const live = (patch: Parameters<typeof updateAudioTrack>[1]) =>
    updateAudioTrack(id, patch, { history: false });

  return (
    <aside ref={ref} className="texted" aria-label="Audio editor">
      <header className="texted__header" onPointerDown={onHeaderPointerDown}>
        <strong>Audio</strong>
        <button type="button" className="texted__close" onClick={() => setSelected(null)}>
          ✕
        </button>
      </header>

      <div className="texted__body">
        <div className="texted__field">
          <span>Track</span>
          <div className="texted__filename" title={track.sourceFileName}>
            {track.sourceFileName} · {formatTime(dur)}
          </div>
        </div>

        <label className="texted__field texted__field--row">
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(track.volume * 100)}
            onPointerDown={checkpoint}
            onChange={(e) => live({ volume: Number(e.target.value) / 100 })}
          />
          <em>{Math.round(track.volume * 100)}%</em>
        </label>

        <label className="texted__field texted__field--row">
          <span>Fade in</span>
          <input
            type="range"
            min={0}
            max={5}
            step={0.1}
            value={track.fadeIn}
            onPointerDown={checkpoint}
            onChange={(e) => live({ fadeIn: Number(e.target.value) })}
          />
          <em>{track.fadeIn.toFixed(1)}s</em>
        </label>

        <label className="texted__field texted__field--row">
          <span>Fade out</span>
          <input
            type="range"
            min={0}
            max={5}
            step={0.1}
            value={track.fadeOut}
            onPointerDown={checkpoint}
            onChange={(e) => live({ fadeOut: Number(e.target.value) })}
          />
          <em>{track.fadeOut.toFixed(1)}s</em>
        </label>

        <button
          type="button"
          className="texted__delete"
          onClick={() => removeAudioTrack(id)}
        >
          Delete audio
        </button>
      </div>
    </aside>
  );
}
