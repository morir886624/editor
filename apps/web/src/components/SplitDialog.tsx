import { useRef, useState } from 'react';
import { useSplitStore } from '../store/splitStore';
import { useEditorStore } from '../store/editorStore';
import { useNoticeStore } from '../store/noticeStore';
import { isAcceptedFile, readVideoMeta } from '../lib/media';
import { planSegmentCount, type SplitSegment } from '../lib/splitter';
import { MAX_TIMELINE_DURATION } from '../lib/duration';
import { formatTime } from '../lib/timeline';

const LENGTH_PRESETS = [15, 30, 60] as const;
const MIN_LENGTH = 5;
const MAX_LENGTH = 60;

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

interface PickedSource {
  file: File;
  duration: number;
  url: string; // object URL from readVideoMeta — revoked when replaced
}

/**
 * "Split into shorts" modal: pick a LONG video, choose a segment length, and
 * cut it into consecutive shorts without re-encoding (keyframe-aligned cuts).
 * Results stream in live; each short can be downloaded or opened in the
 * editor (which imports it as a regular clip, auto-trimmed to the 60s cap).
 * Mirrors ExportDialog: content mounts only while open, settings are local.
 */
export function SplitDialog() {
  const isOpen = useSplitStore((s) => s.isOpen);
  if (!isOpen) return null;
  return <SplitDialogContent />;
}

function SplitDialogContent() {
  const status = useSplitStore((s) => s.status);
  const phase = useSplitStore((s) => s.phase);
  const progress = useSplitStore((s) => s.progress);
  const segments = useSplitStore((s) => s.segments);
  const segmentsTotal = useSplitStore((s) => s.segmentsTotal);
  const error = useSplitStore((s) => s.error);
  const start = useSplitStore((s) => s.start);
  const cancel = useSplitStore((s) => s.cancel);
  const close = useSplitStore((s) => s.close);

  const addSource = useEditorStore((s) => s.addSource);
  const addClip = useEditorStore((s) => s.addClip);
  const closeDialog = useSplitStore((s) => s.close);
  const notify = useNoticeStore((s) => s.push);

  const inputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<PickedSource | null>(null);
  const [reading, setReading] = useState(false);
  const [segmentLength, setSegmentLength] = useState(60);

  const running = status === 'running';
  const count = source ? planSegmentCount(source.duration, segmentLength) : 0;

  const pickFile = async (file: File) => {
    if (!isAcceptedFile(file)) {
      notify({ type: 'error', message: `"${file.name}" is not an MP4/MOV video.` });
      return;
    }
    setReading(true);
    try {
      const meta = await readVideoMeta(file);
      if (source) URL.revokeObjectURL(source.url);
      setSource({ file, duration: meta.duration, url: meta.url });
    } catch (e) {
      notify({
        type: 'error',
        message: e instanceof Error ? e.message : 'Could not read that file.',
      });
    } finally {
      setReading(false);
    }
  };

  // Import a short into the editor timeline as a normal clip. A FRESH object
  // URL is created from the segment's File: clip URLs are never revoked,
  // while the split result list revokes its own URLs on the next run. The
  // segment is also registered in the source library (Clips panel), which
  // owns the URL from then on — so no revoke even if the timeline is full.
  const editSegment = (seg: SplitSegment) => {
    const url = URL.createObjectURL(seg.file);
    addSource({ fileName: seg.filename, url, duration: seg.duration });
    const result = addClip({
      sourceFileName: seg.filename,
      src: url,
      sourceDuration: seg.duration,
      inPoint: 0,
      outPoint: Math.min(seg.duration, MAX_TIMELINE_DURATION),
    });
    if (!result.ok) {
      notify({ type: 'error', message: result.reason });
      return;
    }
    notify({ type: 'info', message: `${seg.filename} added to the timeline.` });
    closeDialog();
  };

  // Sequential <a download> clicks; the browser asks once to allow multiple
  // downloads. Small delay so clicks aren't coalesced.
  const downloadAll = async () => {
    for (const seg of segments) {
      const a = document.createElement('a');
      a.href = seg.url;
      a.download = seg.filename;
      a.click();
      await new Promise((r) => setTimeout(r, 350));
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !running && close()}>
      <div
        className="modal"
        role="dialog"
        aria-label="Split into shorts"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <strong>Split into shorts</strong>
          <button
            type="button"
            className="texted__close"
            onClick={close}
            disabled={running}
            title={running ? 'Cancel the split first' : 'Close'}
          >
            ✕
          </button>
        </header>

        <div className="modal__body">
          {/* source picker */}
          <div className="texted__field">
            <span>Long video</span>
            <input
              ref={inputRef}
              type="file"
              accept=".mp4,.mov,video/mp4,video/quicktime"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickFile(f);
                e.target.value = '';
              }}
            />
            {source ? (
              <div className="texted__filename" title={source.file.name}>
                {source.file.name} · {formatTime(source.duration)} ·{' '}
                {formatSize(source.file.size)}
              </div>
            ) : null}
            <button
              type="button"
              className="texted__preset"
              onClick={() => inputRef.current?.click()}
              disabled={running || reading}
            >
              {reading ? 'Reading…' : source ? 'Choose another video' : 'Choose a video (any length)'}
            </button>
          </div>

          {/* segment length */}
          <div className="texted__field">
            <span>Length of each short</span>
            <div className="texted__presets texted__presets--four">
              {LENGTH_PRESETS.map((len) => (
                <button
                  key={len}
                  type="button"
                  className={'texted__preset' + (segmentLength === len ? ' is-active' : '')}
                  onClick={() => setSegmentLength(len)}
                  disabled={running}
                >
                  {len}s
                </button>
              ))}
              <input
                className="modal__number"
                type="number"
                min={MIN_LENGTH}
                max={MAX_LENGTH}
                value={segmentLength}
                disabled={running}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) {
                    setSegmentLength(Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.round(v))));
                  }
                }}
              />
            </div>
          </div>

          {source && !running && status !== 'done' && (
            <p className="modal__note">
              {count} short{count > 1 ? 's' : ''} of ~{segmentLength}s. Cutting is instant and
              lossless (no re-encode); cut points snap to the video's keyframes, so each
              short may run a few seconds long.
            </p>
          )}

          {status === 'error' && error && (
            <p className="modal__note modal__note--error">{error}</p>
          )}

          {/* progress */}
          {running && (
            <div className="modal__progress">
              <div className="modal__progress-bar">
                <div
                  className="modal__progress-fill"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <div className="modal__progress-row">
                <span>{phase}</span>
                <span>
                  {segments.length}/{segmentsTotal || '?'}
                </span>
              </div>
            </div>
          )}

          {/* results — stream in while running, full list when done */}
          {segments.length > 0 && (
            <div className="modal__seglist">
              {segments.map((seg) => (
                <div key={seg.index} className="modal__segrow">
                  <span className="modal__segname" title={seg.filename}>
                    {String(seg.index + 1).padStart(2, '0')} · {formatTime(seg.duration)} ·{' '}
                    {formatSize(seg.sizeBytes)}
                  </span>
                  <span className="modal__segactions">
                    <a
                      className="modal__download modal__download--small"
                      href={seg.url}
                      download={seg.filename}
                    >
                      ⬇
                    </a>
                    <button
                      type="button"
                      className="texted__preset"
                      title="Open this short in the editor"
                      onClick={() => editSegment(seg)}
                      disabled={running}
                    >
                      Edit
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* actions */}
          <div className="modal__actions">
            {running ? (
              <button type="button" className="modal__btn modal__btn--danger" onClick={cancel}>
                Stop
              </button>
            ) : (
              <>
                {segments.length > 1 && (
                  <button type="button" className="modal__btn" onClick={downloadAll}>
                    ⬇ Download all ({segments.length})
                  </button>
                )}
                <button
                  type="button"
                  className="modal__btn modal__btn--primary"
                  onClick={() => source && start(source.file, source.duration, segmentLength)}
                  disabled={!source || reading}
                >
                  {status === 'done' ? 'Split again' : 'Split into shorts'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
