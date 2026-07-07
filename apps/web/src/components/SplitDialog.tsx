import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useSplitStore, type SplitSource } from '../store/splitStore';
import { useEditorStore } from '../store/editorStore';
import { useNoticeStore } from '../store/noticeStore';
import { isAcceptedFile, readVideoMeta } from '../lib/media';
import { planSegmentCount, type SplitSegment } from '../lib/splitter';
import { MAX_TIMELINE_DURATION } from '../lib/duration';
import { formatTime, formatTimecode } from '../lib/timeline';

const LENGTH_PRESETS = [15, 30, 60] as const;
const MIN_LENGTH = 5;
const MAX_LENGTH = 60;
/** Shortest short the adjust flow will re-cut (seconds). */
const MIN_RECUT_LENGTH = 1;
/** Extra source seconds kept on EACH side when a short is opened in the
 *  editor — the editor's trim handles and "Slide cut" buttons can then move
 *  the window to recover speech the blind cut clipped. */
const EDIT_MARGIN = 10;

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * "Split into shorts" modal: pick a LONG video, choose a segment length, and
 * cut it into consecutive shorts without re-encoding (keyframe-aligned cuts).
 * Results stream in live; each short can be downloaded, opened in the editor
 * (imported as a regular clip, auto-trimmed to the 60s cap), or ADJUSTED —
 * the auto-split cuts blindly (often mid-sentence), so "Adjust" opens the
 * ORIGINAL video to browse and re-frame that short's start/end, then re-cuts
 * it in place. Mirrors ExportDialog: content mounts only while open; the
 * picked source lives in splitStore so adjusting still works after closing
 * and reopening the dialog.
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
  const source = useSplitStore((s) => s.source);
  const error = useSplitStore((s) => s.error);
  const setSource = useSplitStore((s) => s.setSource);
  const start = useSplitStore((s) => s.start);
  const cutForEdit = useSplitStore((s) => s.cutForEdit);
  const cancel = useSplitStore((s) => s.cancel);
  const close = useSplitStore((s) => s.close);

  const addSource = useEditorStore((s) => s.addSource);
  const addClip = useEditorStore((s) => s.addClip);
  const notify = useNoticeStore((s) => s.push);

  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [segmentLength, setSegmentLength] = useState(60);
  // Index of the segment being adjusted against the original (null = list view).
  const [adjusting, setAdjusting] = useState<number | null>(null);

  const running = status === 'running';
  const count = source ? planSegmentCount(source.duration, segmentLength) : 0;
  const adjustingSegment =
    adjusting === null ? undefined : segments.find((s) => s.index === adjusting);

  const pickFile = async (file: File) => {
    if (!isAcceptedFile(file)) {
      notify({ type: 'error', message: `"${file.name}" is not an MP4/MOV video.` });
      return;
    }
    setReading(true);
    try {
      const meta = await readVideoMeta(file);
      setSource({ file, duration: meta.duration, url: meta.url });
      setAdjusting(null);
    } catch (e) {
      notify({
        type: 'error',
        message: e instanceof Error ? e.message : 'Could not read that file.',
      });
    } finally {
      setReading(false);
    }
  };

  // Import a short into the editor timeline as a normal clip — preferably as
  // a MARGIN-padded cut of the original (±EDIT_MARGIN s of extra source), so
  // the clip arrives trimmed to the short's window but the editor's trim
  // handles and "Slide cut" buttons can reach beyond it and recover speech
  // the blind cut clipped. Falls back to the exact segment file if padding
  // fails. URL lifecycle: clip URLs are never revoked, while split-result
  // URLs are revoked on the next run — so the clip gets its OWN url (the
  // padded cut's url is fresh and untracked; the exact-file fallback creates
  // one). The source library (Clips panel) owns it from then on.
  const editSegment = async (seg: SplitSegment) => {
    let file = seg.file;
    let url: string | null = null;
    let sourceDuration = seg.duration;
    let inPoint = 0;

    if (source) {
      const padStart = Math.max(0, seg.requestedStart - EDIT_MARGIN);
      const padEnd = Math.min(
        source.duration,
        seg.requestedStart + seg.duration + EDIT_MARGIN,
      );
      const padded = await cutForEdit(seg.index, padStart, padEnd);
      if (padded) {
        file = padded.file;
        url = padded.url;
        sourceDuration = padded.duration;
        // Stream copy starts on the keyframe at-or-before padStart, so this
        // offset can sit up to one GOP off — close enough: the margin exists
        // precisely so the user re-frames by ear in the editor.
        inPoint = Math.min(
          Math.max(0, seg.requestedStart - padStart),
          Math.max(0, sourceDuration - MIN_RECUT_LENGTH),
        );
      } else {
        notify({
          type: 'info',
          message: 'Could not prepare the padded version — importing the short as-is.',
        });
      }
    }

    const src = url ?? URL.createObjectURL(file);
    addSource({ fileName: seg.filename, url: src, duration: sourceDuration });
    const outPoint = Math.min(
      inPoint + Math.min(seg.duration, MAX_TIMELINE_DURATION),
      sourceDuration,
    );
    const result = addClip({
      sourceFileName: seg.filename,
      src,
      sourceDuration,
      inPoint,
      outPoint,
    });
    if (!result.ok) {
      notify({ type: 'error', message: result.reason });
      return;
    }
    notify({
      type: 'info',
      message:
        `${seg.filename} added to the timeline` +
        (url ? ` with ±${EDIT_MARGIN}s of margin — use the trim handles or "Slide cut" to re-frame.` : '.'),
    });
    close();
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
        className={'modal' + (adjustingSegment ? ' modal--wide' : '')}
        role="dialog"
        aria-label="Split into shorts"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <strong>
            {adjustingSegment
              ? `Adjust short ${String(adjustingSegment.index + 1).padStart(2, '0')}`
              : 'Split into shorts'}
          </strong>
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

        {adjustingSegment && source ? (
          <AdjustView
            source={source}
            segment={adjustingSegment}
            running={running}
            phase={phase}
            progress={progress}
            error={status === 'error' ? error : null}
            onCancel={cancel}
            onBack={() => setAdjusting(null)}
          />
        ) : (
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
                {reading
                  ? 'Reading…'
                  : source
                    ? 'Choose another video'
                    : 'Choose a video (any length)'}
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
                        title="Browse the original video and re-frame this short's start/end"
                        onClick={() => setAdjusting(seg.index)}
                        disabled={running || !source}
                      >
                        Adjust
                      </button>
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
                    onClick={() => start(segmentLength)}
                    disabled={!source || reading}
                  >
                    {status === 'done' ? 'Split again' : 'Split into shorts'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Re-frame one short against the ORIGINAL video: a player of the full source
 * (browse/listen freely), plus start/end bounds set from the playhead ("the
 * sentence starts HERE") or nudged by a second. "Re-cut" replaces the short
 * in place — still stream-copy, so the start snaps to the keyframe at or
 * BEFORE the chosen time (the short may begin a moment early, never late;
 * precise trimming then happens in the editor, which is frame-exact).
 */
function AdjustView({
  source,
  segment,
  running,
  phase,
  progress,
  error,
  onCancel,
  onBack,
}: {
  source: SplitSource;
  segment: SplitSegment;
  running: boolean;
  phase: string;
  progress: number;
  error: string | null;
  onCancel: () => void;
  onBack: () => void;
}) {
  const recut = useSplitStore((s) => s.recut);
  const notify = useNoticeStore((s) => s.push);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const clamp = (t: number) => Math.min(source.duration, Math.max(0, t));
  const [startTime, setStartTime] = useState(() => clamp(segment.requestedStart));
  const [endTime, setEndTime] = useState(() =>
    clamp(segment.requestedStart + segment.duration),
  );
  // Player position mirrored into state so the strip's playhead line tracks it.
  const [played, setPlayed] = useState(() => clamp(segment.requestedStart));

  // Open the original where this short currently starts.
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.currentTime = clamp(segment.requestedStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seekTo = (t: number) => {
    const v = videoRef.current;
    const c = clamp(t);
    if (v) v.currentTime = c;
    setPlayed(c); // don't wait for the (throttled) timeupdate event
  };
  const playhead = () => videoRef.current?.currentTime ?? 0;

  // ---- window navigation: slide the WHOLE short over the full video --------
  // The ◀ ▶ buttons and the draggable window keep the short's length and move
  // both bounds together; refs carry the latest bounds so the hold-to-repeat
  // interval isn't frozen on the values it closed over.
  const startRef = useRef(startTime);
  startRef.current = startTime;
  const endRef = useRef(endTime);
  endRef.current = endTime;

  const moveWindowTo = (start: number, length: number) => {
    const s = Math.min(Math.max(0, start), Math.max(0, source.duration - length));
    setStartTime(s);
    setEndTime(Math.min(source.duration, s + length));
    seekTo(s);
  };
  const shiftWindow = (delta: number) =>
    moveWindowTo(startRef.current + delta, endRef.current - startRef.current);

  const holdTimer = useRef<number | null>(null);
  const endHold = () => {
    if (holdTimer.current !== null) {
      window.clearInterval(holdTimer.current);
      holdTimer.current = null;
    }
  };
  const beginHold = (delta: number) => {
    endHold();
    shiftWindow(delta);
    holdTimer.current = window.setInterval(() => shiftWindow(delta), 180);
  };
  useEffect(() => endHold, []);

  const timeAtX = (clientX: number): number => {
    const el = stripRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * source.duration);
  };

  // Ruler ticks over the full source: a "nice" step that yields ~8 labels.
  const ticks = (() => {
    const target = source.duration / 8;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
    const step = steps.find((s) => s >= target) ?? 3600;
    const out: number[] = [];
    for (let t = 0; t <= source.duration - step / 2; t += step) out.push(t);
    return out;
  })();

  // Click (or drag) the strip background = preview that moment in the player.
  const scrubStrip = (e: ReactPointerEvent) => {
    if (running) return;
    seekTo(timeAtX(e.clientX));
    const move = (ev: PointerEvent) => seekTo(timeAtX(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Drag the highlighted window = slide the whole short, previewing its start.
  const dragWindow = (e: ReactPointerEvent) => {
    if (running) return;
    e.stopPropagation(); // don't also scrub the strip underneath
    const el = stripRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s0 = startTime;
    const length = endTime - startTime;
    const x0 = e.clientX;
    const move = (ev: PointerEvent) =>
      moveWindowTo(s0 + ((ev.clientX - x0) / r.width) * source.duration, length);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const length = endTime - startTime;
  const tooShort = length < MIN_RECUT_LENGTH;
  const tooLong = length > MAX_TIMELINE_DURATION + 0.001;
  const valid = !tooShort && !tooLong;

  const apply = async () => {
    videoRef.current?.pause();
    const ok = await recut(segment.index, startTime, endTime);
    if (ok) {
      notify({
        type: 'info',
        message: `${segment.filename} re-cut (${formatTimecode(startTime)} → ${formatTimecode(endTime)}).`,
      });
      onBack();
    }
  };

  const boundRow = (
    label: string,
    value: number,
    setValue: (t: number) => void,
    setHereLabel: string,
  ) => (
    <div className="adjust__row">
      <span className="adjust__label">{label}</span>
      <em className="adjust__time">{formatTimecode(value)}</em>
      <button
        type="button"
        className="texted__mini"
        onClick={() => {
          const t = clamp(value - 1);
          setValue(t);
          seekTo(t);
        }}
        disabled={running}
      >
        −1s
      </button>
      <button
        type="button"
        className="texted__mini"
        onClick={() => {
          const t = clamp(value + 1);
          setValue(t);
          seekTo(t);
        }}
        disabled={running}
      >
        +1s
      </button>
      <button
        type="button"
        className="texted__mini"
        title="Seek the player to this bound"
        onClick={() => seekTo(value)}
        disabled={running}
      >
        Go to
      </button>
      <button
        type="button"
        className="texted__preset adjust__sethere"
        title="Use the player's current time as this bound"
        onClick={() => setValue(clamp(playhead()))}
        disabled={running}
      >
        {setHereLabel}
      </button>
    </div>
  );

  return (
    <div className="modal__body">
      <p className="modal__note">
        Browse the <strong>original video</strong> and re-frame this short. The bar below is
        the whole video; the highlighted block is this short — drag it or use ◀ ▶ to slide
        it, click anywhere on the bar to preview that moment.
      </p>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- source video */}
      <video
        ref={videoRef}
        className="adjust__video"
        src={source.url}
        controls
        playsInline
        preload="metadata"
        onTimeUpdate={(e) => setPlayed(e.currentTarget.currentTime)}
      />

      {/* full-video map: ◀◀ ◀ [ ruler + window ] ▶ ▶▶ */}
      <div className="adjust__nav">
        <button
          type="button"
          className="adjust__navbtn"
          title="Slide the whole short 10s earlier (hold to repeat)"
          onPointerDown={() => beginHold(-10)}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
          disabled={running}
        >
          ◀◀
        </button>
        <button
          type="button"
          className="adjust__navbtn"
          title="Slide the whole short 1s earlier (hold to repeat)"
          onPointerDown={() => beginHold(-1)}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
          disabled={running}
        >
          ◀
        </button>
        <div
          ref={stripRef}
          className="adjust__strip"
          title="The full video — click to preview, drag the block to move the short"
          onPointerDown={scrubStrip}
        >
          {ticks.map((t) => (
            <div
              key={t}
              className="adjust__tick"
              style={{ left: `${(t / source.duration) * 100}%` }}
            >
              <span className="adjust__tick-label">{formatTime(t)}</span>
            </div>
          ))}
          <div
            className="adjust__window"
            style={{
              left: `${(startTime / source.duration) * 100}%`,
              width: `${(Math.max(0, endTime - startTime) / source.duration) * 100}%`,
            }}
            onPointerDown={dragWindow}
          >
            <span className="adjust__window-label">{length.toFixed(0)}s</span>
          </div>
          <div
            className="adjust__playline"
            style={{ left: `${(clamp(played) / source.duration) * 100}%` }}
          />
        </div>
        <button
          type="button"
          className="adjust__navbtn"
          title="Slide the whole short 1s later (hold to repeat)"
          onPointerDown={() => beginHold(1)}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
          disabled={running}
        >
          ▶
        </button>
        <button
          type="button"
          className="adjust__navbtn"
          title="Slide the whole short 10s later (hold to repeat)"
          onPointerDown={() => beginHold(10)}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
          disabled={running}
        >
          ▶▶
        </button>
      </div>

      {boundRow('Start', startTime, setStartTime, 'Start here')}
      {boundRow('End', endTime, setEndTime, 'End here')}

      <p className={'modal__note' + (valid ? '' : ' modal__note--error')}>
        {tooShort
          ? `A short must be at least ${MIN_RECUT_LENGTH}s (start must come before end).`
          : tooLong
            ? `A short can't exceed ${MAX_TIMELINE_DURATION}s — currently ${length.toFixed(1)}s. Move the start or the end closer.`
            : `New length: ${length.toFixed(1)}s. The cut starts on the keyframe at or before ${formatTimecode(startTime)}, so it may begin a moment early — never late. Fine-trim in the editor afterwards.`}
      </p>

      {error && <p className="modal__note modal__note--error">{error}</p>}

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
            <span>{Math.round(progress * 100)}%</span>
          </div>
        </div>
      )}

      <div className="modal__actions">
        {running ? (
          <button type="button" className="modal__btn modal__btn--danger" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <>
            <button type="button" className="modal__btn" onClick={onBack}>
              ← Back
            </button>
            <button
              type="button"
              className="modal__btn modal__btn--primary"
              onClick={apply}
              disabled={!valid}
            >
              Re-cut this short
            </button>
          </>
        )}
      </div>
    </div>
  );
}
