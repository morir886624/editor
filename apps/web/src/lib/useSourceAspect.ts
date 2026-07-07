import { useEffect, useState } from 'react';

/**
 * Width/height ratio of a video source (object URL), or null until its
 * metadata loads. Uses a throwaway metadata-only <video> — the blob is local,
 * so this resolves near-instantly and never touches the preview's A/B pair.
 * Needed because Clip does not store source pixel dimensions.
 */
export function useSourceAspect(src: string | undefined): number | null {
  // Result is tagged with the src it belongs to, so a src change reads as
  // null immediately (no synchronous reset in the effect) and a stale async
  // load can never leak onto the next source.
  const [loaded, setLoaded] = useState<{ src: string; aspect: number } | null>(null);

  useEffect(() => {
    if (!src) return;
    let alive = true;
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      if (alive && v.videoWidth && v.videoHeight) {
        setLoaded({ src, aspect: v.videoWidth / v.videoHeight });
      }
    };
    v.src = src;
    return () => {
      alive = false;
      v.removeAttribute('src');
      v.load();
    };
  }, [src]);

  return loaded && loaded.src === src ? loaded.aspect : null;
}
