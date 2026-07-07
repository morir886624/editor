// ---------------------------------------------------------------------------
// Editor domain types
//
// The whole product is built around one hard constraint: the total trimmed
// video duration must stay <= 60s. The data model below keeps the video track
// (`clips`) gapless and sequential so that "total duration" is unambiguous:
// it is simply the sum of each clip's trimmed length. See /src/lib/duration.ts.
// ---------------------------------------------------------------------------

/** Output framing the project will export in. */
export type AspectRatio = '9:16' | '1:1' | '16:9';

/** Export resolution presets (short side / common label). */
export type ExportResolution = '480p' | '720p' | '1080p' | '1440p' | '2160p';

/** Entrance/exit animation for a text overlay. */
export type TextAnimation = 'none' | 'fade' | 'slide' | 'pop' | 'typewriter';

/** Direction a 'slide' animation enters from. */
export type SlideDirection = 'left' | 'right' | 'top' | 'bottom';

export type TextAlignment = 'left' | 'center' | 'right';

/** One-tap color filter presets (LUT-style). CSS approximations live in
 *  /src/lib/effects.ts; export (stage 6) maps the same ids to FFmpeg filters.
 *  These are generic color grades (not copies of any branded look). */
export type FilterPreset =
  | 'none'
  | 'warm'
  | 'cool'
  | 'bw'
  | 'vivid'
  | 'vintage'
  | 'cinematic'
  | 'film'
  | 'airy'
  | 'moody'
  | 'golden'
  | 'winter'
  | 'pastel'
  | 'pop'
  | 'matte'
  | 'hcbw'
  | 'sepia'
  | 'crossprocess';

/** Transition styles between two adjacent clips (stage 7). Each maps to an
 *  FFmpeg xfade transition at export; the preview approximates the same look
 *  with CSS opacity/transform driven purely by the playhead. */
export type TransitionType = 'crossfade' | 'fadeblack' | 'slide' | 'zoom';

/**
 * A transition between a clip and the NEXT clip on the timeline.
 * Transitions OVERLAP their two clips (like FFmpeg xfade): the incoming clip
 * starts `duration` seconds before the outgoing clip ends, so each transition
 * SHORTENS the total timeline by its duration. The stored duration is a
 * request; the effective duration is clamped against the neighboring clips at
 * read time (see effectiveTransitionDurations in /src/lib/duration.ts).
 */
export interface ClipTransition {
  type: TransitionType;
  duration: number; // seconds
}

/**
 * Manual per-clip color adjustments. Stored as data (never baked into media)
 * so preview and export render from the same parameters.
 * Neutral values: brightness/contrast/saturation = 100, temperature = 0.
 */
export interface ClipAdjustments {
  brightness: number; // 50..150 (%)
  contrast: number; // 50..150 (%)
  saturation: number; // 0..200 (%)
  temperature: number; // -50 (cool) .. 50 (warm)
}

/**
 * Visual styling for a text overlay.
 *
 * Sizes are stored frame-relative (not px) so an overlay looks identical in the
 * preview, in fullscreen, and at export regardless of the rendered frame size:
 *  - fontSize is in `cqh` (1cqh = 1% of the preview frame's height);
 *  - outlineWidth is in `em` (relative to fontSize).
 */
export interface TextStyle {
  fontFamily: string;
  fontSize: number; // cqh — % of frame height
  color: string; // hex, e.g. "#ffffff"
  outlineColor: string; // hex
  outlineWidth: number; // em, relative to fontSize (0 = no outline)
  opacity: number; // 0..1
  alignment: TextAlignment;
  shadow: boolean; // drop shadow on/off
  background: string; // box background CSS color, or 'transparent' for none
  /** Line-height multiplier; undefined = automatic per font group
   *  (1.15 Latin / 1.7 Arabic — see overlayLineHeight in /src/lib/fonts.ts). */
  lineHeight?: number;
}

/**
 * A video file imported this session. The Clips panel presents each source as
 * consecutive ≤60s "pieces"; placing a piece on the timeline creates a Clip
 * whose [inPoint, outPoint] is that piece's window into the same source URL.
 * Sources live outside the undo history — the library survives undo/redo.
 */
export interface ImportedSource {
  id: string;
  fileName: string;
  /** Object URL — same lifecycle rule as Clip.src: never revoked once stored
   *  (clips created from any of its pieces share this URL). */
  url: string;
  duration: number; // full length of the file (seconds)
}

/**
 * Trending video effect ids (stage 8). Batch 1 ships the CSS-renderable ones
 * below; canvas/WebGL effects (glitch, VHS, chromatic aberration, mirror,
 * motion blur), speed ramp and beat sync arrive in later batches and will
 * extend this union.
 */
export type VideoEffectType = 'vignette' | 'grain' | 'flash' | 'zoom' | 'shake';

/**
 * One effect applied to a clip — stored as parameters, never baked into
 * media (same rule as filters/adjustments). Effects stack: a clip holds an
 * array of these, rendered in the canonical order defined in
 * /src/lib/videoEffects.ts. The preview derives every effect's frame purely
 * from the playhead (like text overlays), so it is identical playing or
 * scrubbing and reproducible at export.
 */
export interface ClipEffect {
  id: string;
  type: VideoEffectType;
  /** Strength 0..100; each effect maps it to its own physical range. */
  intensity: number;
  /**
   * Optional active window, in seconds of the clip's own TIMELINE time
   * (0 = clip start, clipDuration(clip) = clip end — i.e. speed-adjusted).
   * Omitted bound = clip edge. Clamped at READ time against the current
   * clip duration, so trims never invalidate stored effects (same
   * philosophy as transition durations).
   */
  start?: number;
  end?: number;
  /** 'zoom' only: slow push in, or pull out (Ken Burns direction). */
  direction?: 'in' | 'out';
}

/**
 * Per-clip crop / reframe. The rectangle is stored as FRACTIONS of the source
 * frame (resolution-independent, same rule as overlay geometry): x/y is the
 * top-left corner, w/h the size, all 0..1. Undefined = full frame. At render
 * time the crop region is contain-fitted into the output frame — the preview
 * (video-element layout from /src/lib/crop.ts) and the export (FFmpeg crop ->
 * scale/pad) derive from the same geometry, so they always match.
 */
export interface ClipCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A trimmed segment of a source video placed on the main timeline.
 * The visible/used length on the timeline is `outPoint - inPoint`.
 */
export interface Clip {
  id: string;
  sourceFileName: string;
  /**
   * Object URL (URL.createObjectURL) for the source media — used for playback
   * and as the input FFmpeg.wasm reads to generate thumbnails. Added in
   * Stage 2. Note: this is a runtime URL, valid only for the current session;
   * it is intentionally never revoked while a clip may still be restored via
   * undo.
   */
  src: string;
  sourceDuration: number; // full length of the source media (seconds)
  inPoint: number; // trim start within the source (seconds)
  outPoint: number; // trim end within the source (seconds)
  /**
   * Start time of this clip on the timeline (seconds).
   * Derived from clip order — the main track is gapless and sequential,
   * so `position` is always recomputed via sequenceClips() and never set
   * by hand. Stored (rather than computed on read) so the UI can render
   * each clip's offset directly.
   */
  position: number;
  audioMuted: boolean; // mute the clip's original audio
  /** Color filter preset applied to this clip (preview: CSS; export: FFmpeg). */
  filter: FilterPreset;
  /**
   * Preset strength 0..100 (100 = the preset's full look, 0 = original).
   * Blends by scaling each of the preset's color ops toward its neutral
   * value at READ time in clipColorOps(), so preview and export share the
   * blended op list and stay identical. Ignored when filter === 'none'.
   */
  filterIntensity: number;
  /** Manual color adjustments layered on top of the preset. */
  adjustments: ClipAdjustments;
  /**
   * Playback speed 0.25..4. Changes the clip's EFFECTIVE duration on the
   * timeline: trimmed length ÷ speed. All duration math goes through
   * clipDuration() so the 60s cap and block widths follow automatically.
   */
  speed: number;
  /**
   * Transition between this clip and the NEXT one (undefined = hard cut).
   * Inert on the last clip. Travels with the clip through reorders.
   */
  transitionAfter?: ClipTransition;
  /** Stacked trending effects (stage 8), rendered in canonical order. */
  effects: ClipEffect[];
  /** Crop / reframe rectangle (undefined = whole frame). */
  crop?: ClipCrop;
}

/**
 * A timed text element rendered on top of the video.
 * Array order in EditorDocument.textOverlays IS the stacking order (first =
 * bottom, last = top) — both the preview DOM and the export rasterizer render
 * in array order, so z-order edits are plain array reorders.
 */
export interface TextOverlay {
  id: string;
  text: string;
  startTime: number; // timeline seconds the overlay appears
  endTime: number; // timeline seconds the overlay disappears
  /** Anchor position as percentages of the preview frame (0..100), so it stays
   *  correct across aspect ratios and at export. (50,50) = centered. */
  x: number;
  y: number;
  /** Rotation about the anchor point, degrees clockwise (0 = horizontal).
   *  Applied AFTER the animation's translate (screen-space slide) and before
   *  its scale — the export rasterizer mirrors the same order. */
  rotation: number;
  /** Locked overlays ignore preview gestures (drag/resize/rotate/inline edit)
   *  and the Delete key; the side panel still edits them deliberately. */
  locked: boolean;
  style: TextStyle;
  animation: TextAnimation;
  slideFrom: SlideDirection; // used only when animation === 'slide'
}

/**
 * An independent audio source (e.g. music / voiceover) on its own track.
 * Unlike video clips, audio is NOT gapless/sequential: each track is placed
 * freely on the timeline via `offset` and does not count toward the 60s cap.
 * Its audible window is [offset, offset + (outPoint - inPoint)].
 */
export interface AudioTrack {
  id: string;
  sourceFileName: string;
  /** Object URL for the source audio (same lifecycle rules as Clip.src:
   *  never revoked while undo could restore the track). */
  src: string;
  sourceDuration: number; // full length of the source audio (seconds)
  inPoint: number; // trim start within the source (seconds)
  outPoint: number; // trim end within the source (seconds)
  offset: number; // timeline second the (trimmed) audio starts playing
  volume: number; // 0..1
  fadeIn: number; // seconds
  fadeOut: number; // seconds
}

/** Decorative frame styles the video is composited into (stage 9A). */
export type FrameType = 'none' | 'solid' | 'polaroid' | 'filmstrip' | 'blur';

/**
 * Project-wide decorative frame: the video is scaled down and composited
 * inside a styled border filling the chosen aspect ratio. Stored as
 * parameters (never baked); /src/lib/frame.ts derives the geometry and
 * background art consumed by BOTH the preview and the export. All sizes are
 * percentages of the output's SHORT side, so the frame looks identical
 * across aspect ratios and export resolutions.
 */
export interface FrameSettings {
  type: FrameType;
  /** Border thickness around the video, % of the short side. */
  inset: number;
  /** Corner radius of the inner video rectangle, % of the short side. */
  cornerRadius: number;
  /** Background color (hex) — used by 'solid' and 'polaroid'. */
  color: string;
  /** Caption drawn in the polaroid's bottom band ('' = none). */
  caption: string;
}

/** Project-wide output settings. */
export interface ProjectSettings {
  aspectRatio: AspectRatio;
  exportResolution: ExportResolution;
  /** Decorative frame the video sits inside (type 'none' = full bleed). */
  frame: FrameSettings;
}

/**
 * The serializable "document" — the slice of state that undo/redo snapshots.
 * UI-only state (playhead, selection) is intentionally excluded.
 */
export interface EditorDocument {
  clips: Clip[];
  textOverlays: TextOverlay[];
  audioTracks: AudioTrack[];
  settings: ProjectSettings;
}

/**
 * Returned by guarded actions so the UI can react without throwing.
 * On failure, `reason` is human-readable and safe to surface directly.
 */
export type ActionResult = { ok: true } | { ok: false; reason: string };
