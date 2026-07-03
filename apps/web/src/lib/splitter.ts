// ---------------------------------------------------------------------------
// "Split into shorts" engine (stage 7 pivot): cut ONE long source video into
// consecutive segments of a chosen length, WITHOUT re-encoding.
//
// Speed/precision tradeoff (user-chosen): `-c copy` remuxes the original
// packets, so a 50-minute file splits in roughly real-file-read time with
// zero quality loss — but each segment must start on a keyframe, so cut
// points snap to the nearest keyframe at-or-before the requested time
// (segments can overlap/deviate by up to one GOP, typically 1–4s).
//
// Memory strategy — the reason this works on multi-GB files:
//  - the source is NEVER copied into the wasm heap (which is capped ~2GB):
//    it is mounted read-only via WORKERFS, so the worker streams straight
//    from the File blob on demand;
//  - each segment gets its own exec (-ss K [-t L] -i src -c copy), is read
//    out of MEMFS as a Blob and deleted immediately — peak MEMFS usage is a
//    single segment (~tens of MB).
// ---------------------------------------------------------------------------

import { FFFSType } from '@ffmpeg/ffmpeg';
import { loadFFmpeg, runExclusive } from './ffmpeg';
import { readVideoMeta } from './media';
import type { CancelToken } from './exporter';

export class SplitCancelledError extends Error {
  constructor() {
    super('Split cancelled.');
    this.name = 'SplitCancelledError';
  }
}

export interface SplitSegment {
  index: number; // 0-based
  filename: string;
  /** The segment as a File — hand this to URL.createObjectURL for playback,
   *  download, or importing into the editor. */
  file: File;
  /** Object URL for download/preview. Owned by the split results list; a NEW
   *  url must be created when importing into the editor (clip URLs are never
   *  revoked, result URLs are revoked on the next run). */
  url: string;
  sizeBytes: number;
  duration: number; // measured real duration (seconds)
  requestedStart: number; // where in the source this segment was asked to start
}

export interface SplitProgress {
  phase: string;
  progress: number; // 0..1 overall
  segmentsDone: number;
  segmentsTotal: number;
}

const MOUNT_DIR = '/split-src';
const sec = (n: number) => Math.max(0, n).toFixed(3);

const fileExt = (name: string): string => {
  const m = /\.([a-z0-9]{2,4})$/i.exec(name);
  return m ? m[1].toLowerCase() : 'mp4';
};

/** Uint8Array (possibly SharedArrayBuffer-backed) -> plain ArrayBuffer copy. */
const toArrayBuffer = (data: Uint8Array): ArrayBuffer =>
  data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

/** How many segments a source of `duration` yields at `segmentLength`.
 *  A tail shorter than half a second folds into the last segment instead of
 *  becoming a blink-length short. */
export function planSegmentCount(duration: number, segmentLength: number): number {
  if (duration <= 0 || segmentLength <= 0) return 0;
  return Math.max(1, Math.ceil((duration - 0.5) / segmentLength));
}

/**
 * Cut `file` into segments of `segmentLength` seconds. Segments are streamed
 * to `onSegment` as they finish so the UI can list them live; the full list
 * is also returned. Cancellation follows the exporter pattern: flip the token
 * and resetFFmpeg() — the worker (and the WORKERFS mount) dies with it.
 */
export async function runSplit(
  file: File,
  sourceDuration: number,
  segmentLength: number,
  onProgress: (p: SplitProgress) => void,
  token: CancelToken,
  onSegment?: (segment: SplitSegment) => void,
): Promise<SplitSegment[]> {
  const count = planSegmentCount(sourceDuration, segmentLength);
  if (count === 0) throw new Error('This video has no duration to split.');

  const base = file.name.replace(/\.[a-z0-9]{2,4}$/i, '') || 'video';
  const src = `${MOUNT_DIR}/input.${fileExt(file.name)}`;
  const pad = String(count).length;

  const report = (phase: string, done: number, fracOfCurrent: number) =>
    onProgress({
      phase,
      progress: Math.min(1, (done + Math.min(1, Math.max(0, fracOfCurrent))) / count),
      segmentsDone: done,
      segmentsTotal: count,
    });

  return runExclusive(async () => {
    const ffmpeg = await loadFFmpeg();
    if (token.cancelled) throw new SplitCancelledError();

    let expectedOutSec = segmentLength;
    let done = 0;
    const onFFmpegProgress = ({ time }: { progress: number; time: number }) => {
      // `time` is the produced output timestamp in microseconds.
      report(`Cutting short ${done + 1}/${count}…`, done, time / 1e6 / expectedOutSec);
    };
    ffmpeg.on('progress', onFFmpegProgress);

    let mounted = false;
    const segments: SplitSegment[] = [];
    try {
      report('Opening the video…', 0, 0);
      // Read-only mount of the source blob — no copy into the wasm heap.
      await ffmpeg.createDir(MOUNT_DIR);
      await ffmpeg.mount(
        FFFSType.WORKERFS,
        { blobs: [{ name: `input.${fileExt(file.name)}`, data: file }] },
        MOUNT_DIR,
      );
      mounted = true;

      for (let k = 0; k < count; k++) {
        if (token.cancelled) throw new SplitCancelledError();
        done = k;
        const start = k * segmentLength;
        const isLast = k === count - 1;
        expectedOutSec = isLast ? Math.max(0.5, sourceDuration - start) : segmentLength;
        report(`Cutting short ${k + 1}/${count}…`, k, 0);

        const out = `seg_${k}.mp4`;
        // Input seek (-ss before -i) jumps to the keyframe at-or-before
        // `start` without reading the file up to it. The last segment omits
        // -t and runs to EOF so no tail is ever lost.
        const args = ['-ss', sec(start)];
        if (!isLast) args.push('-t', sec(segmentLength));
        args.push(
          '-i', src,
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          '-movflags', '+faststart',
          out,
        );
        const ret = await ffmpeg.exec(args);
        if (token.cancelled) throw new SplitCancelledError();
        if (ret !== 0) throw new Error(`Cutting short ${k + 1}/${count} failed.`);

        const data = (await ffmpeg.readFile(out)) as Uint8Array;
        await ffmpeg.deleteFile(out); // one segment in MEMFS at a time
        const filename = `${base}-short-${String(k + 1).padStart(pad, '0')}.mp4`;
        const segFile = new File([toArrayBuffer(data)], filename, { type: 'video/mp4' });

        // Real duration (keyframe snapping makes it deviate from the plan) —
        // also what the editor needs as sourceDuration when importing.
        const meta = await readVideoMeta(segFile);
        const segment: SplitSegment = {
          index: k,
          filename,
          file: segFile,
          url: meta.url,
          sizeBytes: segFile.size,
          duration: meta.duration,
          requestedStart: start,
        };
        segments.push(segment);
        onSegment?.(segment);
        report(`Cutting short ${k + 1}/${count}…`, k + 1, 0);
      }

      return segments;
    } finally {
      ffmpeg.off('progress', onFFmpegProgress);
      // On cancel the worker is already dead (resetFFmpeg) — nothing to clean.
      if (!token.cancelled && mounted) {
        try {
          await ffmpeg.unmount(MOUNT_DIR);
          await ffmpeg.deleteDir(MOUNT_DIR);
        } catch {
          /* best-effort */
        }
      }
    }
  });
}
