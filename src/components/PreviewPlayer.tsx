import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useEditorStore } from '../store/editorStore';
import { buildSegments, locate, totalTimelineDuration } from '../lib/playback';
import { computeOverlayRender, overlayTextStyle } from '../lib/overlay';
import { formatTime, formatTimecode } from '../lib/timeline';
import type { AspectRatio, Clip, TextOverlay } from '../types';

const ASPECT_CSS: Record<AspectRatio, string> = {
  '9:16': '9 / 16',
  '1:1': '1 / 1',
  '16:9': '16 / 9',
};
const ASPECTS: AspectRatio[] = ['9:16', '1:1', '16:9'];

// How early (seconds before a clip ends) to preload the next clip into the
// idle video element so the boundary swap is near-seamless.
const PRELOAD_LEAD = 0.6;
// Tolerance distinguishing a playback-authored playhead value from a user seek.
const EPS = 1e-4;

const clampPct = (v: number) => Math.min(100, Math.max(0, v));

/**
 * Real-time preview player synced to the timeline.
 *
 * Uses two <video> elements (double buffer): one is active/visible/playing
 * while the other preloads + seeks the next clip, so transitions are smooth.
 * The single seam for "show clip at source time T" is showGlobal(); swap to a
 * single element would only touch that + the boundary branch in tick().
 *
 * Position is the store's playheadTime (single source of truth). The rAF loop
 * writes it during playback and records each written value in lastWriteRef; the
 * seek effect re-seeks the video only when playheadTime differs from that last
 * value (i.e. a *user* seek), which avoids any playback<->seek feedback loop.
 */
export function PreviewPlayer() {
  const clips = useEditorStore((s) => s.clips);
  const playheadTime = useEditorStore((s) => s.playheadTime);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const aspectRatio = useEditorStore((s) => s.settings.aspectRatio);
  const textOverlays = useEditorStore((s) => s.textOverlays);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const setSelected = useEditorStore((s) => s.setSelected);
  const updateTextOverlay = useEditorStore((s) => s.updateTextOverlay);
  const checkpoint = useEditorStore((s) => s.checkpoint);
  const updateSettings = useEditorStore((s) => s.updateSettings);

  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const [activeIndex, setActiveIndex] = useState(0);
  const activeRef = useRef(0); // mirrors activeIndex for use inside rAF/async
  const rafRef = useRef<number | null>(null);
  const lastWriteRef = useRef(-1); // last playhead value authored by playback
  const preloadedForRef = useRef<string | null>(null); // clip id we've prepped the buddy for
  const isPlayingRef = useRef(isPlaying);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const total = useMemo(() => totalTimelineDuration(clips), [clips]);

  const elAt = (i: number) => (i === 0 ? videoA.current : videoB.current);

  // Keep a ref copy of isPlaying for async callbacks / the seek effect.
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // --- low-level media helpers (read fresh store state internally) ---------

  const ensureLoaded = (el: HTMLVideoElement, clip: Clip) =>
    new Promise<void>((resolve) => {
      if (el.dataset.clipId === clip.id) {
        resolve();
        return;
      }
      el.dataset.clipId = clip.id;
      el.src = clip.src;
      const onMeta = () => {
        el.removeEventListener('loadedmetadata', onMeta);
        resolve();
      };
      el.addEventListener('loadedmetadata', onMeta);
      el.load();
    });

  const seekEl = (el: HTMLVideoElement, time: number) =>
    new Promise<void>((resolve) => {
      if (Math.abs(el.currentTime - time) < 0.005) {
        resolve();
        return;
      }
      const onSeeked = () => {
        el.removeEventListener('seeked', onSeeked);
        resolve();
      };
      el.addEventListener('seeked', onSeeked);
      try {
        el.currentTime = time;
      } catch {
        resolve();
      }
    });

  const prepare = async (el: HTMLVideoElement, clip: Clip, sourceTime: number, muted: boolean) => {
    el.muted = muted;
    await ensureLoaded(el, clip);
    await seekEl(el, sourceTime);
  };

  /** Show a global time on the ACTIVE element; optionally start it playing. */
  const showGlobal = async (global: number, autoplay: boolean) => {
    const loc = locate(useEditorStore.getState().clips, global);
    const el = elAt(activeRef.current);
    if (!loc || !el) return;
    preloadedForRef.current = null;
    await prepare(el, loc.clip, loc.localTime, loc.clip.audioMuted);
    if (autoplay && useEditorStore.getState().isPlaying) {
      el.play().catch(() => {});
    }
  };

  // --- the playback loop ---------------------------------------------------

  const tick = () => {
    const state = useEditorStore.getState();
    if (!state.isPlaying) return;

    const segments = buildSegments(state.clips);
    if (segments.length === 0) {
      setPlaying(false);
      return;
    }
    const timelineTotal = segments[segments.length - 1].end;
    const el = elAt(activeRef.current);
    if (!el) {
      setPlaying(false);
      return;
    }

    const segIndex = segments.findIndex((s) => s.clip.id === el.dataset.clipId);
    if (segIndex < 0) {
      setPlaying(false);
      return;
    }
    const seg = segments[segIndex];
    const t = el.currentTime;
    const hasNext = segIndex < segments.length - 1;

    // Preload the next clip into the idle element shortly before the boundary.
    if (
      hasNext &&
      t >= seg.clip.outPoint - PRELOAD_LEAD &&
      preloadedForRef.current !== seg.clip.id
    ) {
      preloadedForRef.current = seg.clip.id;
      const buddy = elAt(1 - activeRef.current);
      const next = segments[segIndex + 1].clip;
      if (buddy) prepare(buddy, next, next.inPoint, true); // idle stays muted
    }

    if (t >= seg.clip.outPoint - EPS) {
      if (hasNext) {
        // Swap to the (preloaded) idle element and continue from the next clip.
        const nextIdx = 1 - activeRef.current;
        const buddy = elAt(nextIdx);
        const next = segments[segIndex + 1].clip;
        const global = segments[segIndex + 1].start;

        activeRef.current = nextIdx;
        setActiveIndex(nextIdx);
        preloadedForRef.current = null;
        lastWriteRef.current = global;
        setPlayhead(global);
        el.pause();

        if (buddy) {
          prepare(buddy, next, next.inPoint, next.audioMuted).then(() => {
            if (useEditorStore.getState().isPlaying) buddy.play().catch(() => {});
          });
        }
      } else {
        // End of timeline: stop and clamp.
        el.pause();
        lastWriteRef.current = timelineTotal;
        setPlayhead(timelineTotal);
        setPlaying(false);
        return;
      }
    } else {
      const global = seg.start + (t - seg.clip.inPoint);
      lastWriteRef.current = global;
      setPlayhead(global);
    }

    rafRef.current = requestAnimationFrame(tick);
  };

  // --- start/stop the loop when isPlaying flips ----------------------------

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      videoA.current?.pause();
      videoB.current?.pause();
      return;
    }

    let cancelled = false;
    (async () => {
      const state = useEditorStore.getState();
      const timelineTotal = totalTimelineDuration(state.clips);
      if (timelineTotal <= 0) {
        setPlaying(false);
        return;
      }
      // Restart from the beginning if we're parked at the end.
      let start = state.playheadTime;
      if (start >= timelineTotal - 0.01) {
        start = 0;
        lastWriteRef.current = 0;
        setPlayhead(0);
      }
      await showGlobal(start, true);
      if (cancelled) return;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // --- user seeks: seek the video only when the playhead value did NOT come
  //     from playback (source detection, not magnitude). -------------------
  useEffect(() => {
    if (Math.abs(playheadTime - lastWriteRef.current) < EPS) return;
    lastWriteRef.current = playheadTime;
    showGlobal(playheadTime, isPlayingRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadTime]);

  // --- refresh the still frame when clips change while paused (trim/reorder).
  useEffect(() => {
    if (isPlayingRef.current) return;
    showGlobal(useEditorStore.getState().playheadTime, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  // --- spacebar play/pause -------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      setPlaying(!useEditorStore.getState().isPlaying);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPlaying]);

  // --- fullscreen ----------------------------------------------------------
  useEffect(() => {
    const onFs = () => setIsFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => {});
    }
  };

  // --- transport handlers --------------------------------------------------
  const togglePlay = () => setPlaying(!isPlaying);
  const stop = () => {
    setPlaying(false);
    setPlayhead(0);
  };
  const blurThen = (fn: () => void) => (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur(); // return focus to body so Space toggles play, not the button
    fn();
  };

  // --- drag an overlay within the frame; store x/y as % so it's aspect- and
  //     export-correct. One history checkpoint per drag (then live updates). ---
  const beginOverlayDrag = (e: ReactPointerEvent, overlay: TextOverlay) => {
    e.stopPropagation();
    e.preventDefault();
    setSelected(overlay.id);
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = overlay.x;
    const origY = overlay.y;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        checkpoint(); // snapshot once, on first actual movement
        moved = true;
      }
      const nx = clampPct(origX + ((ev.clientX - startX) / rect.width) * 100);
      const ny = clampPct(origY + ((ev.clientY - startY) / rect.height) * 100);
      updateTextOverlay(overlay.id, { x: nx, y: ny }, { history: false });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div ref={wrapRef} className={'player' + (isFullscreen ? ' player--fs' : '')}>
      <div className="player__stage">
        <div
          ref={frameRef}
          className="preview__frame"
          style={{ aspectRatio: ASPECT_CSS[aspectRatio] }}
        >
          <video
            ref={videoA}
            className={'preview__video' + (activeIndex === 0 ? '' : ' preview__video--idle')}
            playsInline
            preload="auto"
          />
          <video
            ref={videoB}
            className={'preview__video' + (activeIndex === 1 ? '' : ' preview__video--idle')}
            playsInline
            preload="auto"
          />

          {/* Overlay layer: container ignores pointer events so it doesn't
              swallow drops/clicks; each overlay re-enables them. */}
          <div className="overlay-layer">
            {textOverlays.map((o) => {
              const r = computeOverlayRender(o, playheadTime);
              const selected = o.id === selectedItemId;
              // Render when visible, or as a faint editor-only ghost when the
              // overlay is selected but the playhead is outside its window.
              if (!r.visible && !selected) return null;
              const ghost = !r.visible;
              return (
                <div
                  key={o.id}
                  className={
                    'overlay-item' +
                    (selected ? ' overlay-item--selected' : '') +
                    (ghost ? ' overlay-item--ghost' : '')
                  }
                  style={{
                    left: `${o.x}%`,
                    top: `${o.y}%`,
                    opacity: ghost ? 0.35 : r.opacity * o.style.opacity,
                    transform: `translate(-50%, -50%) ${ghost ? 'none' : r.transform}`,
                    ...overlayTextStyle(o.style),
                  }}
                  onPointerDown={(e) => beginOverlayDrag(e, o)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(o.id);
                  }}
                >
                  {ghost ? o.text : r.text}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="player__controls">
        <div className="player__transport">
          <button type="button" className="player__btn" onClick={blurThen(stop)} title="Stop">
            ⏹
          </button>
          <button
            type="button"
            className="player__btn player__btn--play"
            onClick={blurThen(togglePlay)}
            title={isPlaying ? 'Pause (space)' : 'Play (space)'}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <span className="player__time">
            {formatTimecode(playheadTime)} <span className="player__time-dim">/ {formatTime(total)}</span>
          </span>
        </div>

        <div className="player__right">
          <div className="player__aspects" role="group" aria-label="Aspect ratio">
            {ASPECTS.map((a) => (
              <button
                key={a}
                type="button"
                className={'player__aspect' + (a === aspectRatio ? ' player__aspect--active' : '')}
                onClick={blurThen(() => updateSettings({ aspectRatio: a }))}
              >
                {a}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="player__btn"
            onClick={blurThen(toggleFullscreen)}
            title="Fullscreen"
          >
            {isFullscreen ? '🗗' : '⛶'}
          </button>
        </div>
      </div>
    </div>
  );
}
