// ---------------------------------------------------------------------------
// FFmpeg.wasm singleton + lazy loader.
//
// The single-threaded core needs NO SharedArrayBuffer, so we do NOT require
// COOP/COEP cross-origin-isolation headers. The wasm core is loaded lazily on
// first need (thumbnails / export / split).
//
// The core is SELF-HOSTED in /public/ffmpeg (stage 7 — a flaky CDN load used
// to take the whole engine down), with the unpkg CDN kept as a fallback in
// case the local copy is missing from a deployment. Both are fetched into
// blob URLs so the worker can import them regardless of origin.
//
// The core MUST be the ESM build (`dist/esm`), not UMD: @ffmpeg/ffmpeg spawns
// its worker with `type: "module"` (and vite.config.ts builds it as one), and
// a module worker can only pick the core up via `import()` — the UMD file
// defines no export and never reaches the worker's global scope, which
// surfaces as "failed to import ffmpeg-core.js". The local copy is named
// ffmpeg-core.esm.js so the year-long immutable cache on the old UMD
// /ffmpeg/ffmpeg-core.js can never serve a stale core.
// ---------------------------------------------------------------------------

import { FFmpeg } from '@ffmpeg/ffmpeg';

// @ffmpeg/ffmpeg 0.12.15 pairs with @ffmpeg/core 0.12.9.
const CORE_VERSION = '0.12.9';
const LOCAL_BASE = `${import.meta.env.BASE_URL}ffmpeg`; // /public/ffmpeg/*
const CDN_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

interface CoreSource {
  js: string;
  wasm: string;
}

const CORE_SOURCES: CoreSource[] = [
  { js: `${LOCAL_BASE}/ffmpeg-core.esm.js`, wasm: `${LOCAL_BASE}/ffmpeg-core.wasm` },
  { js: `${CDN_BASE}/ffmpeg-core.js`, wasm: `${CDN_BASE}/ffmpeg-core.wasm` },
];

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

/**
 * Helper to fetch and convert to blob URL with timeout. The MIME type is set
 * explicitly: `import()` of a blob URL fails unless the blob carries a
 * JavaScript type, and we can't trust every host's Content-Type mapping.
 */
async function fetchBlobURL(url: string, mimeType: string): Promise<string> {
  try {
    console.log(`[FFmpeg] Fetching ${url}...`);
    const response = await fetchWithTimeout(url, 120000); // 2-minute timeout for large files
    const blob = new Blob([await response.arrayBuffer()], { type: mimeType });
    console.log(`[FFmpeg] Got blob, size: ${blob.size} bytes`);
    return URL.createObjectURL(blob);
  } catch (e) {
    console.error(`[FFmpeg] Fetch error for ${url}:`, e);
    throw e;
  }
}

/**
 * The worker posts failures as plain strings (`e.toString()`), and a worker
 * that fails to even boot never settles load() at all — normalize both so the
 * UI can show a real message instead of the generic fallback.
 */
function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  const msg = typeof e === 'string' ? e : '';
  return new Error(msg || 'Failed to load the video engine.');
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
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
    for (const source of CORE_SOURCES) {
      const instance = getFFmpeg();
      try {
        console.log(`[FFmpeg] Loading from ${source.js}...`);
        const coreJS = await fetchBlobURL(source.js, 'text/javascript');
        const coreWasm = await fetchBlobURL(source.wasm, 'application/wasm');
        console.log(`[FFmpeg] Got blob URLs, loading instance...`);
        // The library attaches no error handler to its worker, so a worker
        // that fails to boot leaves load() pending forever — cap it.
        await withTimeout(
          instance.load({ coreURL: coreJS, wasmURL: coreWasm }),
          60000,
          'Video engine startup',
        );
        console.log(`[FFmpeg] ✓ Successfully loaded from ${source.js}`);
        return instance;
      } catch (e) {
        lastError = e;
        console.error(`[FFmpeg] Failed to load from ${source.js}:`, e);
        try {
          instance.terminate();
        } catch {
          /* never started */
        }
        ffmpeg = null;
      }
    }
    console.error(`[FFmpeg] All load attempts failed. Last error:`, lastError);
    throw toError(lastError);
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
