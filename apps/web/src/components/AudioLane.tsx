import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useEditorStore } from '../store/editorStore';
import { MAX_TIMELINE_DURATION } from '../lib/duration';
import { secondsToPx, pxToSeconds, formatTime } from '../lib/timeline';
import { audioTrackDuration } from '../lib/audio';
import { PEAKS_PER_SECOND, cachedWaveform, getWaveformPeaks } from '../lib/waveform';
import type { AudioTrack } from '../types';

const MIN_AUDIO_DURATION = 0.2; // seconds
const WAVE_HEIGHT = 28; // canvas pixel height inside the block

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

type DragMode = 'move' | 'left' | 'right';

// --- waveform ---------------------------------------------------------------

/** Resolve cached peaks synchronously, else compute async (null meanwhile).
 *  `src` is stable for a block's lifetime (blocks are keyed by track id), so
 *  the initial-state cache read covers the sync path. */
function useWaveform(src: string): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(() => cachedWaveform(src));
  useEffect(() => {
    let on = true;
    getWaveformPeaks(src)
      .then((p) => {
        if (on) setPeaks(p);
      })
      .catch(() => {
        // Decode failed (unsupported codec) — show an empty strip; the block
        // stays fully usable for trim/move/volume.
        if (on) setPeaks(new Float32Array(0));
      });
    return () => {
      on = false;
    };
  }, [src]);
  return peaks;
}

/** Draws the peaks that fall inside [inPoint, outPoint] as vertical bars. */
function WaveformCanvas({
  peaks,
  inPoint,
  outPoint,
  width,
}: {
  peaks: Float32Array;
  inPoint: number;
  outPoint: number;
  width: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = Math.max(1, Math.round(width));
    canvas.width = w;
    canvas.height = WAVE_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, w, WAVE_HEIGHT);
    if (peaks.length === 0 || outPoint <= inPoint) return;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    const startIdx = inPoint * PEAKS_PER_SECOND;
    const span = (outPoint - inPoint) * PEAKS_PER_SECOND;
    const mid = WAVE_HEIGHT / 2;
    for (let x = 0; x < w; x++) {
      const idx = Math.min(peaks.length - 1, Math.floor(startIdx + (x / w) * span));
      const p = peaks[idx] ?? 0;
      const h = Math.max(1, p * (WAVE_HEIGHT - 2));
      ctx.fillRect(x, mid - h / 2, 1, h);
    }
  }, [peaks, inPoint, outPoint, width]);

  return <canvas ref={ref} className="audio-block__wave" aria-hidden="true" />;
}

// --- audio block ------------------------------------------------------------

function AudioBlock({ track }: { track: AudioTrack }) {
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const setSelected = useEditorStore((s) => s.setSelected);
  const updateAudioTrack = useEditorStore((s) => s.updateAudioTrack);
  const checkpoint = useEditorStore((s) => s.checkpoint);

  const peaks = useWaveform(track.src);
  const selected = track.id === selectedItemId;
  const dur = audioTrackDuration(track);
  const width = Math.max(secondsToPx(MIN_AUDIO_DURATION), secondsToPx(dur));

  const beginDrag = (e: ReactPointerEvent, mode: DragMode) => {
    e.stopPropagation(); // don't let the timeline scrub
    e.preventDefault();
    setSelected(track.id);

    const startX = e.clientX;
    const origIn = track.inPoint;
    const origOut = track.outPoint;
    const origOffset = track.offset;
    const origDur = origOut - origIn;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        checkpoint(); // one undo step per gesture
        moved = true;
      }
      const delta = pxToSeconds(ev.clientX - startX);
      let patch: Partial<AudioTrack>;
      if (mode === 'move') {
        const offset = clamp(
          origOffset + delta,
          0,
          Math.max(0, MAX_TIMELINE_DURATION - origDur),
        );
        patch = { offset };
      } else if (mode === 'left') {
        // Trim start: inPoint and offset shift together so the block's right
        // edge stays fixed in timeline time. Lower bound keeps both >= 0.
        const inPoint = clamp(
          origIn + delta,
          Math.max(0, origIn - origOffset),
          origOut - MIN_AUDIO_DURATION,
        );
        patch = { inPoint, offset: origOffset + (inPoint - origIn) };
      } else {
        // Trim end: bounded by the source length and the 60s ruler.
        const maxOut = Math.min(
          track.sourceDuration,
          origIn + (MAX_TIMELINE_DURATION - origOffset),
        );
        const outPoint = clamp(origOut + delta, origIn + MIN_AUDIO_DURATION, maxOut);
        patch = { outPoint };
      }
      updateAudioTrack(track.id, patch, { history: false });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className={'audio-block' + (selected ? ' audio-block--selected' : '')}
      style={{ left: secondsToPx(track.offset), width }}
      title={`${track.sourceFileName} · ${formatTime(dur)}`}
      onPointerDown={(e) => beginDrag(e, 'move')}
      onClick={(e) => {
        e.stopPropagation();
        setSelected(track.id);
      }}
    >
      {peaks === null ? (
        <div className="audio-block__loading" aria-hidden="true" />
      ) : (
        <WaveformCanvas
          peaks={peaks}
          inPoint={track.inPoint}
          outPoint={track.outPoint}
          width={width}
        />
      )}
      <span className="audio-block__label">{track.sourceFileName}</span>

      {selected && (
        <>
          <span
            className="audio-block__handle audio-block__handle--left"
            onPointerDown={(e) => beginDrag(e, 'left')}
          />
          <span
            className="audio-block__handle audio-block__handle--right"
            onPointerDown={(e) => beginDrag(e, 'right')}
          />
        </>
      )}
    </div>
  );
}

// --- lane -------------------------------------------------------------------

/**
 * The dedicated AUDIO track row on the timeline. Unlike the video track, it is
 * not gapless: each block sits at its own `offset` and can be dragged to move
 * in time and trimmed at either edge, with the same gesture UX as clips.
 */
export function AudioLane() {
  const audioTracks = useEditorStore((s) => s.audioTracks);

  return (
    <div className="audio-track">
      {audioTracks.length === 0 && <span className="audio-track__hint">Audio</span>}
      {audioTracks.map((t) => (
        <AudioBlock key={t.id} track={t} />
      ))}
    </div>
  );
}
