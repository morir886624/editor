// ---------------------------------------------------------------------------
// Platform seam. The editor is shared between the browser build (apps/web)
// and the Capacitor native shell (apps/mobile). Everything that differs
// between the two — how a finished file leaves the app, whether a PWA install
// banner makes sense, which layout to pick — goes through this one object.
//
// The web build never calls setPlatform(), so it keeps the browser defaults
// below and never bundles any native code. The mobile entry installs its
// native implementation BEFORE the first render (see apps/mobile/src/main.tsx),
// so reading it with getPlatform() during render is safe and stable.
// ---------------------------------------------------------------------------

/** A finished file (export result or split segment) ready to leave the app. */
export interface OutputFile {
  /** Object URL of the file (always present). */
  url: string;
  /** File name to save under, e.g. "edit-2026-10-06.mp4". */
  filename: string;
  /** The bytes, when the caller already holds them (avoids a re-fetch). */
  blob?: Blob;
}

export interface Platform {
  /** True inside the native (Capacitor) app. */
  readonly isNative: boolean;
  /** Label for the primary save action ("Download MP4" vs "Save to gallery"). */
  readonly saveLabel: string;
  /** Whether a native share sheet is available for output files. */
  readonly canShare: boolean;
  /** Persist output files where the user can find them (downloads / gallery). */
  saveFiles(files: OutputFile[]): Promise<void>;
  /** Open the system share sheet for output files (no-op when !canShare). */
  shareFiles(files: OutputFile[]): Promise<void>;
  /** Force the phone shell regardless of the CSS breakpoint (native phones). */
  prefersMobileLayout(): boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Browser defaults — identical to the editor's original behavior. */
const webPlatform: Platform = {
  isNative: false,
  saveLabel: 'Download',
  canShare: false,
  // Sequential <a download> clicks; the browser asks once to allow multiple
  // downloads. Small delay so clicks aren't coalesced.
  async saveFiles(files) {
    for (let i = 0; i < files.length; i++) {
      const a = document.createElement('a');
      a.href = files[i].url;
      a.download = files[i].filename;
      a.click();
      if (i < files.length - 1) await sleep(350);
    }
  },
  async shareFiles() {
    /* no share sheet on the web build */
  },
  prefersMobileLayout: () => false,
};

let current: Platform = webPlatform;

/** Install a platform implementation. Call once, before the first render. */
export function setPlatform(platform: Platform): void {
  current = platform;
}

export function getPlatform(): Platform {
  return current;
}
