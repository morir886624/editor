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
import { AudioLane } from './AudioLane';
import {
  MAX_TIMELINE_DURATION,
  clipDuration,
  computeTotalDuration,
  effectiveTransitionDurations,
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
  /** Longest SOURCE window this clip may keep without breaking the 60s cap
   *  (timeline budget × speed, since timeline time = source time ÷ speed). */
  maxSourceLen: number;
  sourceDuration: number;
  speed: number;
}

interface DraftTrim {
  id: string;
  inPoint: number;
  outPoint: number;
}

export function TimelineArea() {
  const clips = useEditorStore((s) => s.clips);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const selectedTransitionId = useEditorStore((s) => s.selectedTransitionId);
  const playheadTime = useEditorStore((s) => s.playheadTime);
  const setSelected = useEditorStore((s) => s.setSelected);
  const setSelectedTransition = useEditorStore((s) => s.setSelectedTransition);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const updateClipTrim = useEditorStore((s) => s.updateClipTrim);
  const updateClip = useEditorStore((s) => s.updateClip);

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
  // Effective transition at each seam (0 = hard cut) — the seam buttons sit
  // centered on the overlap window between neighboring clip blocks.
  const seamDurations = effectiveTransitionDurations(displayClips);

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
      maxSourceLen: (MAX_TIMELINE_DURATION - totalOthers) * clip.speed,
      sourceDuration: clip.sourceDuration,
      speed: clip.speed,
    };
    latestRef.current = { inPoint: clip.inPoint, outPoint: clip.outPoint };
    setDraft({ id: clip.id, inPoint: clip.inPoint, outPoint: clip.outPoint });

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // Cursor moves in timeline pixels; trim points live in SOURCE seconds,
      // which advance `speed`× as fast, so the edge tracks the cursor.
      const deltaSrc = ((ev.clientX - d.startX) / PIXELS_PER_SECOND) * d.speed;
      const minSrc = MIN_CLIP_DURATION * d.speed;
      let inP = d.origIn;
      let outP = d.origOut;

      if (d.edge === 'left') {
        inP = clamp(d.origIn + deltaSrc, 0, d.origOut - minSrc);
        // keep the source window within the remaining 60s budget
        inP = Math.max(inP, d.origOut - d.maxSourceLen);
      } else {
        outP = clamp(d.origOut + deltaSrc, d.origIn + minSrc, d.sourceDuration);
        outP = Math.min(outP, d.origIn + d.maxSourceLen);
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
    // On touch, only the ruler scrubs (it has touch-action: none); a finger on
    // the tracks pans the timeline's horizontal scroll instead — otherwise
    // every scroll attempt would also jump the playhead.
    if (e.pointerType === 'touch' && !(e.target as HTMLElement).closest('.timeline__ruler')) {
      return;
    }
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

  // Slip edit: slide the selected clip's [inPoint, outPoint] window over its
  // source WITHOUT changing its length — the rescue tool when an auto-cut
  // short starts/ends mid-sentence and the source holds margin around the cut.
  const selectedClip = clips.find((c) => c.id === selectedItemId);
  const canSlipLeft = !!selectedClip && selectedClip.inPoint > 0.001;
  const canSlipRight =
    !!selectedClip && selectedClip.outPoint < selectedClip.sourceDuration - 0.001;
  const slipClip = (dir: 1 | -1) => {
    const c = selectedClip;
    if (!c) return;
    // One source-second per click, clamped to the media's edges. Length is
    // unchanged, so the 60s guard can never reject this.
    const shift = clamp(dir, -c.inPoint, c.sourceDuration - c.outPoint);
    if (Math.abs(shift) < 1e-6) return;
    const res = updateClipTrim(c.id, c.inPoint + shift, c.outPoint + shift);
    if (!res.ok) notify({ type: 'error', message: res.reason });
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

        {selectedClip && (
          <span
            className="timeline__slip"
            title="Slide the cut window over the source video — same length, earlier or later content. Rescues a cut that lands mid-sentence."
          >
            <button
              type="button"
              className="timeline__slipbtn"
              onClick={() => slipClip(-1)}
              disabled={!canSlipLeft}
              title="Slide the cut 1s earlier in the source"
            >
              ‹
            </button>
            <span className="timeline__sliplabel">Slide cut</span>
            <button
              type="button"
              className="timeline__slipbtn"
              onClick={() => slipClip(1)}
              disabled={!canSlipRight}
              title="Slide the cut 1s later in the source"
            >
              ›
            </button>
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
                  {clip.speed !== 1 && (
                    <span className="tl-clip__speed">{clip.speed}x</span>
                  )}

                  <button
                    type="button"
                    className={'tl-clip__mute' + (clip.audioMuted ? ' tl-clip__mute--on' : '')}
                    title={clip.audioMuted ? 'Unmute clip audio' : 'Mute clip audio'}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateClip(clip.id, { audioMuted: !clip.audioMuted });
                    }}
                  >
                    {clip.audioMuted ? '🔇' : '🔊'}
                  </button>

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

              {/* transition seam buttons between adjacent clips */}
              {displayClips.slice(0, -1).map((clip, i) => {
                const hasTransition = seamDurations[i] > 0;
                const seamX = secondsToPx(
                  displayClips[i + 1].position + seamDurations[i] / 2,
                );
                return (
                  <button
                    key={`seam_${clip.id}`}
                    type="button"
                    className={
                      'tl-seam' +
                      (hasTransition ? ' tl-seam--set' : '') +
                      (clip.id === selectedTransitionId ? ' tl-seam--active' : '')
                    }
                    style={{ left: seamX }}
                    title={hasTransition ? 'Edit transition' : 'Add transition'}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedTransition(clip.id);
                    }}
                  >
                    {hasTransition ? '◆' : '◇'}
                  </button>
                );
              })}
            </div>

            <AudioLane />

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
