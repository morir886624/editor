import { useEditorStore } from '../store/editorStore';
import { useNoticeStore } from '../store/noticeStore';
import { useDraggablePanel } from '../lib/useDraggablePanel';
import { useThumbnails } from '../lib/useThumbnails';
import {
  ADJUSTMENT_RANGES,
  DEFAULT_ADJUSTMENTS,
  FILTER_PRESETS,
  SPEED_OPTIONS,
  presetCssFilter,
} from '../lib/effects';
import { EFFECT_OPTIONS, grainTextureUrl } from '../lib/videoEffects';
import { clipDuration } from '../lib/duration';
import type { Clip, ClipAdjustments, ClipEffect } from '../types';

/**
 * Effects editor for the selected clip: filter presets, manual color
 * adjustments, playback speed, and original-audio mute. All values are stored
 * as data on the clip (never baked into media) so stage 6 can reproduce them
 * at export. Sliders follow the checkpoint + { history: false } gesture
 * pattern; speed is guarded by the store's uniform 60s check. Reuses the
 * .texted panel styles.
 */
export function EffectsPanel() {
  const clips = useEditorStore((s) => s.clips);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const updateClip = useEditorStore((s) => s.updateClip);
  const setSelected = useEditorStore((s) => s.setSelected);
  const checkpoint = useEditorStore((s) => s.checkpoint);
  const notify = useNoticeStore((s) => s.push);
  const { ref, onHeaderPointerDown } = useDraggablePanel<HTMLElement>('texted');

  const clip = clips.find((c) => c.id === selectedItemId);
  if (!clip) return null;

  const id = clip.id;
  const adj = clip.adjustments;

  // live edit during a slider gesture (no per-tick history)
  const liveAdjust = (patch: Partial<ClipAdjustments>) =>
    updateClip(id, { adjustments: patch }, { history: false });

  const setSpeed = (speed: number) => {
    const res = updateClip(id, { speed });
    if (!res.ok) notify({ type: 'error', message: res.reason });
  };

  const isNeutral =
    adj.brightness === DEFAULT_ADJUSTMENTS.brightness &&
    adj.contrast === DEFAULT_ADJUSTMENTS.contrast &&
    adj.saturation === DEFAULT_ADJUSTMENTS.saturation &&
    adj.temperature === DEFAULT_ADJUSTMENTS.temperature;

  const slider = (
    label: string,
    key: keyof ClipAdjustments,
    format: (v: number) => string,
  ) => (
    <label className="texted__field texted__field--row">
      <span>{label}</span>
      <input
        type="range"
        min={ADJUSTMENT_RANGES[key].min}
        max={ADJUSTMENT_RANGES[key].max}
        step={ADJUSTMENT_RANGES[key].step}
        value={adj[key]}
        onPointerDown={checkpoint}
        onChange={(e) => liveAdjust({ [key]: Number(e.target.value) })}
      />
      <em>{format(adj[key])}</em>
    </label>
  );

  return (
    <aside ref={ref} className="texted" aria-label="Effects editor">
      <header className="texted__header" onPointerDown={onHeaderPointerDown}>
        <strong>Effects</strong>
        <button type="button" className="texted__close" onClick={() => setSelected(null)}>
          ✕
        </button>
      </header>

      <div className="texted__body">
        <div className="texted__field">
          <span>Clip</span>
          <div className="texted__filename" title={clip.sourceFileName}>
            {clip.sourceFileName} · {clipDuration(clip).toFixed(1)}s on timeline
          </div>
        </div>

        {/* filter presets: live swatch grid + intensity */}
        <FilterPresetGrid clip={clip} />

        {/* manual adjustments */}
        {slider('Bright', 'brightness', (v) => `${v}%`)}
        {slider('Contrast', 'contrast', (v) => `${v}%`)}
        {slider('Saturate', 'saturation', (v) => `${v}%`)}
        {slider('Temp', 'temperature', (v) => (v > 0 ? `+${v}` : `${v}`))}

        {!isNeutral && (
          <button
            type="button"
            className="texted__preset"
            onClick={() => updateClip(id, { adjustments: { ...DEFAULT_ADJUSTMENTS } })}
          >
            Reset adjustments
          </button>
        )}

        {/* playback speed — guarded: slowing down grows the effective duration */}
        <div className="texted__field">
          <span>Speed</span>
          <div className="texted__presets texted__presets--four">
            {SPEED_OPTIONS.map((v) => (
              <button
                key={v}
                type="button"
                className={'texted__preset' + (clip.speed === v ? ' is-active' : '')}
                onClick={() => setSpeed(v)}
              >
                {v}x
              </button>
            ))}
          </div>
        </div>

        {/* original audio */}
        <label className="texted__field texted__field--row">
          <span>Mute clip audio</span>
          <input
            type="checkbox"
            checked={clip.audioMuted}
            onChange={(e) => updateClip(id, { audioMuted: e.target.checked })}
          />
        </label>

        {/* trending effects (stage 8) */}
        <TrendingEffects clip={clip} />
      </div>
    </aside>
  );
}

/**
 * Filter-preset grid: one chip per preset showing the clip's frame nearest
 * the CURRENT playhead with that preset's CSS filter applied — a live "what
 * would this look do here" swatch (swatches always show full strength).
 * Below it, an intensity slider (0–100%) blends the applied preset toward the
 * original; picking a preset resets intensity to 100. Blending happens at op
 * level in clipColorOps(), so the preview <video> and the export follow the
 * slider identically.
 */
function FilterPresetGrid({ clip }: { clip: Clip }) {
  const updateClip = useEditorStore((s) => s.updateClip);
  const checkpoint = useEditorStore((s) => s.checkpoint);
  const playheadTime = useEditorStore((s) => s.playheadTime);
  const { thumbnails } = useThumbnails(clip);

  // frame nearest the playhead's source time within this clip (thumbnail t is
  // in SOURCE seconds; timeline seconds advance 1/speed as fast as source)
  const sourceT = Math.min(
    clip.outPoint,
    Math.max(clip.inPoint, clip.inPoint + (playheadTime - clip.position) * clip.speed),
  );
  let thumb: string | null = null;
  let best = Infinity;
  for (const t of thumbnails) {
    const d = Math.abs(t.t - sourceT);
    if (d < best) {
      best = d;
      thumb = t.url;
    }
  }

  return (
    <>
      <div className="texted__field">
        <span>Filter</span>
        <div className="fxchips">
          {FILTER_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={'fxchip' + (clip.filter === p.id ? ' is-active' : '')}
              onClick={() => updateClip(clip.id, { filter: p.id, filterIntensity: 100 })}
            >
              <span className="fxchip__thumb">
                {thumb ? (
                  <img src={thumb} alt="" style={{ filter: presetCssFilter(p.id) }} />
                ) : (
                  <i className="fxchip__empty">📹</i>
                )}
              </span>
              <span className="fxchip__label">{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      {clip.filter !== 'none' && (
        <label className="texted__field texted__field--row">
          <span>Strength</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={clip.filterIntensity}
            onPointerDown={checkpoint}
            onChange={(e) =>
              updateClip(clip.id, { filterIntensity: Number(e.target.value) }, { history: false })
            }
          />
          <em>{clip.filterIntensity}%</em>
        </label>
      )}
    </>
  );
}

/**
 * Stage-8 trending-effect section: a chip grid (with the clip's own thumbnail
 * styled as a live preview of each effect) to ADD effects, plus one editor row
 * per applied effect (intensity, optional time window, zoom direction).
 */
function TrendingEffects({ clip }: { clip: Clip }) {
  const addClipEffect = useEditorStore((s) => s.addClipEffect);
  const { thumbnails } = useThumbnails(clip);
  const thumb = thumbnails.find((t) => t.t >= clip.inPoint)?.url ?? thumbnails[0]?.url ?? null;

  return (
    <>
      <div className="texted__field">
        <span>Trending effects</span>
        <div className="fxchips">
          {EFFECT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className="fxchip"
              title={opt.hint}
              onClick={() => addClipEffect(clip.id, opt.id)}
            >
              <span className={`fxchip__thumb fxchip__thumb--${opt.id}`}>
                {thumb ? <img src={thumb} alt="" /> : <i className="fxchip__empty">📹</i>}
                {(opt.id === 'vignette' || opt.id === 'flash') && <i className="fxchip__veil" />}
                {opt.id === 'grain' && (
                  <i
                    className="fxchip__veil fxchip__veil--grain"
                    style={{ backgroundImage: `url(${grainTextureUrl()})` }}
                  />
                )}
              </span>
              <span className="fxchip__label">{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {clip.effects.map((fx) => (
        <EffectRow key={fx.id} clip={clip} fx={fx} />
      ))}
    </>
  );
}

function EffectRow({ clip, fx }: { clip: Clip; fx: ClipEffect }) {
  const updateClipEffect = useEditorStore((s) => s.updateClipEffect);
  const removeClipEffect = useEditorStore((s) => s.removeClipEffect);
  const checkpoint = useEditorStore((s) => s.checkpoint);

  const duration = clipDuration(clip);
  const label = EFFECT_OPTIONS.find((o) => o.id === fx.type)?.label ?? fx.type;
  // live edit during a slider gesture (no per-tick history)
  const live = (patch: Partial<Omit<ClipEffect, 'id' | 'type'>>) =>
    updateClipEffect(clip.id, fx.id, patch, { history: false });

  // Empty field = bound follows the clip edge (undefined in the store).
  const setBound = (key: 'start' | 'end', raw: string) => {
    let v: number | undefined;
    if (raw !== '') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      v = Math.min(duration, Math.max(0, n));
    }
    updateClipEffect(clip.id, fx.id, key === 'start' ? { start: v } : { end: v });
  };

  return (
    <div className="fxrow">
      <div className="fxrow__head">
        <strong>{label}</strong>
        <button
          type="button"
          className="texted__close"
          title="Remove effect"
          onClick={() => removeClipEffect(clip.id, fx.id)}
        >
          ✕
        </button>
      </div>

      <label className="texted__field texted__field--row">
        <span>Strength</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={fx.intensity}
          onPointerDown={checkpoint}
          onChange={(e) => live({ intensity: Number(e.target.value) })}
        />
        <em>{fx.intensity}</em>
      </label>

      {fx.type === 'zoom' && (
        <div className="texted__field">
          <span>Direction</span>
          <div className="texted__presets">
            {(['in', 'out'] as const).map((d) => (
              <button
                key={d}
                type="button"
                className={'texted__preset' + ((fx.direction ?? 'in') === d ? ' is-active' : '')}
                onClick={() => updateClipEffect(clip.id, fx.id, { direction: d })}
              >
                {d === 'in' ? 'Zoom in' : 'Zoom out'}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="texted__field">
        <span>
          Window (s within clip, 0–{duration.toFixed(1)} — empty = whole clip
          {fx.type === 'flash' ? '; the burst fires at the start' : ''})
        </span>
        <div className="fxrow__range">
          <input
            className="modal__number"
            type="number"
            min={0}
            max={duration}
            step={0.1}
            placeholder="0"
            value={fx.start ?? ''}
            onChange={(e) => setBound('start', e.target.value)}
          />
          <span>→</span>
          <input
            className="modal__number"
            type="number"
            min={0}
            max={duration}
            step={0.1}
            placeholder={duration.toFixed(1)}
            value={fx.end ?? ''}
            onChange={(e) => setBound('end', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
