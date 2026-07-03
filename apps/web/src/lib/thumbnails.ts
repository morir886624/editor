// ---------------------------------------------------------------------------
// Timeline thumbnail generation via FFmpeg.wasm.
//
// For each clip we extract a handful of frames spanning the FULL source and
// remember each frame's source timestamp. Caching by clip id (not by trim
// range) means dragging a trim handle never re-runs ffmpeg; the timeline just
// filters the cached frames to the visible [inPoint, outPoint] window so the
// strip still tracks the trim.
// ---------------------------------------------------------------------------

import { fetchFile } from '@ffmpeg/util';
import { loadFFmpeg, runExclusive } from './ffmpeg';
import type { Clip } from '../types';

/** A single extracted frame: its source timestamp and a blob URL to display. */
export interface Thumbnail {
  t: number; // source time of the frame (seconds)
  url: string; // object URL of the jpeg
}

/** The slice of a clip generation actually reads — lets the Clips panel
 *  request thumbnails for an ImportedSource without a full Clip. */
export type ThumbnailSource = Pick<Clip, 'id' | 'src' | 'sourceDuration'>;

// Completed results, keyed by clip id.
const cache = new Map<string, Thumbnail[]>();
// In-flight jobs, keyed by clip id — dedupes React StrictMode's double-invoke
// and two components requesting the same clip before the first finishes.
const inFlight = new Map<string, Promise<Thumbnail[]>>();

/** Roughly one frame every 5s, clamped to a sane few. */
function thumbCount(duration: number): number {
  return Math.min(12, Math.max(3, Math.round(duration / 5)));
}

/** Synchronously returns cached thumbnails if present (else undefined). */
export function getCachedThumbnails(clipId: string): Thumbnail[] | undefined {
  return cache.get(clipId);
}

/**
 * Generate (or return cached) thumbnails for a clip. Concurrency-safe: repeated
 * calls for the same clip share one job, and all ffmpeg work is serialized via
 * runExclusive so jobs for different clips can't corrupt each other's FS state.
 */
export function generateThumbnails(clip: ThumbnailSource): Promise<Thumbnail[]> {
  const cached = cache.get(clip.id);
  if (cached) return Promise.resolve(cached);

  const existing = inFlight.get(clip.id);
  if (existing) return existing;

  const job = (async (): Promise<Thumbnail[]> => {
    const ffmpeg = await loadFFmpeg();
    const duration = Math.max(clip.sourceDuration, 0.001);
    const count = thumbCount(duration);
    const rate = count / duration; // frames per second the fps filter targets
    const input = `tsrc_${clip.id}.mp4`;
    const pattern = `tmb_${clip.id}_%03d.jpg`;

    const thumbs = await runExclusive(async () => {
      await ffmpeg.writeFile(input, await fetchFile(clip.src));
      // fps resamples to ~`rate` fps; -frames:v caps the count; scale keeps AR.
      await ffmpeg.exec([
        '-i', input,
        '-vf', `fps=${rate.toFixed(6)},scale=160:-2`,
        '-frames:v', String(count),
        '-q:v', '5',
        pattern,
      ]);

      const out: Thumbnail[] = [];
      for (let i = 1; i <= count; i++) {
        const name = `tmb_${clip.id}_${String(i).padStart(3, '0')}.jpg`;
        try {
          const data = (await ffmpeg.readFile(name)) as Uint8Array;
          // Copy into a fresh ArrayBuffer-backed buffer for Blob (avoids the
          // SharedArrayBuffer-vs-ArrayBuffer typing mismatch).
          const buffer = data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
          ) as ArrayBuffer;
          const blob = new Blob([buffer], { type: 'image/jpeg' });
          // Frame i (1-based) sampled at ~ (i-1)/rate seconds into the source.
          out.push({ t: (i - 1) / rate, url: URL.createObjectURL(blob) });
          await ffmpeg.deleteFile(name);
        } catch {
          break; // fewer frames than requested — stop at the first gap
        }
      }
      try {
        await ffmpeg.deleteFile(input);
      } catch {
        /* best-effort cleanup */
      }
      return out;
    });

    cache.set(clip.id, thumbs);
    return thumbs;
  })();

  inFlight.set(clip.id, job);
  // Clear the in-flight slot whether it resolves or rejects (allow retry).
  job.finally(() => inFlight.delete(clip.id));
  return job;
}
