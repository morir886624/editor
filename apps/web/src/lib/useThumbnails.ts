import { useEffect, useState } from 'react';
import {
  generateThumbnails,
  getCachedThumbnails,
  type Thumbnail,
  type ThumbnailSource,
} from './thumbnails';
import { useFFmpegStore } from '../store/ffmpegStore';

/**
 * Returns the thumbnail frames for a clip, generating them lazily on first use.
 * Generation is keyed by clip id, so trimming (which produces a new clip object
 * but keeps the same id/src) does NOT trigger regeneration.
 */
export function useThumbnails(clip: ThumbnailSource): { thumbnails: Thumbnail[]; loading: boolean } {
  const [thumbnails, setThumbnails] = useState<Thumbnail[]>(
    () => getCachedThumbnails(clip.id) ?? [],
  );
  const [loading, setLoading] = useState(thumbnails.length === 0);
  const ensureLoaded = useFFmpegStore((s) => s.ensureLoaded);

  useEffect(() => {
    const cached = getCachedThumbnails(clip.id);
    if (cached) {
      setThumbnails(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    (async () => {
      await ensureLoaded();
      try {
        const result = await generateThumbnails(clip);
        if (!cancelled) {
          setThumbnails(result);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false); // leave whatever (none) we have
      }
    })();

    return () => {
      cancelled = true;
    };
    // Identity is the clip id + src; other fields (trim) must not retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, clip.src]);

  return { thumbnails, loading };
}
