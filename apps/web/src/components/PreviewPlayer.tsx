import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  buildSegments,
  globalToSource,
  locate,
  locateTransition,
  sourceToGlobal,
  totalTimelineDuration,
} from '../lib/playback';
import { effectiveTransitionDurations } from '../lib/duration';
import {
  IDENTITY_LAYER,
  computeTransitionFrame,
  type TransitionLayerStyle,
} from '../lib/transitions';
import { computeOverlayRender, overlayTextStyle } from '../lib/overlay';
import { buildClipFilter } from '../lib/effects';
import {
  IDENTITY_EFFECTS_FRAME,
  computeEffectsFrame,
  grainTextureUrl,
} from '../lib/videoEffects';
import { useAudioMixer } from '../lib/useAudioMixer';
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
 * while the other preloads + seeks the next clip, swapping at the boundary.
 * The single seam for "show clip at source time T" is showGlobal().
 *
 * Clip transitions reuse the same two elements: inside a transition's overlap
 * window BOTH clips play/render, and applyBlend() styles them from
 * computeTransitionFrame(locateTransition(...)) — pure functions of the
 * playhead, so a blend looks the same playing, scrubbing, or at export.
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

  // Mix imported audio tracks alongside the video, synced to playheadTime.
  useAudioMixer();

  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  // Overlay layers for the stage-8 effects (vignette / grain / flash),
  // written imperatively per frame by applyBlend.
  const fxVignetteRef = useRef<HTMLDivElement>(null);
  const fxGrainRef = useRef<HTMLDivElement>(null);
  const fxFlashRef = useRef<HTMLDivElement>(null);

  const [activeIndex, setActiveIndex] = useState(0);
  const activeRef = useRef(0); // mirrors activeIndex for use inside rAF/async
  const rafRef = useRef<number | null>(null);
  const lastWriteRef = useRef(-1); // last playhead value authored by playback
  const preloadedForRef = useRef<string | null>(null); // clip id we've prepped the buddy for
  const isPlayingRef = useRef(isPlaying);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const total = useMemo(() => totalTimelineDuration(clips), [clips]);

  const elAt = (i: number) => (i === 0 ? videoA.current : videoB.current);

  // Each element carries the CSS filter of the clip IT displays (set in
  // prepare(); during a transition blend the two clips can differ). This
  // effect re-derives both when effect params change mid-display.
  useEffect(() => {
    for (const el of [videoA.current, videoB.current]) {
      if (!el?.dataset.clipId) continue;
      const clip = clips.find((c) => c.id === el.dataset.clipId);
      if (clip) el.style.filter = buildClipFilter(clip);
    }
  }, [clips]);

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
    el.playbackRate = clip.speed;
    el.style.filter = buildClipFilter(clip);
    await ensureLoaded(el, clip);
    await seekEl(el, sourceTime);
  };

  // --- transition blend ------------------------------------------------------
  // Applied imperatively to both elements, derived PURELY from the playhead
  // (locateTransition), so a blend looks identical while playing or scrubbing.
  // Inline styles are authoritative: outside a transition the idle element is
  // re-hidden here (overriding the --idle class either way).

  const setLayer = (
    el: HTMLVideoElement,
    layer: TransitionLayerStyle,
    z: number,
    fxTransform = '',
  ) => {
    el.style.opacity = String(layer.opacity);
    const base = layer.transform === 'none' ? '' : layer.transform;
    el.style.transform = [base, fxTransform].filter(Boolean).join(' ') || 'none';
    el.style.zIndex = String(z);
  };

  const applyBlend = () => {
    const state = useEditorStore.getState();
    const els = [videoA.current, videoB.current];
    const tl = locateTransition(state.clips, state.playheadTime);
    const fromEl = tl ? els.find((el) => el?.dataset.clipId === tl.from.clip.id) : undefined;
    const toEl = tl ? els.find((el) => el?.dataset.clipId === tl.to.clip.id) : undefined;

    // Stage-8 effect transform for the clip an element displays, at that
    // clip's LOCAL time — each element carries its own clip's effects, like
    // it carries its own CSS filter.
    const fxTransformOf = (el: HTMLVideoElement | null): string => {
      if (!el?.dataset.clipId) return '';
      const clip = state.clips.find((c) => c.id === el.dataset.clipId);
      if (!clip || clip.effects.length === 0) return '';
      return computeEffectsFrame(clip, state.playheadTime - clip.position).transform;
    };

    if (tl && fromEl && toEl && fromEl !== toEl) {
      const frame = computeTransitionFrame(tl.type, tl.progress);
      setLayer(fromEl, frame.from, 1, fxTransformOf(fromEl));
      setLayer(toEl, frame.to, 2, fxTransformOf(toEl));
      // Linear crossfade of the clips' own audio — same triangular curves
      // acrossfade uses at export.
      fromEl.volume = Math.min(1, Math.max(0, 1 - tl.progress));
      toEl.volume = Math.min(1, Math.max(0, tl.progress));
    } else {
      const active = elAt(activeRef.current);
      const idle = elAt(1 - activeRef.current);
      if (active) {
        setLayer(active, IDENTITY_LAYER, 1, fxTransformOf(active));
        active.volume = 1;
      }
      if (idle) {
        setLayer(idle, { opacity: 0, transform: 'none' }, 0);
        idle.volume = 1;
      }
    }

    // Overlay-type effects (vignette/grain/flash) follow the clip under the
    // playhead — inside a transition overlap that's the OUTGOING clip, a
    // preview-grade simplification.
    const loc = locate(state.clips, state.playheadTime);
    const frame = loc
      ? computeEffectsFrame(loc.clip, state.playheadTime - loc.clip.position)
      : IDENTITY_EFFECTS_FRAME;
    if (fxVignetteRef.current) fxVignetteRef.current.style.opacity = String(frame.vignette);
    if (fxFlashRef.current) fxFlashRef.current.style.opacity = String(frame.flash);
    const grainEl = fxGrainRef.current;
    if (grainEl) {
      if (frame.grain) {
        if (!grainEl.style.backgroundImage) {
          grainEl.style.backgroundImage = `url(${grainTextureUrl()})`;
        }
        grainEl.style.opacity = String(frame.grain.opacity);
        grainEl.style.backgroundPosition = `${frame.grain.x}px ${frame.grain.y}px`;
      } else {
        grainEl.style.opacity = '0';
      }
    }
  };

  // Re-blend whenever the playhead or document moves (covers playback — the
  // rAF loop writes the playhead every frame — seeks, and undo/redo).
  useEffect(() => {
    applyBlend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadTime, clips, activeIndex]);

  /** Show a global time on the ACTIVE element; optionally start it playing.
   *  Inside a transition overlap, the incoming clip is prepared on the buddy
   *  element too, so scrubbing shows the real blended frame. */
  const showGlobal = async (global: number, autoplay: boolean) => {
    const stateClips = useEditorStore.getState().clips;
    const loc = locate(stateClips, global);
    const el = elAt(activeRef.current);
    if (!loc || !el) return;
    preloadedForRef.current = null;
    await prepare(el, loc.clip, loc.localTime, loc.clip.audioMuted);
    if (autoplay && useEditorStore.getState().isPlaying) {
      el.play().catch(() => {});
    }
    const tl = locateTransition(stateClips, global);
    const buddy = elAt(1 - activeRef.current);
    if (tl && buddy && tl.from.clip.id === loc.clip.id) {
      await prepare(buddy, tl.to.clip, globalToSource(tl.to, global), tl.to.clip.audioMuted);
      if (autoplay && useEditorStore.getState().isPlaying) buddy.play().catch(() => {});
    }
    applyBlend();
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
    // Effective transition into the NEXT clip (0 = hard cut). During the
    // overlap window the buddy element plays the incoming clip alongside us.
    const trans = effectiveTransitionDurations(state.clips)[segIndex] ?? 0;
    const nextSeg = hasNext ? segments[segIndex + 1] : null;
    // Source seconds -> timeline seconds (timeline advances 1/speed as fast).
    const global = seg.start + (t - seg.clip.inPoint) / seg.clip.speed;

    // Keep speed/mute live — the effects panel can change them mid-playback.
    if (el.playbackRate !== seg.clip.speed) el.playbackRate = seg.clip.speed;
    if (el.muted !== seg.clip.audioMuted) el.muted = seg.clip.audioMuted;

    // Preload the next clip into the idle element before the boundary — or
    // before the transition overlap begins, where it must already be playable
    // (the lead is wall-clock, so scale it into source seconds by the speed).
    if (
      hasNext &&
      t >= seg.clip.outPoint - (PRELOAD_LEAD + trans) * seg.clip.speed &&
      preloadedForRef.current !== seg.clip.id
    ) {
      preloadedForRef.current = seg.clip.id;
      const buddy = elAt(1 - activeRef.current);
      const next = nextSeg!.clip;
      // Don't yank the buddy back to inPoint if it's already mid-transition.
      if (buddy && !(buddy.dataset.clipId === next.id && !buddy.paused)) {
        prepare(buddy, next, next.inPoint, true); // idle stays muted
      }
    }

    // Transition overlap reached: start the incoming clip on the buddy so both
    // play together while applyBlend (driven by the playhead) mixes them.
    if (hasNext && trans > 0 && nextSeg && t >= seg.clip.outPoint - trans * seg.clip.speed) {
      const buddy = elAt(1 - activeRef.current);
      const next = nextSeg.clip;
      if (buddy && buddy.dataset.clipId === next.id && buddy.paused && buddy.readyState >= 2) {
        const bSrc = globalToSource(nextSeg, global);
        if (Math.abs(buddy.currentTime - bSrc) > 0.08) buddy.currentTime = bSrc;
        buddy.muted = next.audioMuted;
        buddy.play().catch(() => {});
      }
    }

    if (t >= seg.clip.outPoint - EPS) {
      if (hasNext && nextSeg) {
        // Swap roles: the buddy element becomes the active one.
        const nextIdx = 1 - activeRef.current;
        const buddy = elAt(nextIdx);
        const next = nextSeg.clip;

        activeRef.current = nextIdx;
        setActiveIndex(nextIdx);
        preloadedForRef.current = null;
        el.pause();

        if (buddy && buddy.dataset.clipId === next.id && !buddy.paused) {
          // Already playing (transition overlap) — adopt it where it is.
          buddy.muted = next.audioMuted;
          const g = sourceToGlobal(nextSeg, buddy.currentTime);
          lastWriteRef.current = g;
          setPlayhead(g);
        } else {
          const g = nextSeg.start;
          lastWriteRef.current = g;
          setPlayhead(g);
          if (buddy) {
            prepare(buddy, next, next.inPoint, next.audioMuted).then(() => {
              if (useEditorStore.getState().isPlaying) buddy.play().catch(() => {});
            });
          }
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

          {/* Stage-8 effect layers, above the videos and below the text.
              Opacity/position are driven per frame by applyBlend. */}
          <div ref={fxVignetteRef} className="fx-layer fx-layer--vignette" aria-hidden="true" />
          <div ref={fxGrainRef} className="fx-layer fx-layer--grain" aria-hidden="true" />
          <div ref={fxFlashRef} className="fx-layer fx-layer--flash" aria-hidden="true" />

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
