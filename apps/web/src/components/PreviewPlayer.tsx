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
import { computeOverlayRender, overlayStaticTransform, overlayTextStyle } from '../lib/overlay';
import { buildClipFilter } from '../lib/effects';
import {
  IDENTITY_EFFECTS_FRAME,
  computeEffectsFrame,
  grainTextureUrl,
} from '../lib/videoEffects';
import { useAudioMixer } from '../lib/useAudioMixer';
import { BLUR_DIM, BLUR_ZOOM, aspectDims, frameBackgroundUrl, frameLayout } from '../lib/frame';
import { FULL_CROP, computeCropLayout } from '../lib/crop';
import { CropOverlay } from './CropOverlay';
import { formatTime, formatTimecode } from '../lib/timeline';
import type { AspectRatio, Clip, ClipCrop, TextOverlay } from '../types';

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
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Corner-handle resize bounds for fontSize (cqh) — matches the panel slider.
const MIN_FONT_SIZE = 2;
const MAX_FONT_SIZE = 32;
// Rotation snaps to the nearest multiple of 45° when within this tolerance.
const ROTATE_SNAP = 5;

// Short side (px) of the blurred-fill backdrop canvas. Deliberately tiny: the
// upscale to the frame plus the CSS blur produce the soft look, and drawing
// stays cheap enough to repaint every playhead change.
const BLUR_BACKING_SHORT = 96;

/**
 * Repaint the blurred-fill backdrop from the video element showing the clip
 * under the playhead: cover-crop the source to the canvas aspect, draw it
 * zoomed by BLUR_ZOOM, and carry the element's own color grade onto the
 * canvas plus the blur + dim the export's boxblur graph applies (preview-grade
 * match — CSS gaussian vs FFmpeg boxblur, like the temperature mapping).
 */
function paintBlurBackdrop(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  crop: ClipCrop | undefined,
) {
  const ctx = canvas.getContext('2d');
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!ctx || !vw || !vh) return;
  const cw = canvas.width;
  const ch = canvas.height;
  const targetAR = cw / ch;
  // Sample inside the clip's crop rect (the export blurs the already-cropped
  // joined video), cover-fitting that region to the canvas aspect.
  const c = crop ?? FULL_CROP;
  const rx = c.x * vw;
  const ry = c.y * vh;
  const rw = c.w * vw;
  const rh = c.h * vh;
  let sw = rw;
  let sh = rh;
  if (rw / rh > targetAR) sw = rh * targetAR;
  else sh = rw / targetAR;
  const dw = cw * BLUR_ZOOM;
  const dh = ch * BLUR_ZOOM;
  ctx.drawImage(
    video,
    rx + (rw - sw) / 2, ry + (rh - sh) / 2, sw, sh,
    (cw - dw) / 2, (ch - dh) / 2, dw, dh,
  );
  const grade = video.style.filter && video.style.filter !== 'none' ? `${video.style.filter} ` : '';
  canvas.style.filter = `${grade}blur(1.6cqmin) brightness(${BLUR_DIM})`;
}

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
  const frame = useEditorStore((s) => s.settings.frame);
  const textOverlays = useEditorStore((s) => s.textOverlays);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const cropEditingClipId = useEditorStore((s) => s.cropEditingClipId);
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
  const viewportRef = useRef<HTMLDivElement>(null);
  // Overlay layers for the stage-8 effects (vignette / grain / flash),
  // written imperatively per frame by applyBlend.
  const fxVignetteRef = useRef<HTMLDivElement>(null);
  const fxGrainRef = useRef<HTMLDivElement>(null);
  const fxFlashRef = useRef<HTMLDivElement>(null);
  // Blurred-fill frame backdrop, repainted per frame by applyBlend.
  const frameBlurRef = useRef<HTMLCanvasElement>(null);

  const [activeIndex, setActiveIndex] = useState(0);
  const activeRef = useRef(0); // mirrors activeIndex for use inside rAF/async
  const rafRef = useRef<number | null>(null);
  const lastWriteRef = useRef(-1); // last playhead value authored by playback
  const preloadedForRef = useRef<string | null>(null); // clip id we've prepped the buddy for
  const isPlayingRef = useRef(isPlaying);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Overlay being edited inline (double-click). While set, that overlay
  // renders as a contenteditable and suppresses drag/animation.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editCancelRef = useRef(false); // Escape pressed — skip the blur commit

  const total = useMemo(() => totalTimelineDuration(clips), [clips]);

  // Decorative frame geometry/art — same frameLayout()/SVG the export uses.
  const frameRect = useMemo(() => frameLayout(frame, aspectRatio), [frame, aspectRatio]);
  const frameBgUrl = useMemo(() => frameBackgroundUrl(frame, aspectRatio), [frame, aspectRatio]);
  const blurDims = useMemo(() => {
    const d = aspectDims(aspectRatio);
    return {
      width: Math.round(BLUR_BACKING_SHORT * d.w),
      height: Math.round(BLUR_BACKING_SHORT * d.h),
    };
  }, [aspectRatio]);

  // Width/height ratio of the video viewport (frame rectangle within the
  // project aspect) — analytic, so crop layout percentages survive resizes.
  const viewportAspect = useMemo(() => {
    const d = aspectDims(aspectRatio);
    return (frameRect.w * d.w) / (frameRect.h * d.h);
  }, [frameRect, aspectRatio]);

  const elAt = (i: number) => (i === 0 ? videoA.current : videoB.current);

  /**
   * Lay the <video> out inside its viewport-sized wrapper so that exactly the
   * clip's crop region shows, contain-fitted — the same geometry the export's
   * crop -> scale/pad produces. While the clip is open in the crop editor the
   * FULL source shows instead (the CropOverlay draws the rect on top of it).
   * Needs metadata (videoWidth): prepare() calls this after ensureLoaded, and
   * the [clips] effect below re-derives it on live crop/aspect/frame edits.
   */
  const applyCropLayout = (el: HTMLVideoElement, clip: Clip) => {
    if (!el.videoWidth || !el.videoHeight) return;
    const state = useEditorStore.getState();
    const crop = state.cropEditingClipId === clip.id ? undefined : clip.crop;
    const fr = frameLayout(state.settings.frame, state.settings.aspectRatio);
    const d = aspectDims(state.settings.aspectRatio);
    const layout = computeCropLayout(
      crop,
      el.videoWidth / el.videoHeight,
      (fr.w * d.w) / (fr.h * d.h),
    );
    el.style.left = `${layout.left * 100}%`;
    el.style.top = `${layout.top * 100}%`;
    el.style.width = `${layout.w * 100}%`;
    el.style.height = `${layout.h * 100}%`;
    el.style.objectFit = 'fill'; // element spans the full source; no letterbox
    el.style.clipPath = layout.clipPath;
  };

  // Each element carries the CSS filter + crop layout of the clip IT displays
  // (set in prepare(); during a transition blend the two clips can differ).
  // This effect re-derives both when effect/crop params change mid-display,
  // and when the viewport geometry (aspect, frame, crop session) changes.
  useEffect(() => {
    for (const el of [videoA.current, videoB.current]) {
      if (!el?.dataset.clipId) continue;
      const clip = clips.find((c) => c.id === el.dataset.clipId);
      if (!clip) continue;
      el.style.filter = buildClipFilter(clip);
      applyCropLayout(el, clip);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips, aspectRatio, frame, cropEditingClipId]);

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
    applyCropLayout(el, clip); // metadata is in — position the crop region
    await seekEl(el, sourceTime);
  };

  // --- transition blend ------------------------------------------------------
  // Applied imperatively to both elements, derived PURELY from the playhead
  // (locateTransition), so a blend looks identical while playing or scrubbing.
  // Inline styles are authoritative: outside a transition the idle element is
  // re-hidden here (overriding the --idle class either way).

  // Opacity/transform/z go on the video's WRAPPER (.preview__layer), which is
  // always viewport-sized — so a transition's translate/scale percentages mean
  // "of the output frame" even when the cropped <video> inside is laid out
  // larger than the viewport. Volume stays on the element itself.
  const setLayer = (
    el: HTMLVideoElement,
    layer: TransitionLayerStyle,
    z: number,
    fxTransform = '',
  ) => {
    const box = el.parentElement;
    if (!box) return;
    box.style.opacity = String(layer.opacity);
    const base = layer.transform === 'none' ? '' : layer.transform;
    box.style.transform = [base, fxTransform].filter(Boolean).join(' ') || 'none';
    box.style.zIndex = String(z);
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

    // Blurred-fill frame: repaint the backdrop from the clip under the
    // playhead (the OUTGOING clip inside a transition overlap — same
    // preview-grade simplification as the fx layers above).
    const backdrop = frameBlurRef.current;
    if (backdrop && state.settings.frame.type === 'blur' && loc) {
      const srcEl = els.find((el) => el?.dataset.clipId === loc.clip.id);
      if (srcEl && srcEl.readyState >= 2) paintBlurBackdrop(backdrop, srcEl, loc.clip.crop);
    }
  };

  // Re-blend whenever the playhead or document moves (covers playback — the
  // rAF loop writes the playhead every frame — seeks, and undo/redo). Frame /
  // aspect changes join in so the blur backdrop repaints after it (re)mounts
  // or its canvas is wiped by a backing-size change.
  useEffect(() => {
    applyBlend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadTime, clips, activeIndex, frame, aspectRatio]);

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
  // Transport step: pause, then nudge the playhead — reads fresh state so a
  // click during playback can't act on a stale rAF-era playhead.
  const stepBy = (delta: number) => {
    const s = useEditorStore.getState();
    s.setPlaying(false);
    s.setPlayhead(clamp(s.playheadTime + delta, 0, totalTimelineDuration(s.clips)));
  };
  const blurThen = (fn: () => void) => (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur(); // return focus to body so Space toggles play, not the button
    fn();
  };

  // --- overlay gestures ------------------------------------------------------
  // Drag / resize / rotate all follow the same shape: pointerdown on the
  // element (stopPropagation so the timeline/frame doesn't also react), window
  // listeners for the gesture, ONE history checkpoint on first movement, then
  // live updates with { history: false } — the whole gesture is one undo step.

  /** Shared tail: checkpoint-once wrapper + window listener wiring. */
  const runGesture = (apply: (ev: PointerEvent) => void) => {
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        checkpoint(); // snapshot once, on first actual movement
        moved = true;
      }
      apply(ev);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** Overlay anchor center in viewport px (the % position on the frame). */
  const overlayCenterPx = (overlay: TextOverlay) => {
    const frameEl = frameRef.current;
    if (!frameEl) return null;
    const rect = frameEl.getBoundingClientRect();
    return {
      rect,
      cx: rect.left + (overlay.x / 100) * rect.width,
      cy: rect.top + (overlay.y / 100) * rect.height,
    };
  };

  // Drag to move; store x/y as % so it's aspect- and export-correct.
  const beginOverlayDrag = (e: ReactPointerEvent, overlay: TextOverlay) => {
    e.stopPropagation();
    if (editingId === overlay.id) return; // inline edit owns the pointer (caret)
    e.preventDefault();
    setSelected(overlay.id);
    if (overlay.locked) return; // still selectable, never movable
    const frameEl = frameRef.current;
    if (!frameEl) return;
    const rect = frameEl.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = overlay.x;
    const origY = overlay.y;

    runGesture((ev) => {
      const nx = clampPct(origX + ((ev.clientX - startX) / rect.width) * 100);
      const ny = clampPct(origY + ((ev.clientY - startY) / rect.height) * 100);
      updateTextOverlay(overlay.id, { x: nx, y: ny }, { history: false });
    });
  };

  // Corner handles: scale the distance pointer↔anchor into a fontSize factor.
  // Distance-based, so it behaves the same at any rotation angle.
  const beginOverlayResize = (e: ReactPointerEvent, overlay: TextOverlay) => {
    e.stopPropagation();
    e.preventDefault();
    const c = overlayCenterPx(overlay);
    if (!c) return;
    const startDist = Math.hypot(e.clientX - c.cx, e.clientY - c.cy);
    if (startDist < 2) return;
    const origSize = overlay.style.fontSize;

    runGesture((ev) => {
      const factor = Math.hypot(ev.clientX - c.cx, ev.clientY - c.cy) / startDist;
      const fontSize =
        Math.round(clamp(origSize * factor, MIN_FONT_SIZE, MAX_FONT_SIZE) * 10) / 10;
      updateTextOverlay(overlay.id, { style: { fontSize } }, { history: false });
    });
  };

  // Rotation handle (sits above the box): pointer bearing from the anchor,
  // +90° because the handle's rest position is straight up. Snaps to the
  // nearest 45° step when close, so 0/90/180 are easy to hit exactly.
  const beginOverlayRotate = (e: ReactPointerEvent, overlay: TextOverlay) => {
    e.stopPropagation();
    e.preventDefault();
    const c = overlayCenterPx(overlay);
    if (!c) return;

    runGesture((ev) => {
      let deg = (Math.atan2(ev.clientY - c.cy, ev.clientX - c.cx) * 180) / Math.PI + 90;
      const snapped = Math.round(deg / 45) * 45;
      if (Math.abs(deg - snapped) <= ROTATE_SNAP) deg = snapped;
      // normalize to (-180, 180]
      if (deg > 180) deg -= 360;
      if (deg <= -180) deg += 360;
      updateTextOverlay(overlay.id, { rotation: Math.round(deg) }, { history: false });
    });
  };

  // --- inline text editing (double-click) ------------------------------------

  const beginInlineEdit = (overlay: TextOverlay) => {
    if (overlay.locked) return;
    setPlaying(false); // hold the frame while typing
    setSelected(overlay.id);
    editCancelRef.current = false;
    setEditingId(overlay.id);
  };

  /** Seed the contenteditable once per edit session: initial text + focus +
   *  select-all. The div is keyed per mode so React remounts it cleanly. */
  const seedInlineEdit = (el: HTMLDivElement | null, overlay: TextOverlay) => {
    if (!el || el.dataset.editFor === overlay.id) return;
    el.dataset.editFor = overlay.id;
    el.textContent = overlay.text;
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  const finishInlineEdit = (overlay: TextOverlay, el: HTMLElement) => {
    setEditingId(null);
    if (editCancelRef.current) {
      editCancelRef.current = false;
      return;
    }
    // innerText maps the contenteditable's line breaks back to \n.
    const text = el.innerText.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    if (text !== overlay.text) updateTextOverlay(overlay.id, { text }); // one undo step
  };

  // Blur commits most edits, but drag handlers preventDefault() on pointerdown,
  // which SUPPRESSES the focus change — clicking another overlay or a timeline
  // block would end the edit render without a blur and drop the typed text.
  // So while editing, watch the store: the moment selection leaves the edited
  // overlay, commit from the still-mounted contenteditable.
  const committingRef = useRef(false);
  useEffect(() => {
    if (!editingId) return;
    return useEditorStore.subscribe((s) => {
      if (s.selectedItemId === editingId || committingRef.current) return;
      committingRef.current = true;
      const el = frameRef.current?.querySelector<HTMLElement>('.overlay-item--editing');
      const overlay = s.textOverlays.find((t) => t.id === editingId);
      if (el && overlay) finishInlineEdit(overlay, el);
      else setEditingId(null); // overlay deleted mid-edit — nothing to commit
      committingRef.current = false;
    });
  }, [editingId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrapRef} className={'player' + (isFullscreen ? ' player--fs' : '')}>
      <div className="player__stage">
        <div
          ref={frameRef}
          className="preview__frame"
          style={{ aspectRatio: ASPECT_CSS[aspectRatio] }}
        >
          {/* Decorative frame background (stage 9A): the SAME SVG the export
              rasterizes, or — for blurred-fill — a low-res canvas copy of the
              video repainted by applyBlend. */}
          {frame.type !== 'none' &&
            (frameBgUrl ? (
              <div
                className="frame-bg"
                style={{ backgroundImage: `url("${frameBgUrl}")` }}
                aria-hidden="true"
              />
            ) : (
              <canvas
                ref={frameBlurRef}
                className="frame-bg"
                width={blurDims.width}
                height={blurDims.height}
                aria-hidden="true"
              />
            ))}

          {/* Video viewport: positioned by frameLayout() percentages; corners
              round in cqmin (= % of the frame's short side — the same unit
              the export mask uses). Full-bleed when the frame type is none. */}
          <div
            ref={viewportRef}
            className="frame-viewport"
            style={{
              left: `${frameRect.x * 100}%`,
              top: `${frameRect.y * 100}%`,
              width: `${frameRect.w * 100}%`,
              height: `${frameRect.h * 100}%`,
              borderRadius: frameRect.radiusPct > 0 ? `${frameRect.radiusPct}cqmin` : '0',
            }}
          >
            {/* Each video sits in a viewport-sized wrapper: transitions and
                effect transforms style the WRAPPER (setLayer), while the
                element inside carries the clip's crop layout + CSS filter. */}
            <div className={'preview__layer' + (activeIndex === 0 ? '' : ' preview__layer--idle')}>
              <video ref={videoA} className="preview__video" playsInline preload="auto" />
            </div>
            <div className={'preview__layer' + (activeIndex === 1 ? '' : ' preview__layer--idle')}>
              <video ref={videoB} className="preview__video" playsInline preload="auto" />
            </div>

            {/* Stage-8 effect layers, above the videos and below the text.
                Opacity/position are driven per frame by applyBlend. They live
                inside the viewport: vignette/grain/flash belong to the video,
                not to the frame border. */}
            <div ref={fxVignetteRef} className="fx-layer fx-layer--vignette" aria-hidden="true" />
            <div ref={fxGrainRef} className="fx-layer fx-layer--grain" aria-hidden="true" />
            <div ref={fxFlashRef} className="fx-layer fx-layer--flash" aria-hidden="true" />

            {/* Crop editor: interactive rect over the (uncropped) source,
                shown only while its clip is the one under the playhead. */}
            {(() => {
              const cropClip = clips.find((c) => c.id === cropEditingClipId);
              if (!cropClip || locate(clips, playheadTime)?.clip.id !== cropClip.id) return null;
              return (
                <CropOverlay
                  clip={cropClip}
                  viewportAspect={viewportAspect}
                  viewportRef={viewportRef}
                />
              );
            })()}
          </div>

          {/* Overlay layer: container ignores pointer events so it doesn't
              swallow drops/clicks; each overlay re-enables them. */}
          <div className="overlay-layer">
            {textOverlays.map((o) => {
              const r = computeOverlayRender(o, playheadTime);
              const selected = o.id === selectedItemId;
              // Editing requires selection: clicking anywhere else blurs the
              // contenteditable (which commits + clears editingId), but if
              // selection ever moves without a blur, this gate ends the edit
              // render instead of leaving a stray editable behind.
              const editing = o.id === editingId && selected;
              // Render when visible, or as a faint editor-only ghost when the
              // overlay is selected but the playhead is outside its window.
              if (!r.visible && !selected) return null;
              const ghost = !r.visible && !editing;
              // Ghost/editing suppress the animation but keep the rotation.
              const anim = ghost || editing ? overlayStaticTransform(o) : r.transform;
              return (
                <div
                  // Remount when the edit mode flips so React never has to
                  // reconcile children against user-typed contenteditable DOM.
                  key={o.id + (editing ? ':edit' : '')}
                  className={
                    'overlay-item' +
                    (selected ? ' overlay-item--selected' : '') +
                    (ghost ? ' overlay-item--ghost' : '') +
                    (editing ? ' overlay-item--editing' : '') +
                    (o.locked ? ' overlay-item--locked' : '')
                  }
                  style={{
                    left: `${o.x}%`,
                    top: `${o.y}%`,
                    opacity: ghost ? 0.35 : editing ? o.style.opacity : r.opacity * o.style.opacity,
                    transform: `translate(-50%, -50%) ${anim}`.trimEnd(),
                    // Full text (not the typewriter-truncated r.text) so the
                    // derived RTL direction can't flip mid-animation.
                    ...overlayTextStyle(o.style, o.text),
                  }}
                  contentEditable={editing ? 'plaintext-only' : undefined}
                  suppressContentEditableWarning={editing || undefined}
                  ref={editing ? (el) => seedInlineEdit(el, o) : undefined}
                  onBlur={editing ? (e) => finishInlineEdit(o, e.currentTarget) : undefined}
                  onKeyDown={
                    editing
                      ? (e) => {
                          if (e.key === 'Escape') {
                            editCancelRef.current = true;
                            e.currentTarget.blur();
                          }
                          e.stopPropagation(); // keep Delete/space/etc. local
                        }
                      : undefined
                  }
                  onPointerDown={(e) => beginOverlayDrag(e, o)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    // Direct hits only — a double-click on a resize/rotate
                    // handle bubbles here and must not start editing.
                    if (e.target === e.currentTarget) beginInlineEdit(o);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(o.id);
                  }}
                >
                  {editing ? null : ghost ? o.text : r.text}
                  {selected && !editing && !o.locked && (
                    <>
                      <span className="ovh ovh--nw" onPointerDown={(e) => beginOverlayResize(e, o)} />
                      <span className="ovh ovh--ne" onPointerDown={(e) => beginOverlayResize(e, o)} />
                      <span className="ovh ovh--sw" onPointerDown={(e) => beginOverlayResize(e, o)} />
                      <span className="ovh ovh--se" onPointerDown={(e) => beginOverlayResize(e, o)} />
                      <span
                        className="ovh ovh--rot"
                        title="Drag to rotate"
                        onPointerDown={(e) => beginOverlayRotate(e, o)}
                      />
                    </>
                  )}
                  {selected && o.locked && (
                    <span className="overlay-lock" title="Locked — unlock in the Text panel">
                      🔒
                    </span>
                  )}
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
            className="player__btn"
            onClick={blurThen(() => stepBy(-1))}
            title="Step back 1s"
          >
            ‹
          </button>
          <button
            type="button"
            className="player__btn player__btn--play"
            onClick={blurThen(togglePlay)}
            title={isPlaying ? 'Pause (space)' : 'Play (space)'}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <button
            type="button"
            className="player__btn"
            onClick={blurThen(() => stepBy(1))}
            title="Step forward 1s"
          >
            ›
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
