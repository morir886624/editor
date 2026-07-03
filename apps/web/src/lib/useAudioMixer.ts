import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { getAudioContext } from './audioContext';
import { audioGainAt, audioSourceTimeAt, audioTrackDuration } from './audio';

// Re-seek when the element drifts this far (seconds) from where the playhead
// says it should be — large enough to ignore normal jitter.
const DRIFT_TOLERANCE = 0.25;

interface TrackNodes {
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

/**
 * Preview audio mixer: plays each imported AudioTrack alongside the video,
 * driven entirely by the store's playheadTime (the same single source of
 * truth the video player uses).
 *
 * Per track: hidden <audio> -> MediaElementSource -> GainNode -> destination.
 * A rAF loop runs while isPlaying and, every frame, reconciles each element
 * against the playhead: start/seek it inside its audible window, pause it
 * outside, and set the gain from audioGainAt() — volume and fades are
 * therefore pure functions of the playhead, exactly like text overlays,
 * so they behave identically when seeking mid-fade.
 *
 * Nodes are created lazily from the play loop (i.e. after a user gesture),
 * which keeps the AudioContext out of the suspended/autoplay-blocked state.
 */
export function useAudioMixer() {
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const audioTracks = useEditorStore((s) => s.audioTracks);

  const nodesRef = useRef(new Map<string, TrackNodes>());
  const rafRef = useRef<number | null>(null);

  const dispose = (id: string) => {
    const n = nodesRef.current.get(id);
    if (!n) return;
    n.el.pause();
    n.source.disconnect();
    n.gain.disconnect();
    n.el.removeAttribute('src');
    nodesRef.current.delete(id);
  };

  // Drop nodes for tracks that were removed (their element must stop playing).
  useEffect(() => {
    const alive = new Set(audioTracks.map((t) => t.id));
    for (const id of [...nodesRef.current.keys()]) {
      if (!alive.has(id)) dispose(id);
    }
  }, [audioTracks]);

  // Full teardown on unmount.
  useEffect(() => {
    const nodes = nodesRef.current;
    return () => {
      for (const id of [...nodes.keys()]) dispose(id);
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      for (const n of nodesRef.current.values()) n.el.pause();
      return;
    }

    const ctx = getAudioContext();
    ctx.resume().catch(() => {});

    const ensure = (id: string, src: string): TrackNodes => {
      const existing = nodesRef.current.get(id);
      if (existing) return existing;
      const el = new Audio();
      el.src = src;
      el.preload = 'auto';
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(ctx.destination);
      const nodes: TrackNodes = { el, source, gain };
      nodesRef.current.set(id, nodes);
      return nodes;
    };

    const tick = () => {
      // Fresh state every frame — tracks/params may change mid-playback.
      const state = useEditorStore.getState();
      if (!state.isPlaying) return;
      const t = state.playheadTime;

      for (const track of state.audioTracks) {
        const n = ensure(track.id, track.src);
        const dur = audioTrackDuration(track);
        const local = t - track.offset;

        if (dur > 0 && local >= 0 && local < dur) {
          const target = audioSourceTimeAt(track, t);
          if (n.el.paused) {
            try {
              n.el.currentTime = target;
            } catch {
              // metadata not ready yet — play() below will start from ~0 and
              // the drift check re-seeks on a later frame.
            }
            n.el.play().catch(() => {});
          } else if (Math.abs(n.el.currentTime - target) > DRIFT_TOLERANCE) {
            try {
              n.el.currentTime = target;
            } catch {
              /* transient — retried next frame */
            }
          }
          // Small time constant smooths per-frame steps without lagging fades.
          n.gain.gain.setTargetAtTime(audioGainAt(track, t), ctx.currentTime, 0.03);
        } else if (!n.el.paused) {
          n.el.pause();
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying]);
}
