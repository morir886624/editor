import { useEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useExportStore } from '../store/exportStore';
import { MAX_TIMELINE_DURATION, computeTotalDuration } from '../lib/duration';
import { QUALITY_SETTINGS, RESOLUTION_OPTIONS, exportDimensions } from '../lib/exportFilters';
import type { ExportQuality } from '../lib/exportFilters';
import { formatTime } from '../lib/timeline';
import type { AspectRatio, ExportResolution } from '../types';

const ASPECTS: AspectRatio[] = ['9:16', '1:1', '16:9'];
const HEAVY_RESOLUTIONS: ExportResolution[] = ['1440p', '2160p'];

const formatEta = (seconds: number): string => {
  const s = Math.max(1, Math.round(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return mm > 0 ? `~${mm}m ${String(ss).padStart(2, '0')}s left` : `~${ss}s left`;
};

const formatSize = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Export settings + progress modal. The content component mounts only while
 * the dialog is open, so its local settings state re-seeds from the project
 * settings on every open via plain useState initializers (no effect needed) —
 * and trying an export aspect never mutates the document. Validation reuses
 * the stage-1 duration guard before any FFmpeg work starts; runExport
 * enforces it again.
 */
export function ExportDialog() {
  const isOpen = useExportStore((s) => s.isOpen);
  if (!isOpen) return null;
  return <ExportDialogContent />;
}

function ExportDialogContent() {
  const status = useExportStore((s) => s.status);
  const phase = useExportStore((s) => s.phase);
  const progress = useExportStore((s) => s.progress);
  const startedAt = useExportStore((s) => s.startedAt);
  const result = useExportStore((s) => s.result);
  const error = useExportStore((s) => s.error);
  const start = useExportStore((s) => s.start);
  const cancel = useExportStore((s) => s.cancel);
  const close = useExportStore((s) => s.close);

  const clips = useEditorStore((s) => s.clips);
  const settings = useEditorStore((s) => s.settings);

  const [resolution, setResolution] = useState<ExportResolution>(settings.exportResolution);
  const [aspect, setAspect] = useState<AspectRatio>(settings.aspectRatio);
  const [quality, setQuality] = useState<ExportQuality>('high');

  // Wall-clock sampled once a second while running, so the ETA stays fresh
  // between progress events without calling Date.now() during render.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (status !== 'running') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  const running = status === 'running';
  const total = computeTotalDuration(clips);
  const overLimit = total > MAX_TIMELINE_DURATION + 1e-6;
  const empty = clips.length === 0;
  const { width, height } = exportDimensions(aspect, resolution);
  const heavy = HEAVY_RESOLUTIONS.includes(resolution);

  const elapsed = now !== null && startedAt !== null ? (now - startedAt) / 1000 : 0;
  const eta =
    running && progress > 0.03 && elapsed > 0 ? (elapsed * (1 - progress)) / progress : null;

  return (
    <div className="modal-backdrop" onClick={() => !running && close()}>
      <div
        className="modal"
        role="dialog"
        aria-label="Export video"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <strong>Export video</strong>
          <button
            type="button"
            className="texted__close"
            onClick={close}
            disabled={running}
            title={running ? 'Cancel the export first' : 'Close'}
          >
            ✕
          </button>
        </header>

        <div className="modal__body">
          <div className="modal__summary">
            Duration: <strong>{formatTime(total)}</strong> / {formatTime(MAX_TIMELINE_DURATION)}
            {' · '}
            {width}×{height}
          </div>

          {/* settings */}
          <div className="texted__field">
            <span>Resolution</span>
            <div className="texted__presets texted__presets--three">
              {RESOLUTION_OPTIONS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={'texted__preset' + (resolution === r.id ? ' is-active' : '')}
                  onClick={() => setResolution(r.id)}
                  disabled={running}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div className="texted__field">
            <span>Aspect ratio</span>
            <div className="texted__presets texted__presets--three">
              {ASPECTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={'texted__preset' + (aspect === a ? ' is-active' : '')}
                  onClick={() => setAspect(a)}
                  disabled={running}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          <div className="texted__field">
            <span>Quality</span>
            <div className="texted__presets">
              {(Object.keys(QUALITY_SETTINGS) as ExportQuality[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={'texted__preset' + (quality === k ? ' is-active' : '')}
                  onClick={() => setQuality(k)}
                  disabled={running}
                >
                  {QUALITY_SETTINGS[k].label}
                </button>
              ))}
            </div>
          </div>

          {heavy && (
            <p className="modal__note modal__note--warn">
              {resolution === '2160p' ? '4K' : '1440p'} export runs in the browser and can be
              very slow and memory-hungry. If it fails, try 1080p.
            </p>
          )}
          {empty && <p className="modal__note modal__note--error">Import a video first.</p>}
          {overLimit && (
            <p className="modal__note modal__note--error">
              The video is {total.toFixed(1)}s — over the {MAX_TIMELINE_DURATION}s limit. Trim
              the timeline before exporting.
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
                  {Math.round(progress * 100)}%{eta !== null ? ` · ${formatEta(eta)}` : ''}
                </span>
              </div>
            </div>
          )}

          {/* result */}
          {status === 'done' && result && (
            <div className="modal__result">
              <p className="modal__note">
                Done — {result.filename} ({formatSize(result.sizeBytes)})
              </p>
              <a className="modal__download" href={result.url} download={result.filename}>
                ⬇ Download MP4
              </a>
            </div>
          )}

          {/* actions */}
          <div className="modal__actions">
            {running ? (
              <button type="button" className="modal__btn modal__btn--danger" onClick={cancel}>
                Cancel export
              </button>
            ) : (
              <button
                type="button"
                className="modal__btn modal__btn--primary"
                onClick={() => start({ resolution, aspect, quality })}
                disabled={empty || overLimit}
              >
                {status === 'done' ? 'Export again' : 'Export MP4'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
