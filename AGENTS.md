# AGENTS.md — Quick Reference for AI Coding Agents

This is a CapCut-style web video editor: **React 19 + TypeScript + Vite**, in-browser only. See [CLAUDE.md](./CLAUDE.md) for detailed architecture and conventions.

## Quick Commands

```bash
npm run dev     # Vite dev server (auto-picks port if busy)
npm run build   # tsc -b && vite build — strict typecheck + bundle gate
npm run lint    # eslint
npm run preview # serve production build
```

**Always run `npm run build` to verify — the dev server does NOT typecheck.**

## Architecture at a Glance

- **Single Zustand store** (`src/store/editorStore.ts`) — document + UI state split. Components are presentational.
- **Clips are gapless sequential**: positions are derived via `sequenceClips()`, never hand-set.
- **Hard 60s limit** enforced uniformly via `computeTotalDuration(clips)` in `src/lib/duration.ts`. Guarded actions return `ActionResult` (ok/reason), never throw.
- **Pure time-mapping** (`src/lib/playback.ts`): `buildSegments`, `locate(clips, t)` are stateless, reused at export.
- **Overlays animate** purely from playhead via `computeOverlayRender(overlay, t)` — identical when playing/scrubbing. No CSS transitions on animated props.
- **Audio tracks** are not gapless; each has an `offset` on the timeline. Audio doesn't count toward 60s cap.
- **Transitions overlap clips**: stored on the left clip; xfade semantics, duration is clamped at read-time by `effectiveTransitionDurations(clips)`.
- **Double-buffered `<video>`** in PreviewPlayer: A/B swap at clip boundaries for seamless playback. Position is store's `playheadTime`.
- **Effects are data** (CSS filters, speed, presets) — stored on clips, not baked into media. Export must translate to FFmpeg filters.

## Key Files & Patterns

| Pattern | File(s) |
|---------|---------|
| Duration logic, 60s guard | `src/lib/duration.ts` |
| Playback time-mapping | `src/lib/playback.ts` |
| Overlay animation math | `src/lib/overlay.ts` |
| Audio gain & fades | `src/lib/audio.ts` |
| Preview mixer | `src/lib/useAudioMixer.ts` |
| Clip CSS filters | `src/lib/effects.ts` |
| Export (FFmpeg) | `src/lib/exporter.ts` |
| Batch splitter | `src/lib/splitter.ts` |
| FFmpeg worker setup | `src/lib/ffmpeg.ts`, `src/store/ffmpegStore.ts` |
| UI components | `src/components/` |
| Type defs | `src/types/index.ts` |

## Core Rules

1. **Positions are derived**, not stored. After add/remove/reorder/trim, call `sequenceClips()`.
2. **Undo granularity**: Discrete edits (typing, selects, presets) commit normally. For drag/slider: call `checkpoint()` at start, then pass `{history: false}` on live updates.
3. **No CSS transitions on animated props** (overlays, effects) — the playhead-derived value **is** the animation.
4. **Speed flows through one seam**: `clipDuration()` returns trimmed length ÷ `clip.speed`. Timeline seconds, block widths, and `locate`'s time mapping all follow automatically.
5. **Object URL lifecycle**: `Clip.src` is never revoked on remove (undo). Revoked only on failed import.
6. **FFmpeg work goes through `runExclusive` mutex** — all exec/read/write sequences are serialized.
7. **Overlays are frame-relative** (%, em, cqh) — never px — so they scale identically in preview, fullscreen, and export.
8. **Drag gestures use window-level `pointermove`/`pointerup`**, not React events. Interactive children `stopPropagation` on `pointerdown`.

## Testing Notes

No test runner (intentional). For pure logic (`src/lib/playback.ts`, `src/lib/overlay.ts`, `src/lib/audio.ts`):
- Inline a copy into a throwaway `.mjs` file and `node it.mjs`
- Test boundaries: `t=0`, clip seams, `t=total`, empty input, very short durations

See [CLAUDE.md §Testing](./CLAUDE.md#testing) for details.

## Common Pitfalls

- **Dev server returns 200 for `/src/...` but that's not a typecheck.** Always run `build`.
- **React JSX transform means `React` isn't in scope** — import event types explicitly (e.g., `import { type PointerEvent as ReactPointerEvent } from 'react'`).
- **FFmpeg.wasm is lazy-loaded** from `/public/ffmpeg` (self-hosted) or unpkg CDN. A failed load wedges the worker; use a fresh instance.
- **@ffmpeg/ffmpeg and @ffmpeg/util are in `optimizeDeps.exclude`** because the worker spawns via `new URL('./worker.js', import.meta.url)`.
- **Object URLs are never revoked** once a clip is in the store (undo could restore it).
- **The 60s guard is uniform**. Don't compute delta math per action — build a candidate clips array and run `exceedsMax` on the whole thing.

## Stages & Scope

1. Scaffold + store ✓
2. Import + timeline + trim ✓
3. Preview player ✓
4. Text overlays ✓
5. Audio + effects ✓
6. Export ✓
7. Batch splitter (frame-accurate split disabled; stream-copy split exists in `src/lib/splitter.ts`)

Only implement one stage at a time. **Verify against actual code** before building on claims in a stage intro — sometimes the intro describes goals, not what's implemented.

## Known Lint Debt

`npm run lint` has 2 pre-existing `react-hooks` errors in `useThumbnails.ts` and `PreviewPlayer.tsx` (fullscreen button). `npm run build` is the gate that must stay clean.

---

For detailed architecture decisions, export pipeline, FFmpeg constraints, and color fidelity, see [CLAUDE.md](./CLAUDE.md).
