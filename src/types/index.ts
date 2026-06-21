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
export type ExportResolution = '480p' | '720p' | '1080p';

/** Entrance/exit animation for a text overlay. */
export type TextAnimation = 'none' | 'fade' | 'slide' | 'pop' | 'typewriter';

/** Direction a 'slide' animation enters from. */
export type SlideDirection = 'left' | 'right' | 'top' | 'bottom';

export type TextAlignment = 'left' | 'center' | 'right';

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
}

/** A timed text element rendered on top of the video. */
export interface TextOverlay {
  id: string;
  text: string;
  startTime: number; // timeline seconds the overlay appears
  endTime: number; // timeline seconds the overlay disappears
  /** Anchor position as percentages of the preview frame (0..100), so it stays
   *  correct across aspect ratios and at export. (50,50) = centered. */
  x: number;
  y: number;
  style: TextStyle;
  animation: TextAnimation;
  slideFrom: SlideDirection; // used only when animation === 'slide'
}

/** An independent audio source (e.g. music / voiceover) on its own track. */
export interface AudioTrack {
  id: string;
  sourceFileName: string;
  inPoint: number; // trim start within the source (seconds)
  outPoint: number; // trim end within the source (seconds)
  volume: number; // 0..1
  fadeIn: number; // seconds
  fadeOut: number; // seconds
}

/** Project-wide output settings. */
export interface ProjectSettings {
  aspectRatio: AspectRatio;
  exportResolution: ExportResolution;
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
