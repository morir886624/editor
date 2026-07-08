import { useRef, useState } from 'react';
import { useImportClips } from '../lib/useImportClips';
import { useImportAudio } from '../lib/useImportAudio';
import { useEditorStore } from '../store/editorStore';
import { useExportStore } from '../store/exportStore';
import { useSplitStore } from '../store/splitStore';
import { useNoticeStore } from '../store/noticeStore';
import { useDockStore } from '../store/dockStore';
import { useThemeStore } from '../store/themeStore';
import { useDebugStore } from '../store/debugStore';
import { DOCK_PANELS, buildDefaultLayout, openDockPanel, toggleDockPanel } from './DockLayout';

/**
 * Middle zone. Import (Stage 2), Text (Stage 4), Audio (Stage 5), Export
 * (Stage 6), Shorts (stage 7 — batch-split a long video) and Split (cut the
 * clip under the playhead into two) are enabled.
 * Panels is the window menu of the dockable workspace: check = open (click
 * closes), uncheck = closed (click reopens next to its usual neighbors).
 */
export function Toolbar() {
  const { importFiles, importing } = useImportClips();
  const { importAudioFiles, importingAudio } = useImportAudio();
  const inputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const hasClips = useEditorStore((s) => s.clips.length > 0);
  const addTextOverlay = useEditorStore((s) => s.addTextOverlay);
  const setSelected = useEditorStore((s) => s.setSelected);
  const splitClip = useEditorStore((s) => s.splitClip);
  const pushNotice = useNoticeStore((s) => s.push);
  const openExport = useExportStore((s) => s.open);
  const openSplit = useSplitStore((s) => s.open);
  const dockApi = useDockStore((s) => s.api);
  const openPanelIds = useDockStore((s) => s.openPanelIds);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const debugOpen = useDebugStore((s) => s.open);
  const toggleDebug = useDebugStore((s) => s.toggle);

  // Panels dropdown: fixed-position so the toolbar's overflow-x can't clip it.
  const panelsBtnRef = useRef<HTMLButtonElement>(null);
  const [panelsMenuPos, setPanelsMenuPos] = useState<{ top: number; left: number } | null>(null);
  const togglePanelsMenu = () => {
    if (panelsMenuPos) {
      setPanelsMenuPos(null);
      return;
    }
    const rect = panelsBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPanelsMenuPos({
      top: rect.bottom + 6,
      left: Math.min(rect.left, Math.max(8, window.innerWidth - 188)),
    });
  };

  const addText = () => {
    const id = addTextOverlay(); // at the current playhead, default 3s
    setSelected(id);
  };

  const onSplit = () => {
    // Read the playhead lazily so the toolbar doesn't re-render every frame.
    const res = splitClip(useEditorStore.getState().playheadTime);
    if (!res.ok) pushNotice({ type: 'error', message: res.reason });
  };

  return (
    <nav className="toolbar" aria-label="Tools">
      <span className="toolbar__brand">
        <span className="toolbar__brand-mark" aria-hidden="true">Ed</span>
        Editor
      </span>
      <span className="toolbar__sep" aria-hidden="true" />

      <button
        type="button"
        className="toolbar__btn toolbar__btn--active"
        onClick={() => inputRef.current?.click()}
        disabled={importing}
      >
        {importing ? 'Importing…' : 'Import'}
      </button>
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

      <button
        type="button"
        className="toolbar__btn toolbar__btn--active"
        onClick={addText}
        disabled={!hasClips}
        title={hasClips ? 'Add a text overlay' : 'Import a clip first'}
      >
        Text
      </button>

      <button
        type="button"
        className="toolbar__btn toolbar__btn--active"
        onClick={() => audioInputRef.current?.click()}
        disabled={importingAudio}
        title="Add music or a voiceover track"
      >
        {importingAudio ? 'Importing…' : 'Audio'}
      </button>
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
        className={`toolbar__btn toolbar__btn--active ${openPanelIds.includes('media') ? 'toolbar__btn--active-state' : ''}`}
        onClick={() => dockApi && openDockPanel(dockApi, 'media')}
        disabled={!hasClips}
        title={hasClips ? 'Show the imported clips panel' : 'Import a clip first'}
      >
        Clips
      </button>

      <button
        type="button"
        className="toolbar__btn toolbar__btn--active"
        onClick={onSplit}
        disabled={!hasClips}
        title={hasClips ? 'Split the clip at the playhead' : 'Import a clip first'}
      >
        Split
      </button>

      <span className="toolbar__spacer" aria-hidden="true" />

      <button
        type="button"
        className="toolbar__btn toolbar__btn--active toolbar__btn--icon"
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>

      <button
        ref={panelsBtnRef}
        type="button"
        className={`toolbar__btn toolbar__btn--active ${panelsMenuPos ? 'toolbar__btn--active-state' : ''}`}
        onClick={togglePanelsMenu}
        title="Show or hide workspace panels"
      >
        Panels ▾
      </button>

      <button
        type="button"
        className="toolbar__btn toolbar__btn--active toolbar__btn--primary"
        onClick={openExport}
        disabled={!hasClips}
        title={hasClips ? 'Export the project as MP4' : 'Import a clip first'}
      >
        Export
      </button>

      {panelsMenuPos && (
        <>
          <div className="panelmenu__backdrop" onClick={() => setPanelsMenuPos(null)} />
          <div
            className="panelmenu__list"
            role="menu"
            aria-label="Workspace panels"
            style={{ top: panelsMenuPos.top, left: panelsMenuPos.left }}
          >
            {DOCK_PANELS.map((def) => {
              const isOpen = openPanelIds.includes(def.id);
              return (
                <button
                  key={def.id}
                  type="button"
                  className="panelmenu__item"
                  role="menuitemcheckbox"
                  aria-checked={isOpen}
                  onClick={() => dockApi && toggleDockPanel(dockApi, def.id)}
                >
                  <span className="panelmenu__check">{isOpen ? '✓' : ''}</span>
                  {def.title}
                </button>
              );
            })}
            <div className="panelmenu__sep" />
            <button
              type="button"
              className="panelmenu__item"
              role="menuitemcheckbox"
              aria-checked={debugOpen}
              onClick={toggleDebug}
            >
              <span className="panelmenu__check">{debugOpen ? '✓' : ''}</span>
              Store debug
            </button>
            <div className="panelmenu__sep" />
            <button
              type="button"
              className="panelmenu__item"
              onClick={() => {
                if (dockApi) buildDefaultLayout(dockApi);
                setPanelsMenuPos(null);
              }}
            >
              <span className="panelmenu__check" />
              Reset layout
            </button>
          </div>
        </>
      )}
    </nav>
  );
}
