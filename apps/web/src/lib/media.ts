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

// Audio: MP3 / WAV / AAC (and .m4a, the common AAC container). MIME reporting
// varies wildly across OSes, so extensions are checked too.
const ACCEPTED_AUDIO_MIME = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/aac',
  'audio/mp4',
  'audio/x-m4a',
];
const ACCEPTED_AUDIO_EXT = ['.mp3', '.wav', '.aac', '.m4a'];

/** True for MP3 / WAV / AAC audio files (by MIME or extension). */
export function isAcceptedAudioFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    ACCEPTED_AUDIO_MIME.includes(file.type) ||
    ACCEPTED_AUDIO_EXT.some((ext) => name.endsWith(ext))
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

export interface AudioMeta {
  url: string; // object URL (caller owns revoking on rejection)
  duration: number; // seconds
}

/**
 * Read an audio file's true duration via a hidden <audio> element, with the
 * same seek-to-end workaround as readVideoMeta for sources that report
 * `duration === Infinity` (common for VBR MP3s).
 */
export function readAudioMeta(file: File): Promise<AudioMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';

    const finish = () => {
      resolve({ url, duration: audio.duration });
    };

    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) {
        finish();
        return;
      }
      audio.ontimeupdate = () => {
        audio.ontimeupdate = null;
        finish();
        audio.currentTime = 0;
      };
      audio.currentTime = Number.MAX_SAFE_INTEGER;
    };

    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read "${file.name}". Is it a valid audio file?`));
    };

    audio.src = url;
  });
}
