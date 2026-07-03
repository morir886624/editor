import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useImportClips } from '../lib/useImportClips';
import { useImportAudio } from '../lib/useImportAudio';
import { isAcceptedAudioFile } from '../lib/media';
import { ImportPrompt } from './ImportPrompt';
import { PreviewPlayer } from './PreviewPlayer';

const ASPECT_CSS: Record<string, string> = {
  '9:16': '9 / 16',
  '1:1': '1 / 1',
  '16:9': '16 / 9',
};

/**
 * Top zone. Empty state = drag-and-drop import prompt. With clips, hosts the
 * real-time preview player. The whole area stays a drop target so videos can be
 * dropped to append at any time.
 */
export function PreviewArea() {
  const clips = useEditorStore((s) => s.clips);
  const aspectRatio = useEditorStore((s) => s.settings.aspectRatio);
  const { importFiles } = useImportClips();
  const { importAudioFiles } = useImportAudio();
  const [dragOver, setDragOver] = useState(false);

  // Route dropped files by kind: audio to the audio track, the rest to the
  // video importer (which reports unsupported files with a notice).
  const handleDrop = (files: FileList) => {
    const list = Array.from(files);
    const audio = list.filter(isAcceptedAudioFile);
    const rest = list.filter((f) => !isAcceptedAudioFile(f));
    if (audio.length) importAudioFiles(audio);
    if (rest.length) importFiles(rest);
  };

  return (
    <section
      className={'preview' + (dragOver ? ' preview--dragover' : '')}
      aria-label="Preview"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) handleDrop(e.dataTransfer.files);
      }}
    >
      {clips.length === 0 ? (
        <div
          className="preview__frame"
          style={{ aspectRatio: ASPECT_CSS[aspectRatio] ?? '9 / 16' }}
        >
          <ImportPrompt onFiles={importFiles} />
        </div>
      ) : (
        <PreviewPlayer />
      )}

      {dragOver && <div className="preview__drop-hint">Drop to add video or audio</div>}
    </section>
  );
}
