// ---------------------------------------------------------------------------
// Media file helpers: acceptance check + reading real video metadata.
// ---------------------------------------------------------------------------

// MOV reports as video/quicktime; some systems leave .mov files with an empty
// MIME type, so we accept by extension too.
const ACCEPTED_MIME = ['video/mp4', 'video/quicktime'];
const ACCEPTED_EXT = ['.mp4', '.mov'];

/** True for MP4 / MOV files (by MIME or extension). */
export function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    ACCEPTED_MIME.includes(file.type) || ACCEPTED_EXT.some((ext) => name.endsWith(ext))
  );
}

export interface VideoMeta {
  url: string; // object URL (kept for playback + ffmpeg; caller owns revoking)
  duration: number; // seconds
  width: number;
  height: number;
}

/**
 * Read a video's true duration/dimensions via a hidden <video> element.
 *
 * Some MP4/MOV files report `duration === Infinity` until the element is forced
 * to seek to the end — we apply the well-known seek-to-end workaround so we
 * always resolve with a finite duration.
 */
export function readVideoMeta(file: File): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const finish = () => {
      resolve({
        url,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };

    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration)) {
        finish();
        return;
      }
      // Force the browser to resolve the real duration, then reset.
      video.ontimeupdate = () => {
        video.ontimeupdate = null;
        finish();
        video.currentTime = 0;
      };
      video.currentTime = Number.MAX_SAFE_INTEGER;
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read "${file.name}". Is it a valid video?`));
    };

    video.src = url;
  });
}
