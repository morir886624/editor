import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useNoticeStore } from '../store/noticeStore';
import { isAcceptedFile, readVideoMeta, type VideoMeta } from './media';
import { MAX_TIMELINE_DURATION } from './duration';

/**
 * Encapsulates the full import flow so both the drop zone and the toolbar's
 * Import button share identical behavior:
 *  - reject non-MP4/MOV files with a notice,
 *  - read real duration via a hidden <video>,
 *  - auto-trim sources longer than 60s to outPoint=60 (with a notice),
 *  - respect the store's 60s total guard (revoking the URL if rejected),
 *  - append accepted clips in sequence.
 */
export function useImportClips() {
  const addClip = useEditorStore((s) => s.addClip);
  const setSelected = useEditorStore((s) => s.setSelected);
  const notify = useNoticeStore((s) => s.push);
  const [importing, setImporting] = useState(false);

  const importFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setImporting(true);
    try {
      for (const file of list) {
        if (!isAcceptedFile(file)) {
          notify({ type: 'error', message: `"${file.name}": only MP4 and MOV are supported.` });
          continue;
        }

        let meta: VideoMeta;
        try {
          meta = await readVideoMeta(file);
        } catch (e) {
          notify({ type: 'error', message: e instanceof Error ? e.message : 'Could not read file.' });
          continue;
        }

        const overLimit = meta.duration > MAX_TIMELINE_DURATION;
        const outPoint = overLimit ? MAX_TIMELINE_DURATION : meta.duration;

        const result = addClip({
          sourceFileName: file.name,
          src: meta.url,
          sourceDuration: meta.duration,
          inPoint: 0,
          outPoint,
        });

        if (!result.ok) {
          // Clip never entered the store — safe to release its URL now.
          URL.revokeObjectURL(meta.url);
          notify({ type: 'error', message: result.reason });
          continue;
        }

        if (overLimit) {
          notify({
            type: 'info',
            message: `"${file.name}" is longer than 60s — added the first 60s. Trim it on the timeline.`,
          });
        }
      }
    } finally {
      setImporting(false);
      // Select the last clip so its trim handles are immediately available.
      const clips = useEditorStore.getState().clips;
      if (clips.length > 0) setSelected(clips[clips.length - 1].id);
    }
  };

  return { importFiles, importing };
}
