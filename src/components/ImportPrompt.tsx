import { useRef } from 'react';

interface ImportPromptProps {
  onFiles: (files: FileList | File[]) => void;
}

/**
 * Empty-state import UI shown inside the preview frame when there are no clips.
 * Provides a file picker; drag-and-drop is handled by the surrounding
 * PreviewArea so a drop anywhere on the preview works.
 */
export function ImportPrompt({ onFiles }: ImportPromptProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="import-prompt">
      <div className="import-prompt__icon" aria-hidden="true">
        ⬆
      </div>
      <p className="import-prompt__title">Drop a video here</p>
      <p className="import-prompt__hint">MP4 or MOV · up to 60s used</p>
      <button
        type="button"
        className="import-prompt__btn"
        onClick={() => inputRef.current?.click()}
      >
        Choose video
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".mp4,.mov,video/mp4,video/quicktime"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files);
          e.target.value = ''; // allow re-selecting the same file
        }}
      />
    </div>
  );
}
