import { useEffect, useRef, useState } from 'react';
import { PreviewArea } from './PreviewArea';
import { TimelineArea } from './TimelineArea';
import { DOCK_CONTENT } from './DockLayout';
import { useEditorStore } from '../store/editorStore';
import { useExportStore } from '../store/exportStore';
import { useSplitStore } from '../store/splitStore';
import { useThemeStore } from '../store/themeStore';
import { useImportClips } from '../lib/useImportClips';
import { useImportAudio } from '../lib/useImportAudio';

/**
 * Phone shell (≤768px, chosen by useIsMobile in App): a CapCut-style vertical
 * stack — top bar (undo/redo/export), preview, timeline, and a horizontally
 * scrollable tool bar at the bottom. Tool panels (the same components the
 * desktop dock hosts, via DOCK_CONTENT) open as bottom sheets over the
 * timeline, so the preview stays visible while editing.
 *
 * The dock CSS neutralization (.dock-body .texted { position: static … })
 * applies inside the sheets too — panels render inline with their floating
 * chrome and headers stripped; the sheet provides the header.
 */

type SheetId = 'media' | 'text' | 'audio' | 'effects' | 'crop' | 'transition' | 'frame';

const SHEET_TITLES: Record<SheetId, string> = {
  media: 'Clips',
  text: 'Text',
  audio: 'Audio',
  effects: 'Effects',
  crop: 'Crop',
  transition: 'Transition',
  frame: 'Frame',
};

export function MobileLayout() {
  const { importFiles, importing } = useImportClips();
  const { importAudioFiles, importingAudio } = useImportAudio();
  const inputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const hasClips = useEditorStore((s) => s.clips.length > 0);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const addTextOverlay = useEditorStore((s) => s.addTextOverlay);
  const setSelected = useEditorStore((s) => s.setSelected);
  const textSelected = useEditorStore((s) =>
    s.textOverlays.some((o) => o.id === s.selectedItemId),
  );
  const audioSelected = useEditorStore((s) =>
    s.audioTracks.some((a) => a.id === s.selectedItemId),
  );
  const selectedTransitionId = useEditorStore((s) => s.selectedTransitionId);
  const openExport = useExportStore((s) => s.open);
  const openSplit = useSplitStore((s) => s.open);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  const [sheet, setSheet] = useState<SheetId | null>(null);

  // Tapping a seam ◇ on the timeline is an explicit "edit this transition"
  // intent — surface the panel, since nothing is visible otherwise on mobile.
  useEffect(() => {
    if (selectedTransitionId) setSheet('transition');
  }, [selectedTransitionId]);

  const onText = () => {
    if (!hasClips) return;
    // With a text overlay selected, edit it; otherwise add one first (same
    // add-at-playhead behavior as the desktop toolbar) and open its editor.
    if (!textSelected) setSelected(addTextOverlay());
    setSheet('text');
  };

  const onAudio = () => {
    // Selected track → its inspector; nothing selected → pick a music file.
    if (audioSelected) setSheet('audio');
    else audioInputRef.current?.click();
  };

  const SheetContent = sheet ? DOCK_CONTENT[sheet] : null;

  return (
    <div className="mobile">
      <header className="mobile__top" aria-label="Editor bar">
        <span className="toolbar__brand">
          <span className="toolbar__brand-mark" aria-hidden="true">
            Ed
          </span>
        </span>
        <button
          type="button"
          className="mobile__topbtn"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo"
        >
          ↩
        </button>
        <button
          type="button"
          className="mobile__topbtn"
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo"
        >
          ↪
        </button>
        <button
          type="button"
          className="mobile__topbtn"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <span className="toolbar__spacer" aria-hidden="true" />
        <button
          type="button"
          className="toolbar__btn toolbar__btn--active"
          onClick={openSplit}
          title="Split a long video into shorts"
        >
          Shorts
        </button>
        <button
          type="button"
          className="toolbar__btn toolbar__btn--active toolbar__btn--primary"
          onClick={openExport}
          disabled={!hasClips}
        >
          Export
        </button>
      </header>

      <div className="mobile__preview">
        <PreviewArea />
      </div>

      <div className="mobile__timeline">
        <TimelineArea />
      </div>

      <nav className="mobile__tools" aria-label="Tools">
        <button
          type="button"
          className="mtool"
          onClick={() => inputRef.current?.click()}
          disabled={importing}
        >
          <span className="mtool__icon" aria-hidden="true">
            ＋
          </span>
          {importing ? 'Importing…' : 'Import'}
        </button>
        <button
          type="button"
          className="mtool"
          onClick={() => setSheet('media')}
          disabled={!hasClips}
        >
          <span className="mtool__icon" aria-hidden="true">
            🎞
          </span>
          Clips
        </button>
        <button type="button" className="mtool" onClick={onText} disabled={!hasClips}>
          <span className="mtool__icon" aria-hidden="true">
            T
          </span>
          Text
        </button>
        <button type="button" className="mtool" onClick={onAudio} disabled={importingAudio}>
          <span className="mtool__icon" aria-hidden="true">
            ♪
          </span>
          {importingAudio ? 'Importing…' : 'Audio'}
        </button>
        <button
          type="button"
          className="mtool"
          onClick={() => setSheet('effects')}
          disabled={!hasClips}
        >
          <span className="mtool__icon" aria-hidden="true">
            FX
          </span>
          Effects
        </button>
        <button
          type="button"
          className="mtool"
          onClick={() => setSheet('crop')}
          disabled={!hasClips}
        >
          <span className="mtool__icon" aria-hidden="true">
            ▣
          </span>
          Crop
        </button>
        <button
          type="button"
          className="mtool"
          onClick={() => setSheet('transition')}
          disabled={!hasClips}
        >
          <span className="mtool__icon" aria-hidden="true">
            ◆
          </span>
          Transition
        </button>
        <button type="button" className="mtool" onClick={() => setSheet('frame')}>
          <span className="mtool__icon" aria-hidden="true">
            ▢
          </span>
          Frame
        </button>
      </nav>

      <input
        ref={inputRef}
        type="file"
        accept=".mp4,.mov,video/mp4,video/quicktime"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) importFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept=".mp3,.wav,.aac,.m4a,audio/mpeg,audio/wav,audio/aac,audio/mp4"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) importAudioFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {sheet && SheetContent && (
        <>
          <div className="sheet__backdrop" onClick={() => setSheet(null)} />
          <div className="sheet" role="dialog" aria-label={SHEET_TITLES[sheet]}>
            <header className="sheet__header">
              <span className="sheet__grip" aria-hidden="true" />
              <strong className="sheet__title">{SHEET_TITLES[sheet]}</strong>
              <button
                type="button"
                className="sheet__close"
                onClick={() => setSheet(null)}
                aria-label="Close panel"
              >
                ✕
              </button>
            </header>
            <div className="sheet__body">
              <SheetContent />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
