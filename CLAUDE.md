# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A CapCut-style, mobile-first **web video editor** for ≤60-second videos. React 19 + TypeScript + Vite, Zustand for state, FFmpeg.wasm for media processing. Everything runs in the browser; there is no backend.

**Product pivot (stage 7):** the user's real goal turned out to be *turning one long video into many shorts* — e.g. a 50-minute video becomes 50 one-minute clips. The "Shorts" toolbar button opens a batch-split dialog (`src/lib/splitter.ts`) that cuts a long source into segments WITHOUT re-encoding; any segment can then be opened in the ≤60s editor for finishing (text/effects/transitions) and re-exported. The editor is now the finishing tool, not the main event.

It is being built in **6 user-driven stages**, one at a time: (1) scaffold + store, (2) import + timeline + trim, (3) preview player, (4) text overlays, (5) audio + effects, (6) export. All 6 stages are done. "Split" was never in scope and remains a disabled toolbar button. The user explicitly asks for ONE stage at a time and tests in a real browser between stages — do only the requested stage, then stop. The user's stage intros sometimes claim features exist that don't yet (e.g. "split"); verify against the actual code before building on them.

## Commands

```bash
npm install        # deps (Windows/PowerShell + Git Bash both available)
npm run dev        # Vite dev server (auto-picks 5173/5174/... if busy)
npm run build      # tsc -b && vite build — the real typecheck + bundle gate
npm run lint       # eslint
npm run preview    # serve the production build
```

- `npm run build` is the authoritative check (strict TS via `tsc -b`, then Vite). The dev-server returning HTTP 200 for `/src/...` module paths confirms a file transforms, but does NOT typecheck — always run `build`.
- A clean build emitting `dist/assets/worker-*.js` confirms the FFmpeg worker still wires up.

### Testing

There is **no test runner** (deliberately — keeps deps minimal). The critical pure logic (`src/lib/playback.ts`, `src/lib/overlay.ts`, `src/lib/audio.ts`) is verified by hand against boundary cases using Node directly, e.g. inline a copy of the function bodies into a throwaway `.mjs` and `node it.mjs`. Node 25 can also run `.ts` via type-stripping, but its ESM resolver needs file extensions, so relative imports inside the lib files won't resolve — inlining the logic is the path that works. Always exercise boundaries: `t=0`, exact clip seam, `t=total`, empty input, and very short durations where the animation enter/exit clamps bite.

## Architecture — the load-bearing ideas

These span multiple files and are the things to understand before changing anything.

### Single store, document vs. UI state split
`src/store/editorStore.ts` (Zustand) is the single source of truth. Components are presentational and read/write through it. State is split:
- **Document** (`EditorDocument`: `clips`, `textOverlays`, `audioTracks`, `settings`) — this is what undo/redo snapshots.
- **UI state** (`playheadTime`, `selectedItemId`, `isPlaying`) — intentionally NOT in history (undoing a playhead nudge is hostile).

`selectedItemId` is shared across clips AND overlays — disambiguate by which collection contains the id.

### The 60s guard is uniform, never per-action math
The hard product constraint (total trimmed video ≤ 60s) is enforced through one pure function, `computeTotalDuration(clips)` in `src/lib/duration.ts`. Every guarded action builds a **candidate** clips array and runs `exceedsMax` on it, rather than computing deltas — so the guard and the displayed total can never disagree. Guarded actions return `ActionResult` (`{ok:true} | {ok:false, reason}`) so the UI surfaces `reason` instead of throwing. **Only video clips count toward 60s**; text/audio do not.

### Clips are a gapless sequential track
The main track has no gaps. `Clip.position` (global start time) is **derived**, never hand-set: after any add/remove/reorder/trim, call `sequenceClips()` to re-lay positions from array order. Total duration = sum of trimmed lengths minus transition overlaps.

### Transitions overlap their clips (stage 7A)
A transition is data on the LEFT clip (`Clip.transitionAfter: {type, duration}`; types crossfade/fadeblack/slide/zoom) and **overlaps** the two clips it joins — xfade semantics, so each transition SHORTENS the timeline by its duration. The stored duration is a request; `effectiveTransitionDurations(clips)` (duration.ts) clamps it at READ time against the neighbors (left seam gets priority; results < 0.05s become hard cuts). Like `clipDuration()` for speed, everything flows through this one function: the 60s guard (removing a transition lengthens the video, so `setTransition` runs the uniform guard), `sequenceClips`, `buildSegments` (whose windows now overlap; `locate` returns the OUTGOING clip inside an overlap), the preview blend, and the export xfade offsets. Preview: `locateTransition()` (playback.ts) + pure `computeTransitionFrame()` (lib/transitions.ts) drive `applyBlend()` in PreviewPlayer, which styles BOTH video elements imperatively from the playhead — identical playing or scrubbing; each element carries its own clip's CSS filter. Export: when any transition exists, the join step becomes one `xfade`/`acrossfade` filter_complex (concat filter at hard-cut seams; costs a second video encode); otherwise the lossless concat path is kept. `zoom` maps to xfade `zoomin` (needs FFmpeg ≥ 5.0 — @ffmpeg/core 0.12.9 is 5.1.x); its preview easing is a preview-grade approximation by design, crossfade/fadeblack match exactly (linear, as is the acrossfade volume ramp).

### Pure time-mapping, reused at export
- `src/lib/playback.ts` maps global timeline time ↔ (clip + source time): `buildSegments`, `locate(clips, t)`, `sourceToGlobal`. At a clip seam `locate` returns the LATER clip (so playback advances). These are pure and will be reused by the export stage — keep them stateless.
- **Speed (stage 5) flows through one seam**: `clipDuration()` returns trimmed source length ÷ `clip.speed`, so the 60s cap, block widths, and `locate`'s time mapping (timeline seconds advance 1/speed as fast as source seconds) all follow automatically. Trim-handle drags in `TimelineArea` convert cursor pixels to SOURCE seconds by multiplying by speed.
- `src/lib/audio.ts` `audioGainAt(track, t)` computes an audio track's effective gain (volume × fades) purely from the playhead — same philosophy as overlays: identical when playing or scrubbing, reproducible at export. The preview mixer evaluates it every frame instead of scheduling Web Audio ramps.
- `src/lib/overlay.ts` `computeOverlayRender(overlay, playheadTime)` computes an overlay's animated `{visible, opacity, transform, text}` **purely from the playhead** — so animations are identical whether playing or scrubbing (forward/backward) and reproducible at export. Consequence: overlays must have **no CSS `transition`** on animated props; the playhead-derived value IS the animation.

### Preview player (`src/components/PreviewPlayer.tsx`)
- Position is the store's `playheadTime` (single source of truth). The rAF loop writes it during playback and records each value in `lastWriteRef`; the seek effect re-seeks the `<video>` only when `playheadTime` differs from that last value — i.e. a **user** seek. This source-detection (not a magnitude threshold) is what prevents a playback↔seek feedback loop while still honoring tiny ruler clicks.
- **Double-buffered** `<video>` A/B: one plays while the idle one preloads + seeks the next clip, swapping at the boundary for near-seamless transitions. The single seam for "show clip at source time T" is `showGlobal`; the boundary swap lives in `tick`.
- Async/imperative code reads fresh state via `useEditorStore.getState()` to avoid stale rAF closures.

### Audio tracks (stage 5)
- Unlike clips, `AudioTrack`s are NOT gapless: each sits freely on the timeline via `offset`; its audible window is `[offset, offset + outPoint − inPoint]`. Audio never counts toward the 60s cap (only the ruler clamps it).
- Preview mixing lives in `src/lib/useAudioMixer.ts` (mounted by `PreviewPlayer`): per track, a hidden `<audio>` → `MediaElementSource` → `GainNode`, reconciled against `playheadTime` by a rAF loop while playing (start/seek/pause + gain from `audioGainAt`). Nodes are created lazily inside the play loop so the shared `AudioContext` (`src/lib/audioContext.ts`) is born after a user gesture and never autoplay-suspended.
- Waveforms: `src/lib/waveform.ts` decodes via a throwaway `OfflineAudioContext` (works pre-gesture, no autoplay warning) and caches normalized peaks **by object URL** (stable across trim/undo, unlike row lifecycle), with an in-flight map deduping StrictMode double-fires. Blocks show a shimmer placeholder until peaks resolve.
- `AudioTrack.src` follows the same object-URL lifecycle rule as `Clip.src`: never revoked once in the store (undo may restore it); revoked only when import fails before `addAudioTrack`.

### Effects are data (stage 5)
Filter preset, adjustments (brightness/contrast/saturation/temperature), and speed are stored per clip as plain numbers/ids — never baked into media. `src/lib/effects.ts` `buildClipFilter(clip)` translates them into a CSS `filter` string for the preview `<video>` (applied to both A/B elements from the clip under the playhead); stage 6 must translate the same data to FFmpeg filters. Temperature's CSS mapping (sepia/hue-rotate) is a preview-grade approximation by design.

### Export pipeline (stage 6)
`src/lib/exporter.ts` bakes the document into an MP4 with FFmpeg.wasm, sequentially and memory-bounded: (1) per clip, write ONE source into MEMFS, encode a normalized video segment (`-ss`/`-t` trim → `setpts`/speed → `fps=30` → cover-scale/crop → per-op color filters → yuv420p/x264) and a matching **PCM wav** audio segment (atempo for speed; anullsrc silence when muted or the source has no audio — detected by retrying after a failed exec), then delete the source; (2) concat both with the concat demuxer `-c copy` (PCM concat is gapless — deliberately NOT AAC, which would drift at seams from encoder priming); (3) text overlays are rasterized by `src/lib/overlayRaster.ts` to transparent PNGs using the SAME `computeOverlayMotion` + browser text engine as the preview, adaptively sampled (one held frame for static intervals, 30fps inside enter/exit ramps) and fed via a concat-demuxer image list (last file repeated so its duration counts) into one `overlay` filter; (4) music tracks: `atrim → volume → afade → adelay`, then `amix=duration=first:normalize=0` with the clip audio; (5) mux H.264+AAC `+faststart` — video is stream-copied when there are no overlays to burn.
- **Color fidelity**: CSS filter functions are affine RGB transforms (W3C spec matrices). `src/lib/effects.ts` stores each preset/adjustment as `ColorOp[]` (single source of truth); the preview renders ops → CSS, `src/lib/exportFilters.ts` renders the same ops → one `colorchannelmixer`/`lutrgb` per op (per-op emission matches CSS's per-primitive clamping AND keeps mixer coefficients within the allowed [-2,2]).
- Progress is weighted work-units across phases; within an exec it uses the ffmpeg `progress` event (`time` µs ÷ expected output seconds). Cancel = flip token + `resetFFmpeg()` (terminates the worker; MEMFS dies; next use reloads the core).
- Export settings are dialog-local (`ExportDialog.tsx` mounts content only while open); the 60s guard is re-checked inside `runExport`.

### Known lint debt
`npm run lint` has 2 pre-existing `react-hooks` errors (in `useThumbnails.ts` and `PreviewPlayer.tsx`'s fullscreen button) that predate stage 5; `npm run build` is the gate that must stay clean.

### Export-fidelity rule for overlays
Overlay geometry is stored frame-relative, never px: position `x,y` as % of the frame; `fontSize` in `cqh` (the preview frame sets `container-type: size`); `outlineWidth` in `em`. This keeps overlays identical across preview, fullscreen, and export.

### Undo granularity for gestures
`updateTextOverlay` (and similar) snapshot history per call, which would spam undo during a drag/slider. Pattern: call `checkpoint()` once at gesture start, then pass `{history:false}` on the live updates — the whole gesture becomes one undo step. Discrete edits (typing, selects, presets) commit normally.

### Batch splitter (stage 7, `src/lib/splitter.ts`)
Cuts one long video into consecutive shorts of a chosen length (5–60s), stream-copy only (`-c copy`): near-instant and lossless, but cut points snap to keyframes (segments deviate by up to one GOP — accepted by the user over slow exact re-encoding). Two memory rules make multi-GB sources work in wasm32's ~2GB heap: (1) the source is **mounted read-only via WORKERFS** (`ffmpeg.mount(FFFSType.WORKERFS, {blobs...})`) — never copied into MEMFS; (2) each segment is its own exec (`-ss K [-t L] -i src`, last segment runs to EOF so no tail is lost), read out as a Blob and deleted before the next. Args validated against native ffmpeg: a 130s file → 60.00+60.02+10.02s, zero loss. Results stream into `splitStore` (mirrors exportStore incl. cancel-via-`resetFFmpeg`); each `SplitSegment` keeps its `File` — the dialog's "Edit" button creates a FRESH object URL for `addClip` (clip URLs are never revoked; split-result URLs are revoked on the next run). Known limit: all result blobs stay referenced, so a huge source ≈ its size in browser blob storage; Chrome pages blobs to disk, other browsers may not.

### FFmpeg.wasm (`src/lib/ffmpeg.ts`, `src/store/ffmpegStore.ts`)
Used for thumbnails, export, and the batch splitter. Loaded **lazily** on first need. Key constraints:
- Single-threaded `@ffmpeg/core` (pinned `0.12.9`) is **self-hosted in `/public/ffmpeg`** (committed, ~32MB wasm) with the unpkg CDN as fallback; both fetched via `toBlobURL`, each attempt on a fresh instance (a failed load wedges the worker) → **no COOP/COEP headers** (cross-origin isolation would break the CDN fallback; do not add it).
- `@ffmpeg/ffmpeg` and `@ffmpeg/util` are in `optimizeDeps.exclude` (vite.config.ts) because the worker is spawned via `new URL('./worker.js', import.meta.url)` and pre-bundling breaks that.
- One wasm instance can't run concurrent commands — all exec/read/write sequences go through the `runExclusive` mutex. Thumbnails are cached by clip id and deduped against StrictMode double-fire via an in-flight promise map.

### Lifecycle gotcha: object URLs
`Clip.src` is a `URL.createObjectURL` blob URL. It is **never revoked on `removeClip`** (undo could restore the clip) — only revoked in the import path when the 60s guard rejects a clip that never entered the store.

## Conventions

- Drag gestures use `pointerdown` + `window` `pointermove`/`pointerup` listeners (not React drag events). Interactive children (clips, overlay blocks, trim handles) `stopPropagation` on `pointerdown` so the timeline scrub handler doesn't also fire.
- React's new JSX transform means `React` is not in scope — import event types explicitly (e.g. `import { type PointerEvent as ReactPointerEvent } from 'react'`).
- Strict TS (`tsc -b`). Note `Blob` from FFmpeg `Uint8Array` output needs a copied `ArrayBuffer` slice to satisfy TS's SharedArrayBuffer-vs-ArrayBuffer typing.
- Styling is a single global `src/index.css` with CSS variables; mobile-first, the app is a vertical flex column (preview / toolbar / timeline) capped at `max-width: 720px`.
- Folders: `src/store` (Zustand), `src/lib` (pure logic + hooks), `src/components`, `src/types`.
