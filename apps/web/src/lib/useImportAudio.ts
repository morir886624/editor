import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useNoticeStore } from '../store/noticeStore';
import { isAcceptedAudioFile, readAudioMeta, type AudioMeta } from './media';
import { MAX_TIMELINE_DURATION } from './duration';
import { getWaveformPeaks } from './waveform';

/**
 * Audio import flow, shared by the toolbar's Audio button and drag-drop:
 *  - reject non-MP3/WAV/AAC files with a notice,
 *  - read real duration via a hidden <audio>,
 *  - add the track (trimmed to the 60s ruler if longer, with a notice),
 *  - kick off waveform peak computation in the background so the timeline
 *    block usually has peaks by the time it renders.
 *
 * Object URL lifecycle mirrors clips: the URL is only revoked if reading
 * metadata fails (the file never entered the store); once a track is added it
 * is never revoked, because undo may restore it after removal.
 */
export function useImportAudio() {
  const addAudioTrack = useEditorStore((s) => s.addAudioTrack);
  const setSelected = useEditorStore((s) => s.setSelected);
  const notify = useNoticeStore((s) => s.push);
  const [importingAudio, setImportingAudio] = useState(false);

  const importAudioFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setImportingAudio(true);
    try {
      for (const file of list) {
        if (!isAcceptedAudioFile(file)) {
          notify({
            type: 'error',
            message: `"${file.name}": only MP3, WAV and AAC audio is supported.`,
          });
          continue;
        }

        let meta: AudioMeta;
        try {
          meta = await readAudioMeta(file);
        } catch (e) {
          notify({ type: 'error', message: e instanceof Error ? e.message : 'Could not read file.' });
          continue;
        }

        const id = addAudioTrack({
          sourceFileName: file.name,
          src: meta.url,
          sourceDuration: meta.duration,
        });
        setSelected(id);

        if (meta.duration > MAX_TIMELINE_DURATION) {
          notify({
            type: 'info',
            message: `"${file.name}" is longer than 60s — using the first 60s. Trim it on the audio track.`,
          });
        }

        // Warm the peaks cache off the render path; the block shows a
        // placeholder until this resolves.
        getWaveformPeaks(meta.url).catch(() => {});
      }
    } finally {
      setImportingAudio(false);
    }
  };

  return { importAudioFiles, importingAudio };
}
