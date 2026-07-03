// ---------------------------------------------------------------------------
// FFmpeg.wasm singleton + lazy loader.
//
// The single-threaded core needs NO SharedArrayBuffer, so we do NOT require
// COOP/COEP cross-origin-isolation headers. The wasm core is loaded lazily on
// first need (thumbnails / export / split).
//
// The core is SELF-HOSTED in /public/ffmpeg (stage 7 — a flaky CDN load used
// to take the whole engine down), with the unpkg CDN kept as a fallback in
// case the local copy is missing from a deployment. Both are fetched through
// toBlobURL so the worker can import them regardless of origin.
// ---------------------------------------------------------------------------

import { FFmpeg } from '@ffmpeg/ffmpeg';

// @ffmpeg/ffmpeg 0.12.15 pairs with @ffmpeg/core 0.12.9.
const CORE_VERSION = '0.12.9';
const LOCAL_BASE = `${import.meta.env.BASE_URL}ffmpeg`; // /public/ffmpeg/*
const CDN_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

/** Helper to fetch with a timeout */
async function fetchWithTimeout(url: string, timeout = 60000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Helper to fetch and convert to blob URL with timeout */
async function fetchBlobURL(url: string): Promise<string> {
  try {
    console.log(`[FFmpeg] Fetching ${url}...`);
    const response = await fetchWithTimeout(url, 120000); // 2-minute timeout for large files
    const blob = await response.blob();
    console.log(`[FFmpeg] Got blob, size: ${blob.size} bytes`);
    return URL.createObjectURL(blob);
  } catch (e) {
    console.error(`[FFmpeg] Fetch error for ${url}:`, e);
    throw e;
  }
}

/** The shared FFmpeg instance (created on first access, not yet loaded). */
export function getFFmpeg(): FFmpeg {
  if (!ffmpeg) ffmpeg = new FFmpeg();
  return ffmpeg;
}

/**
 * Load the wasm core if it isn't already. Safe to call repeatedly — the
 * in-flight/loaded promise is reused, so the core is fetched exactly once.
 * Tries the self-hosted copy first, then the CDN; a failed attempt can leave
 * the instance's worker wedged, so each attempt starts from a fresh instance.
 */
export function loadFFmpeg(): Promise<FFmpeg> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (ffmpeg?.loaded) return ffmpeg;
    let lastError: unknown = null;
    for (const base of [LOCAL_BASE, CDN_BASE]) {
      const instance = getFFmpeg();
      try {
        console.log(`[FFmpeg] Loading from ${base}...`);
        const coreJS = await fetchBlobURL(`${base}/ffmpeg-core.js`);
        const coreWasm = await fetchBlobURL(`${base}/ffmpeg-core.wasm`);
        console.log(`[FFmpeg] Got blob URLs, loading instance...`);
        await instance.load({
          coreURL: coreJS,
          wasmURL: coreWasm,
        });
        console.log(`[FFmpeg] ✓ Successfully loaded from ${base}`);
        return instance;
      } catch (e) {
        lastError = e;
        console.error(`[FFmpeg] Failed to load from ${base}:`, e);
        try {
          instance.terminate();
        } catch {
          /* never started */
        }
        ffmpeg = null;
      }
    }
    console.error(`[FFmpeg] All load attempts failed. Last error:`, lastError);
    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to load the video engine.');
  })();
  // If the load fails, clear the cached promise so a later call can retry.
  loadPromise.catch(() => {
    loadPromise = null;
  });
  return loadPromise;
}

/**
 * Kill the wasm worker and forget the instance (used to cancel an export).
 * Any in-flight exec rejects; the MEMFS dies with the worker. The next
 * loadFFmpeg() call fetches and boots a fresh core.
 */
export function resetFFmpeg(): void {
  if (ffmpeg) {
    try {
      ffmpeg.terminate();
    } catch {
      /* already dead */
    }
  }
  ffmpeg = null;
  loadPromise = null;
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
