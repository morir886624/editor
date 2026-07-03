// ---------------------------------------------------------------------------
// Waveform peak extraction, cached.
//
// decodeAudioData -> per-bucket max |sample| across all channels -> Float32Array
// of peaks (PEAKS_PER_SECOND buckets per second of audio, normalized to 0..1).
// Decoding a whole file is expensive, so:
//  - results are cached by the track's object URL (unique per import, and
//    stable across trim edits / undo, unlike the track id's row lifecycle);
//  - concurrent requests for the same URL share one in-flight promise
//    (StrictMode double-fire, multiple blocks of the same source).
// Decoding uses a throwaway OfflineAudioContext so it works before any user
// gesture without autoplay-policy warnings (see lib/audioContext.ts).
// ---------------------------------------------------------------------------

export const PEAKS_PER_SECOND = 30;

const cache = new Map<string, Float32Array>();
const inFlight = new Map<string, Promise<Float32Array>>();

/** Synchronous cache lookup so a re-mounted block can render immediately. */
export function cachedWaveform(src: string): Float32Array | null {
  return cache.get(src) ?? null;
}

export function getWaveformPeaks(src: string): Promise<Float32Array> {
  const hit = cache.get(src);
  if (hit) return Promise.resolve(hit);
  const pending = inFlight.get(src);
  if (pending) return pending;

  const promise = (async () => {
    const buf = await (await fetch(src)).arrayBuffer();
    // The 1-frame render length is irrelevant — we only use decodeAudioData.
    const decoder = new OfflineAudioContext(1, 1, 44100);
    const audio = await decoder.decodeAudioData(buf);

    const bucketCount = Math.max(1, Math.ceil(audio.duration * PEAKS_PER_SECOND));
    const peaks = new Float32Array(bucketCount);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const data = audio.getChannelData(ch);
      const perBucket = data.length / bucketCount;
      for (let i = 0; i < bucketCount; i++) {
        const start = Math.floor(i * perBucket);
        const end = Math.min(data.length, Math.floor((i + 1) * perBucket));
        let max = 0;
        for (let j = start; j < end; j++) {
          const v = Math.abs(data[j]);
          if (v > max) max = v;
        }
        if (max > peaks[i]) peaks[i] = max;
      }
    }

    // Normalize so quiet recordings still show a readable shape.
    let top = 0;
    for (let i = 0; i < peaks.length; i++) if (peaks[i] > top) top = peaks[i];
    if (top > 0.01) {
      for (let i = 0; i < peaks.length; i++) peaks[i] /= top;
    }

    cache.set(src, peaks);
    return peaks;
  })().finally(() => inFlight.delete(src));

  inFlight.set(src, promise);
  return promise;
}
