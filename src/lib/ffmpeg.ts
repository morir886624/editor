// ---------------------------------------------------------------------------
// FFmpeg.wasm singleton + lazy loader.
//
// Stage 2 uses FFmpeg ONLY to generate timeline thumbnails — no export yet.
// The wasm core is loaded lazily the first time a thumbnail is needed.
//
// We load the single-threaded @ffmpeg/core from a CDN via toBlobURL. The
// single-threaded core needs NO SharedArrayBuffer, so we do NOT require
// COOP/COEP cross-origin-isolation headers (which would, in fact, break the
// cross-origin CDN fetch). Known tradeoff: this makes the app require network
// access on first load; self-hosting the core in /public is a later option.
// ---------------------------------------------------------------------------

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

// @ffmpeg/ffmpeg 0.12.15 pairs with @ffmpeg/core 0.12.9.
const CORE_VERSION = '0.12.9';
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

/** The shared FFmpeg instance (created on first access, not yet loaded). */
export function getFFmpeg(): FFmpeg {
  if (!ffmpeg) ffmpeg = new FFmpeg();
  return ffmpeg;
}

/**
 * Load the wasm core if it isn't already. Safe to call repeatedly — the
 * in-flight/loaded promise is reused, so the core is fetched exactly once.
 */
export function loadFFmpeg(): Promise<FFmpeg> {
  if (loadPromise) return loadPromise;
  const instance = getFFmpeg();
  loadPromise = (async () => {
    if (!instance.loaded) {
      await instance.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      });
    }
    return instance;
  })();
  // If the load fails, clear the cached promise so a later call can retry.
  loadPromise.catch(() => {
    loadPromise = null;
  });
  return loadPromise;
}

// A single wasm instance can only run one command at a time; its virtual
// filesystem is shared global state. Serialize all exec/read/write sequences
// through this promise chain so concurrent thumbnail jobs can't interleave.
let chain: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn, fn);
  // Keep the chain alive even if a job rejects.
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
