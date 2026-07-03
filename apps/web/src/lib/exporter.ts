// ---------------------------------------------------------------------------
// Export pipeline (stage 6): bake the whole project into one MP4.
//
// Runs entirely in FFmpeg.wasm, sequentially and memory-conscious:
//   1. per clip  — write ONE source into MEMFS, render a normalized video
//      segment (trim -> speed via setpts -> fps -> cover-scale/crop -> color
//      ops -> yuv420p, x264) and a matching audio segment (trim -> atempo ->
//      48k stereo PCM wav; silence when muted/audioless), then DELETE the
//      source before the next clip;
//   2. join      — no transitions: concat losslessly (video: -c copy; audio:
//      PCM copy — PCM is gapless, avoiding AAC priming drift at clip seams);
//      with transitions: one xfade/acrossfade filter graph (concat filter at
//      hard-cut seams), which costs a second video encode;
//   3. overlays  — rasterize the text layer to adaptively-sampled transparent
//      PNGs (lib/overlayRaster.ts) and composite via one `overlay` filter;
//   4. audio mix — each imported track: atrim -> volume -> afade in/out ->
//      adelay to its timeline offset, then amix with the clip audio
//      (duration=first bounds everything to the video length);
//   5. mux       — H.264 + AAC, +faststart. Video is stream-copied when there
//      are no overlays to burn (no second generation loss).
//
// All timing derives from the same pure functions as the preview
// (clipDuration/segment math, computeOverlayMotion, audio fade windows), so
// the file matches what the player showed.
// ---------------------------------------------------------------------------

import { fetchFile } from '@ffmpeg/util';
import { loadFFmpeg, runExclusive } from './ffmpeg';
import { useEditorStore } from '../store/editorStore';
import {
  MAX_TIMELINE_DURATION,
  clipDuration,
  computeTotalDuration,
  effectiveTransitionDurations,
} from './duration';
import { clipColorOps } from './effects';
import {
  QUALITY_SETTINGS,
  atempoChain,
  colorOpFilters,
  exportDimensions,
  transitionAudioGraph,
  transitionVideoGraph,
  type ExportQuality,
  type SeamSpec,
} from './exportFilters';
import { planOverlaySamples, renderOverlayLayer } from './overlayRaster';
import type { AspectRatio, ExportResolution } from '../types';

export const EXPORT_FPS = 30;

export interface ExportOptions {
  resolution: ExportResolution;
  aspect: AspectRatio;
  quality: ExportQuality;
}

export interface ExportProgress {
  phase: string;
  /** Overall 0..1 across the whole pipeline. */
  progress: number;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

/** Cooperative cancellation: the UI flips `cancelled` and kills the worker. */
export interface CancelToken {
  cancelled: boolean;
}

export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'ExportCancelledError';
  }
}

const sec = (n: number) => Math.max(0, n).toFixed(4);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const fileExt = (name: string, fallback: string): string => {
  const m = /\.([a-z0-9]{2,4})$/i.exec(name);
  return m ? m[1].toLowerCase() : fallback;
};

/** Uint8Array (possibly SharedArrayBuffer-backed) -> plain ArrayBuffer copy. */
const toArrayBuffer = (data: Uint8Array): ArrayBuffer =>
  data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

export async function runExport(
  opts: ExportOptions,
  onProgress: (p: ExportProgress) => void,
  token: CancelToken,
): Promise<ExportResult> {
  // Snapshot the document once — the export renders this exact state.
  const { clips, textOverlays, audioTracks } = useEditorStore.getState();

  const total = computeTotalDuration(clips);
  if (clips.length === 0) throw new Error('Nothing to export — the timeline is empty.');
  if (total > MAX_TIMELINE_DURATION + 1e-6) {
    throw new Error(
      `The video is ${total.toFixed(1)}s — over the ${MAX_TIMELINE_DURATION}s limit. Trim it before exporting.`,
    );
  }

  const { width: W, height: H } = exportDimensions(opts.aspect, opts.resolution);
  const q = QUALITY_SETTINGS[opts.quality];
  const segDurs = clips.map(clipDuration);

  // Transition seams between segments (same clamped durations the preview
  // uses, so the xfade overlaps land exactly where the player showed them).
  const transDurs = effectiveTransitionDurations(clips);
  const seams: SeamSpec[] = transDurs.map((d, i) =>
    d > 0 ? { type: clips[i].transitionAfter!.type, duration: d } : null,
  );
  const hasTransitions = seams.some((s) => s !== null);

  const overlays = textOverlays.filter((o) => o.endTime > o.startTime && o.startTime < total);
  const overlaySamples = overlays.length ? planOverlaySamples(overlays, total, EXPORT_FPS) : [];
  const hasOverlays = overlaySamples.length > 0;

  const music = audioTracks.filter(
    (a) => a.outPoint > a.inPoint && a.offset < total && a.volume > 0,
  );

  // ---- progress plan (relative work units) ----
  const unitsPerClip = segDurs.map((d) => 0.4 + 3 * Math.max(d, 0.3) + 0.4 * Math.max(d, 0.1));
  // Joining with transitions re-encodes the full video through xfade; plain
  // concat is a cheap stream copy.
  const concatUnits = hasTransitions ? 3 * total + 0.5 : 0.6;
  const overlayGenUnits = overlaySamples.length * 0.05;
  const finalUnits = total * (hasOverlays ? 3 : 0.5) + music.length * 0.2 + 0.3;
  const totalUnits =
    unitsPerClip.reduce((a, b) => a + b, 0) + concatUnits + overlayGenUnits + finalUnits;

  let doneUnits = 0;
  let phase = 'Starting…';
  let stepUnits = 0; // units of the step currently running
  let stepOutSec = 0; // expected output seconds of the current exec (for progress events)

  const report = (fracOfStep: number) =>
    onProgress({ phase, progress: clamp01((doneUnits + stepUnits * clamp01(fracOfStep)) / totalUnits) });

  const beginStep = (label: string, units: number, expectedOutSec = 0) => {
    if (token.cancelled) throw new ExportCancelledError();
    phase = label;
    stepUnits = units;
    stepOutSec = expectedOutSec;
    report(0);
  };
  const endStep = () => {
    doneUnits += stepUnits;
    stepUnits = 0;
    report(0);
  };

  return runExclusive(async () => {
    const ffmpeg = await loadFFmpeg();
    const created = new Set<string>();

    const onFFmpegProgress = ({ time }: { progress: number; time: number }) => {
      // `time` is the produced output timestamp in microseconds.
      if (stepOutSec > 0) report(time / 1e6 / stepOutSec);
    };
    ffmpeg.on('progress', onFFmpegProgress);

    const write = async (name: string, data: Uint8Array | string) => {
      await ffmpeg.writeFile(
        name,
        typeof data === 'string' ? new TextEncoder().encode(data) : data,
      );
      created.add(name);
    };
    const remove = async (name: string) => {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        /* best-effort */
      }
      created.delete(name);
    };
    const exec = async (args: string[], failure: string) => {
      const ret = await ffmpeg.exec(args);
      if (token.cancelled) throw new ExportCancelledError();
      if (ret !== 0) throw new Error(failure);
    };

    try {
      // ---- 1. normalized segments, one source in memory at a time ----------
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const segDur = segDurs[i];
        const srcLen = clip.outPoint - clip.inPoint;
        const src = `xsrc_${i}.${fileExt(clip.sourceFileName, 'mp4')}`;
        const vseg = `xv_${i}.mp4`;
        const aseg = `xa_${i}.wav`;
        const n = `${i + 1}/${clips.length}`;

        beginStep(`Loading clip ${n}…`, 0.4);
        await write(src, await fetchFile(clip.src));
        endStep();

        beginStep(`Rendering clip ${n}…`, 3 * Math.max(segDur, 0.3), segDur);
        const vf = [
          `setpts=(PTS-STARTPTS)/${clip.speed.toFixed(6)}`,
          `fps=${EXPORT_FPS}`,
          `scale=${W}:${H}:force_original_aspect_ratio=increase`,
          `crop=${W}:${H}`,
          'setsar=1',
          ...colorOpFilters(clipColorOps(clip)),
          'format=yuv420p',
        ].join(',');
        await exec(
          [
            '-ss', sec(clip.inPoint), '-t', sec(srcLen), '-i', src,
            '-an',
            '-vf', vf,
            '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf),
            vseg,
          ],
          `Rendering clip ${i + 1} ("${clip.sourceFileName}") failed.`,
        );
        created.add(vseg);
        endStep();

        beginStep(`Preparing audio for clip ${n}…`, 0.4 * Math.max(segDur, 0.1), segDur);
        const silenceArgs = [
          '-f', 'lavfi', '-t', sec(segDur), '-i', 'anullsrc=r=48000:cl=stereo',
          '-c:a', 'pcm_s16le', aseg,
        ];
        if (clip.audioMuted) {
          await exec(silenceArgs, `Preparing audio for clip ${i + 1} failed.`);
        } else {
          const af = [
            'aresample=48000',
            ...atempoChain(clip.speed),
            'aformat=sample_fmts=s16:channel_layouts=stereo',
            'apad',
          ].join(',');
          const ret = await ffmpeg.exec([
            '-ss', sec(clip.inPoint), '-t', sec(srcLen), '-i', src,
            '-vn',
            '-af', af,
            '-t', sec(segDur), '-c:a', 'pcm_s16le', aseg,
          ]);
          if (token.cancelled) throw new ExportCancelledError();
          // Sources without an audio stream fail here — substitute silence so
          // the timeline audio stays aligned.
          if (ret !== 0) {
            await remove(aseg);
            await exec(silenceArgs, `Preparing audio for clip ${i + 1} failed.`);
          }
        }
        created.add(aseg);
        endStep();

        await remove(src); // free the (potentially large) source right away
      }

      // ---- 2. join segments -------------------------------------------------
      if (hasTransitions) {
        // Transitions overlap adjacent segments, so joining is a filter graph
        // (xfade / acrossfade at transition seams, concat at hard cuts) and the
        // video passes through x264 once more. Segment durations feed the
        // xfade offsets, mirroring the preview's overlap layout exactly.
        beginStep('Blending transitions…', concatUnits, total);
        await exec(
          [
            ...clips.flatMap((_, i) => ['-i', `xv_${i}.mp4`]),
            '-filter_complex', transitionVideoGraph(segDurs, seams),
            '-map', '[vout]',
            '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf),
            'xtl_v.mp4',
          ],
          'Blending the clip transitions failed.',
        );
        created.add('xtl_v.mp4');
        await exec(
          [
            ...clips.flatMap((_, i) => ['-i', `xa_${i}.wav`]),
            '-filter_complex', transitionAudioGraph(seams),
            '-map', '[aout]',
            '-c:a', 'pcm_s16le',
            'xtl_a.wav',
          ],
          'Blending the audio transitions failed.',
        );
        created.add('xtl_a.wav');
      } else {
        // No transitions: join losslessly with the concat demuxer.
        beginStep('Joining clips…', concatUnits, total);
        await write('xvlist.txt', clips.map((_, i) => `file xv_${i}.mp4`).join('\n'));
        await write('xalist.txt', clips.map((_, i) => `file xa_${i}.wav`).join('\n'));
        await exec(
          ['-f', 'concat', '-safe', '0', '-i', 'xvlist.txt', '-c', 'copy', 'xtl_v.mp4'],
          'Joining the video segments failed.',
        );
        created.add('xtl_v.mp4');
        await exec(
          ['-f', 'concat', '-safe', '0', '-i', 'xalist.txt', '-c', 'copy', 'xtl_a.wav'],
          'Joining the audio segments failed.',
        );
        created.add('xtl_a.wav');
      }
      for (let i = 0; i < clips.length; i++) {
        await remove(`xv_${i}.mp4`);
        await remove(`xa_${i}.wav`);
      }
      endStep();

      // ---- 3. rasterize the text overlay layer ------------------------------
      if (hasOverlays) {
        beginStep('Rendering text overlays…', overlayGenUnits);
        await document.fonts.ready; // same fonts the preview used
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not create a canvas for text overlays.');

        const pngBytes = () =>
          new Promise<Uint8Array>((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (!blob) {
                reject(new Error('Rendering a text overlay frame failed.'));
                return;
              }
              blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
            }, 'image/png');
          });

        let blankWritten = false;
        const listLines: string[] = [];
        let lastName = '';
        for (let k = 0; k < overlaySamples.length; k++) {
          if (token.cancelled) throw new ExportCancelledError();
          const s = overlaySamples[k];
          const drew = renderOverlayLayer(ctx, overlays, s.t, W, H);
          let name: string;
          if (drew) {
            name = `xov_${k}.png`;
            await write(name, await pngBytes());
          } else {
            name = 'xov_blank.png';
            if (!blankWritten) {
              ctx.clearRect(0, 0, W, H);
              await write(name, await pngBytes());
              blankWritten = true;
            }
          }
          listLines.push(`file ${name}`, `duration ${s.duration.toFixed(6)}`);
          lastName = name;
          report((k + 1) / overlaySamples.length);
        }
        // concat-demuxer quirk: repeat the last file so its duration counts.
        listLines.push(`file ${lastName}`);
        await write('xovlist.txt', listLines.join('\n'));
        endStep();
      }

      // ---- 4 + 5. audio mix + final mux --------------------------------------
      beginStep(hasOverlays ? 'Burning text + encoding…' : 'Mixing audio + muxing…', finalUnits, total);

      const args: string[] = ['-i', 'xtl_v.mp4', '-i', 'xtl_a.wav'];
      const ovIndex = hasOverlays ? 2 : -1;
      if (hasOverlays) args.push('-f', 'concat', '-safe', '0', '-i', 'xovlist.txt');

      const musicIndexBase = hasOverlays ? 3 : 2;
      for (let k = 0; k < music.length; k++) {
        const m = music[k];
        const name = `xmus_${k}.${fileExt(m.sourceFileName, 'mp3')}`;
        await write(name, await fetchFile(m.src));
        args.push('-i', name);
      }

      const graph: string[] = [];
      if (hasOverlays) {
        graph.push(
          `[0:v][${ovIndex}:v]overlay=x=0:y=0:eof_action=pass,format=yuv420p[vout]`,
        );
      }
      if (music.length > 0) {
        const mixIns: string[] = ['[1:a]'];
        music.forEach((m, k) => {
          const dur = m.outPoint - m.inPoint;
          const parts = [
            `atrim=start=${sec(m.inPoint)}:end=${sec(m.outPoint)}`,
            'asetpts=PTS-STARTPTS',
            'aresample=48000',
            'aformat=sample_fmts=fltp:channel_layouts=stereo',
            `volume=${m.volume.toFixed(4)}`,
          ];
          if (m.fadeIn > 0) parts.push(`afade=t=in:st=0:d=${sec(m.fadeIn)}`);
          if (m.fadeOut > 0) {
            parts.push(`afade=t=out:st=${sec(Math.max(0, dur - m.fadeOut))}:d=${sec(m.fadeOut)}`);
          }
          const delayMs = Math.round(m.offset * 1000);
          if (delayMs > 0) parts.push(`adelay=${delayMs}:all=1`);
          graph.push(`[${musicIndexBase + k}:a]${parts.join(',')}[m${k}]`);
          mixIns.push(`[m${k}]`);
        });
        // duration=first: the clip-audio track defines the length (= video);
        // normalize=0 keeps the volumes the user set instead of rescaling.
        graph.push(
          `${mixIns.join('')}amix=inputs=${mixIns.length}:duration=first:normalize=0[aout]`,
        );
      }
      if (graph.length > 0) args.push('-filter_complex', graph.join(';'));

      if (hasOverlays) {
        args.push('-map', '[vout]', '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf));
      } else {
        // No burn-in needed — keep the segment encode untouched (no extra
        // generation loss) and let this pass be fast.
        args.push('-map', '0:v', '-c:v', 'copy');
      }
      args.push('-map', music.length > 0 ? '[aout]' : '1:a', '-c:a', 'aac', '-b:a', '192k');
      args.push('-movflags', '+faststart', 'xout.mp4');

      await exec(args, 'Final encode failed.');
      created.add('xout.mp4');

      phase = 'Finishing…';
      report(1);
      const data = (await ffmpeg.readFile('xout.mp4')) as Uint8Array;
      const blob = new Blob([toArrayBuffer(data)], { type: 'video/mp4' });
      const filename = `export-${opts.aspect.replace(':', 'x')}-${opts.resolution}.mp4`;
      return { blob, filename };
    } finally {
      ffmpeg.off('progress', onFFmpegProgress);
      // If cancelled, the worker (and its whole MEMFS) is already gone.
      if (!token.cancelled) {
        for (const name of [...created]) {
          try {
            await ffmpeg.deleteFile(name);
          } catch {
            /* best-effort */
          }
        }
      }
    }
  });
}
