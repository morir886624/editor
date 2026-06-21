import { useRef } from 'react';
import { useImportClips } from '../lib/useImportClips';
import { useEditorStore } from '../store/editorStore';

/**
 * Middle zone. Import (Stage 2) and Text (Stage 4) are enabled; the rest stay
 * disabled until their stages.
 */
const DISABLED_TOOLS = ['Audio', 'Split', 'Export'] as const;

export function Toolbar() {
  const { importFiles, importing } = useImportClips();
  const inputRef = useRef<HTMLInputElement>(null);

  const hasClips = useEditorStore((s) => s.clips.length > 0);
  const addTextOverlay = useEditorStore((s) => s.addTextOverlay);
  const setSelected = useEditorStore((s) => s.setSelected);

  const addText = () => {
    const id = addTextOverlay(); // at the current playhead, default 3s
    setSelected(id);
  };

  return (
    <nav className="toolbar" aria-label="Tools">
      <button
        type="button"
        className="toolbar__btn toolbar__btn--active"
        onClick={() => inputRef.current?.click()}
        disabled={importing}
      >
        {importing ? 'Importing…' : 'Import'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".mp4,.mov,video/mp4,video/quicktime"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) importFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <button
        type="button"
        className="toolbar__btn toolbar__btn--active"
        onClick={addText}
        disabled={!hasClips}
        title={hasClips ? 'Add a text overlay' : 'Import a clip first'}
      >
        Text
      </button>

      {DISABLED_TOOLS.map((label) => (
        <button key={label} type="button" className="toolbar__btn" disabled>
          {label}
        </button>
      ))}
    </nav>
  );
}
