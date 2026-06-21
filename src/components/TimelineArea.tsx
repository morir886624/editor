import {
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useEditorStore } from '../store/editorStore';
import { useFFmpegStore } from '../store/ffmpegStore';
import { useNoticeStore } from '../store/noticeStore';
import { useThumbnails } from '../lib/useThumbnails';
import { TextTrack } from './TextTrack';
import {
  MAX_TIMELINE_DURATION,
  clipDuration,
  computeTotalDuration,
  sequenceClips,
} from '../lib/duration';
import {
  PIXELS_PER_SECOND,
  RULER_TICK_SECONDS,
  TIMELINE_WIDTH,
  formatTime,
  pxToSeconds,
  secondsToPx,
} from '../lib/timeline';
import type { Clip } from '../types';

const MIN_CLIP_DURATION = 0.1; // smallest trimmed length we allow (seconds)

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// --- thumbnail strip -------------------------------------------------------

/** Renders the cached frames that fall inside the clip's [inPoint, outPoint]. */
function ThumbStrip({
  clip,
  inPoint,
  outPoint,
}: {
  clip: Clip;
  inPoint: number;
  outPoint: number;
}) {
  const { thumbnails, loading } = useThumbnails(clip);

  let frames = thumbnails.filter((t) => t.t >= inPoint - 0.01 && t.t <= outPoint + 0.01);
  if (frames.length === 0 && thumbnails.length > 0) {
    // Trim window narrower than the frame spacing — show the closest frame.
    const mid = (inPoint + outPoint) / 2;
    frames = [
      thumbnails.reduce((a, b) => (Math.abs(b.t - mid) < Math.abs(a.t - mid) ? b : a)),
    ];
  }

  if (loading && thumbnails.length === 0) {
    return <div className="thumbs thumbs--loading" aria-hidden="true" />;
  }
  return (
    <div className="thumbs" aria-hidden="true">
      {frames.map((t) => (
        <img key={t.url} src={t.url} alt="" draggable={false} />
      ))}
    </div>
  );
}

// --- timeline --------------------------------------------------------------

interface DragInfo {
  id: string;
  edge: 'left' | 'right';
  startX: number;
  origIn: number;
  origOut: number;
  maxTrimmed: number; // most this clip may occupy without breaking the 60s cap
  sourceDuration: number;
}

interface DraftTrim {
  id: string;
  inPoint: number;
  outPoint: number;
}

export function TimelineArea() {
  const clips = useEditorStore((s) => s.clips);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const playheadTime = useEditorStore((s) => s.playheadTime);
  const setSelected = useEditorStore((s) => s.setSelected);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const updateClipTrim = useEditorStore((s) => s.updateClipTrim);

  const ffmpegStatus = useFFmpegStore((s) => s.status);
  const notify = useNoticeStore((s) => s.push);

  // While trimming, an uncommitted draft overrides the dragged clip so the
  // timeline (and the clips after it) reflow live without spamming history.
  const [draft, setDraft] = useState<DraftTrim | null>(null);
  const dragRef = useRef<DragInfo | null>(null);
  const latestRef = useRef<{ inPoint: number; outPoint: number } | null>(null);

  // Apply the draft, then re-sequence so positions stay gapless.
  const displayClips = useMemo(() => {
    const base = draft
      ? clips.map((c) =>
          c.id === draft.id ? { ...c, inPoint: draft.inPoint, outPoint: draft.outPoint } : c,
        )
      : clips;
    return sequenceClips(base);
  }, [clips, draft]);

  const total = computeTotalDuration(displayClips);

  const beginTrim = (e: ReactPointerEvent, clip: Clip, edge: 'left' | 'right') => {
    e.stopPropagation();
    e.preventDefault();
    setSelected(clip.id);

    const totalOthers = computeTotalDuration(clips) - clipDuration(clip);
    dragRef.current = {
      id: clip.id,
      edge,
      startX: e.clientX,
      origIn: clip.inPoint,
      origOut: clip.outPoint,
      maxTrimmed: MAX_TIMELINE_DURATION - totalOthers,
      sourceDuration: clip.sourceDuration,
    };
    latestRef.current = { inPoint: clip.inPoint, outPoint: clip.outPoint };
    setDraft({ id: clip.id, inPoint: clip.inPoint, outPoint: clip.outPoint });

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const deltaSec = (ev.clientX - d.startX) / PIXELS_PER_SECOND;
      let inP = d.origIn;
      let outP = d.origOut;

      if (d.edge === 'left') {
        inP = clamp(d.origIn + deltaSec, 0, d.origOut - MIN_CLIP_DURATION);
        // keep trimmed length within the remaining 60s budget
        inP = Math.max(inP, d.origOut - d.maxTrimmed);
      } else {
        outP = clamp(d.origOut + deltaSec, d.origIn + MIN_CLIP_DURATION, d.sourceDuration);
        outP = Math.min(outP, d.origIn + d.maxTrimmed);
      }

      latestRef.current = { inPoint: inP, outPoint: outP };
      setDraft({ id: d.id, inPoint: inP, outPoint: outP });
    };

    const onUp = () => {
      const d = dragRef.current;
      const latest = latestRef.current;
      dragRef.current = null;
      latestRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDraft(null);
      if (d && latest) {
        const res = updateClipTrim(d.id, latest.inPoint, latest.outPoint);
        if (!res.ok) notify({ type: 'error', message: res.reason });
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Scrub: press/drag anywhere on the ruler or empty track to move the
  // playhead (and seek the preview). Pressing a clip selects it instead
  // (clips stop propagation), so this only fires off-clip. Pauses playback so
  // scrubbing doesn't fight the rAF loop.
  const beginScrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const totalDur = computeTotalDuration(clips);
    const seek = (clientX: number) =>
      setPlayhead(clamp(pxToSeconds(clientX - rect.left), 0, totalDur));

    setPlaying(false);
    seek(e.clientX);

    const onMove = (ev: PointerEvent) => seek(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const counterClass =
    total >= MAX_TIMELINE_DURATION - 0.05
      ? ' timeline__counter--full'
      : total >= 50
        ? ' timeline__counter--warn'
        : '';

  // Ruler ticks at 0, 5, 10 … 60s
  const ticks: number[] = [];
  for (let t = 0; t <= MAX_TIMELINE_DURATION; t += RULER_TICK_SECONDS) ticks.push(t);

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline__bar">
        <span className={'timeline__counter' + counterClass}>
          {formatTime(total)} / {formatTime(MAX_TIMELINE_DURATION)}
        </span>
        {ffmpegStatus === 'loading' && (
          <span className="timeline__engine">Loading video engine…</span>
        )}
        {ffmpegStatus === 'error' && (
          <span className="timeline__engine timeline__engine--error">
            Video engine failed to load
          </span>
        )}
      </div>

      <div className="timeline__scroll">
        <div
          className="timeline__inner"
          style={{ width: TIMELINE_WIDTH }}
          onPointerDown={beginScrub}
        >
          <div className="timeline__ruler">
            {ticks.map((t) => (
              <div className="timeline__tick" key={t} style={{ left: secondsToPx(t) }}>
                <span className="timeline__tick-label">{formatTime(t)}</span>
              </div>
            ))}
          </div>

          <div className="timeline__tracks">
            <TextTrack total={total} />

            <div className="timeline__track">
              {displayClips.length === 0 && (
                <div className="timeline__empty">Import a video to start</div>
              )}

              {displayClips.map((clip) => {
              const selected = clip.id === selectedItemId;
              return (
                <div
                  key={clip.id}
                  className={'tl-clip' + (selected ? ' tl-clip--selected' : '')}
                  style={{
                    left: secondsToPx(clip.position),
                    width: secondsToPx(clipDuration(clip)),
                  }}
                  title={`${clip.sourceFileName} · ${formatTime(clipDuration(clip))}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(clip.id);
                  }}
                >
                  <ThumbStrip clip={clip} inPoint={clip.inPoint} outPoint={clip.outPoint} />
                  <span className="tl-clip__label">{clip.sourceFileName}</span>

                  {selected && (
                    <>
                      <span
                        className="tl-clip__handle tl-clip__handle--left"
                        onPointerDown={(e) => beginTrim(e, clip, 'left')}
                      />
                      <span
                        className="tl-clip__handle tl-clip__handle--right"
                        onPointerDown={(e) => beginTrim(e, clip, 'right')}
                      />
                    </>
                  )}
                </div>
              );
              })}
            </div>

            <div
              className="timeline__playhead"
              style={{ left: secondsToPx(Math.min(playheadTime, MAX_TIMELINE_DURATION)) }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
