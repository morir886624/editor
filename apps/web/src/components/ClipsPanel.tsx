import { useEditorStore } from '../store/editorStore';
import { useNoticeStore } from '../store/noticeStore';
import { useThumbnails } from '../lib/useThumbnails';
import { useDraggablePanel } from '../lib/useDraggablePanel';
import { MAX_TIMELINE_DURATION } from '../lib/duration';
import { formatTime } from '../lib/timeline';
import type { Thumbnail } from '../lib/thumbnails';
import type { ImportedSource } from '../types';

interface ClipsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Piece {
  start: number; // window into the source (seconds)
  end: number;
}

/** Consecutive ≤60s windows covering the WHOLE source. */
function piecesOf(duration: number): Piece[] {
  const count = Math.max(1, Math.ceil(duration / MAX_TIMELINE_DURATION));
  const pieces: Piece[] = [];
  for (let i = 0; i < count; i++) {
    pieces.push({
      start: i * MAX_TIMELINE_DURATION,
      end: Math.min((i + 1) * MAX_TIMELINE_DURATION, duration),
    });
  }
  return pieces;
}

/**
 * Clips panel: the library of every imported video, presented as ALL of its
 * ≤60s pieces — not just what's on the timeline. Clicking a piece places it on
 * the timeline (guarded by the 60s cap); a piece already placed shows a badge
 * and clicking it selects the corresponding clip instead. Draggable by its
 * header. Opens automatically on the first import.
 */
export function ClipsPanel({ isOpen, onClose }: ClipsPanelProps) {
  const sources = useEditorStore((s) => s.sources);
  const { ref, onHeaderPointerDown } = useDraggablePanel<HTMLElement>('clips');

  if (!isOpen) return null;

  const totalPieces = sources.reduce((n, s) => n + piecesOf(s.duration).length, 0);

  return (
    <aside ref={ref} className="clips-panel" aria-label="Imported clips">
      <header className="clips-panel__header" onPointerDown={onHeaderPointerDown}>
        <strong>Imported Clips ({totalPieces})</strong>
        <button type="button" className="clips-panel__close" onClick={onClose} title="Close">
          ✕
        </button>
      </header>

      <div className="clips-panel__list">
        {sources.length === 0 ? (
          <div className="clips-panel__empty">No videos imported</div>
        ) : (
          sources.map((source) => <SourceSection key={source.id} source={source} />)
        )}
      </div>
    </aside>
  );
}

function SourceSection({ source }: { source: ImportedSource }) {
  // One thumbnail job per SOURCE (frames span the full file); each piece then
  // shows the cached frame nearest its own window.
  const { thumbnails, loading } = useThumbnails({
    id: source.id,
    src: source.url,
    sourceDuration: source.duration,
  });
  const pieces = piecesOf(source.duration);

  const nearestFrame = (piece: Piece): Thumbnail | null => {
    const mid = (piece.start + piece.end) / 2;
    let best: Thumbnail | null = null;
    for (const t of thumbnails) {
      if (!best || Math.abs(t.t - mid) < Math.abs(best.t - mid)) best = t;
    }
    return best;
  };

  return (
    <section className="clips-panel__source">
      <div className="clips-panel__source-name" title={source.fileName}>
        {source.fileName} · {formatTime(source.duration)} · {pieces.length} piece
        {pieces.length > 1 ? 's' : ''}
      </div>
      {pieces.map((piece, i) => (
        <PieceCard
          key={i}
          source={source}
          piece={piece}
          index={i}
          count={pieces.length}
          thumbUrl={nearestFrame(piece)?.url ?? null}
          loading={loading}
        />
      ))}
    </section>
  );
}

interface PieceCardProps {
  source: ImportedSource;
  piece: Piece;
  index: number;
  count: number;
  thumbUrl: string | null;
  loading: boolean;
}

function PieceCard({ source, piece, index, count, thumbUrl, loading }: PieceCardProps) {
  const clips = useEditorStore((s) => s.clips);
  const addClip = useEditorStore((s) => s.addClip);
  const replaceClip = useEditorStore((s) => s.replaceClip);
  const setSelected = useEditorStore((s) => s.setSelected);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const notify = useNoticeStore((s) => s.push);

  // The timeline clip made from this piece, if any: same source URL, trim
  // starting inside this window (a later re-trim keeps it matched to the
  // piece its start falls in).
  const placed = clips.find(
    (c) => c.src === source.url && c.inPoint >= piece.start && c.inPoint < piece.end,
  );

  // Select the clip and park the playhead on its first frame so the preview
  // shows the piece immediately.
  const focusClip = (clip: { id: string; position: number }) => {
    setSelected(clip.id);
    setPlayhead(clip.position);
  };

  const onClick = () => {
    if (placed) {
      focusClip(placed);
      return;
    }
    const input = {
      sourceFileName: count > 1 ? `${source.fileName} · ${index + 1}/${count}` : source.fileName,
      src: source.url,
      sourceDuration: source.duration,
      inPoint: piece.start,
      outPoint: piece.end,
    };
    // Another piece of the SAME source on the timeline means the user is
    // switching working piece — swap it in place (undo restores the old one).
    // Clips from other sources are never discarded silently: the 60s guard's
    // message tells the user to make room instead.
    const current = clips.find((c) => c.src === source.url);
    const result = current ? replaceClip(current.id, input) : addClip(input);
    if (!result.ok) {
      notify({ type: 'error', message: result.reason });
      return;
    }
    const created = useEditorStore
      .getState()
      .clips.find((c) => c.src === source.url && c.inPoint >= piece.start && c.inPoint < piece.end);
    if (created) focusClip(created);
    if (current) {
      notify({
        type: 'info',
        message: `Switched to piece ${index + 1}/${count} — undo to restore the previous piece.`,
      });
    }
  };

  return (
    <button
      type="button"
      className={'clip-card' + (placed ? ' clip-card--placed' : '')}
      onClick={onClick}
      title={
        placed
          ? 'Already on the timeline — click to select it'
          : 'Add this piece to the timeline'
      }
    >
      <div className="clip-card__thumbnail">
        {thumbUrl ? (
          <img src={thumbUrl} alt={`Piece ${index + 1} thumbnail`} />
        ) : (
          <div className="clip-card__placeholder">{loading ? 'Loading...' : '📹'}</div>
        )}
        <span className="clip-card__number">{index + 1}</span>
      </div>

      <div className="clip-card__info">
        <div className="clip-card__name">
          Piece {index + 1}/{count}
        </div>

        <div className="clip-card__duration">
          <span className="clip-card__label">Window:</span>
          <span className="clip-card__value">
            {formatTime(piece.start)} → {formatTime(piece.end)}
          </span>
        </div>

        <div className="clip-card__duration">
          <span className="clip-card__label">Duration:</span>
          <span className="clip-card__value">{formatTime(piece.end - piece.start)}</span>
        </div>

        {placed ? (
          <div className="clip-card__badge">✓ On timeline</div>
        ) : (
          <div className="clip-card__badge clip-card__badge--add">+ Add to timeline</div>
        )}
      </div>
    </button>
  );
}
