import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewHeaderActionsProps,
  type IDockviewReactProps,
  type IWatermarkPanelProps,
  type SerializedDockview,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { PreviewArea } from './PreviewArea';
import { TimelineArea } from './TimelineArea';
import { TextEditorPanel } from './TextEditorPanel';
import { EffectsPanel } from './EffectsPanel';
import { AudioPanel } from './AudioPanel';
import { TransitionPanel } from './TransitionPanel';
import { FramePanel } from './FramePanel';
import { ClipsPanel } from './ClipsPanel';
import { useEditorStore } from '../store/editorStore';
import { useExportStore } from '../store/exportStore';
import { useDockStore } from '../store/dockStore';
import { MAX_TIMELINE_DURATION, computeTotalDuration } from '../lib/duration';
import { formatTime } from '../lib/timeline';

/**
 * Dockable workspace (Dockview). Every editor area is a panel inside one
 * workspace: panels drag-dock to any edge, merge into tab groups, float
 * (shift+drag a tab), and resize via splitters. The wrapped components are
 * unchanged — they keep reading/writing the same store, so moving a panel
 * never touches editing state.
 *
 * The selection-driven inspectors (Text/Effects/Audio/Transition) return null
 * without a selection, so each dock wrapper checks the same store condition
 * and shows a placeholder instead of an empty panel.
 *
 * The layout persists to localStorage (debounced on every layout change) and
 * restores on load; "Reset layout" rebuilds the default. Collapsing a panel
 * (– on its tab) parks it as a chip in a compact horizontal bar above the
 * grid; the chip (or the Panels menu) expands it back where it was.
 */

function Placeholder({ children }: { children: string }) {
  return <div className="dock-placeholder">{children}</div>;
}

const noop = () => {};

function PreviewDock() {
  return (
    <div className="dock-body dock-body--preview">
      <PreviewArea />
    </div>
  );
}

function TimelineDock() {
  return (
    <div className="dock-body dock-body--scroll">
      <TimelineArea />
    </div>
  );
}

function MediaDock() {
  // Always open inside its dock panel; the dockview tab replaces the panel's
  // own header (hidden in CSS), so onClose has nothing to do.
  return (
    <div className="dock-body dock-body--scroll">
      <ClipsPanel isOpen onClose={noop} />
    </div>
  );
}

function TextDock() {
  const hasSelection = useEditorStore((s) =>
    s.textOverlays.some((o) => o.id === s.selectedItemId),
  );
  if (!hasSelection) {
    return <Placeholder>Select a text overlay on the timeline — or add one with the Text tool.</Placeholder>;
  }
  return (
    <div className="dock-body dock-body--scroll">
      <TextEditorPanel />
    </div>
  );
}

function EffectsDock() {
  const hasSelection = useEditorStore((s) =>
    s.clips.some((c) => c.id === s.selectedItemId),
  );
  if (!hasSelection) {
    return <Placeholder>Select a clip on the timeline to edit its effects, color and speed.</Placeholder>;
  }
  return (
    <div className="dock-body dock-body--scroll">
      <EffectsPanel />
    </div>
  );
}

function AudioDock() {
  const hasSelection = useEditorStore((s) =>
    s.audioTracks.some((a) => a.id === s.selectedItemId),
  );
  if (!hasSelection) {
    return <Placeholder>Select an audio track on the timeline — or add one with the Audio tool.</Placeholder>;
  }
  return (
    <div className="dock-body dock-body--scroll">
      <AudioPanel />
    </div>
  );
}

function TransitionDock() {
  const hasSelection = useEditorStore((s) => {
    const index = s.clips.findIndex((c) => c.id === s.selectedTransitionId);
    return index >= 0 && index < s.clips.length - 1;
  });
  if (!hasSelection) {
    return <Placeholder>Select a seam between two clips to edit its transition.</Placeholder>;
  }
  return (
    <div className="dock-body dock-body--scroll">
      <TransitionPanel />
    </div>
  );
}

function FrameDock() {
  // Project-level (no selection needed): always shows the frame editor.
  return (
    <div className="dock-body dock-body--scroll">
      <FramePanel />
    </div>
  );
}

function ExportDock() {
  const clips = useEditorStore((s) => s.clips);
  const openExport = useExportStore((s) => s.open);
  const total = computeTotalDuration(clips);

  return (
    <div className="dock-body dock-body--scroll">
      <div className="dock-export">
        <div className="dock-export__row">
          <span>Clips</span>
          <em>{clips.length}</em>
        </div>
        <div className="dock-export__row">
          <span>Duration</span>
          <em>
            {formatTime(total)} / {formatTime(MAX_TIMELINE_DURATION)}
          </em>
        </div>
        <button
          type="button"
          className="dock-export__btn"
          onClick={openExport}
          disabled={clips.length === 0}
          title={clips.length ? 'Export the project as MP4' : 'Import a clip first'}
        >
          Export MP4…
        </button>
        <p className="dock-export__hint">
          Resolution, aspect and quality are chosen in the export dialog.
        </p>
      </div>
    </div>
  );
}

// Stable module-level map: Dockview re-mounts panels if this object identity
// changes between renders.
const components: IDockviewReactProps['components'] = {
  preview: PreviewDock,
  timeline: TimelineDock,
  media: MediaDock,
  text: TextDock,
  effects: EffectsDock,
  audio: AudioDock,
  transition: TransitionDock,
  frame: FrameDock,
  export: ExportDock,
};

export interface DockPanelDef {
  id: string;
  title: string;
  /** Preferred neighbor when (re)opened; used only while that panel is open. */
  referencePanel?: string;
  referenceDirection?: 'left' | 'right' | 'above' | 'below' | 'within';
  /** Fallback: dock against the whole grid when the neighbor is closed. */
  gridDirection?: 'left' | 'right' | 'above' | 'below';
  initialWidth?: number;
  initialHeight?: number;
  minimumWidth?: number;
  minimumHeight?: number;
  /** 'always' keeps the DOM alive while hidden behind another tab (video/thumbnails). */
  renderer?: 'always';
}

/**
 * One definition per panel: id doubles as the component key, and the position
 * fields encode where the panel belongs — both for the default layout (adding
 * them in array order recreates it) and for reopening a single closed panel
 * next to its usual neighbors.
 */
export const DOCK_PANELS: DockPanelDef[] = [
  {
    id: 'preview',
    title: 'Preview',
    minimumWidth: 240,
    minimumHeight: 160,
    renderer: 'always',
  },
  {
    id: 'media',
    title: 'Media',
    referencePanel: 'preview',
    referenceDirection: 'left',
    gridDirection: 'left',
    initialWidth: 300,
    minimumWidth: 200,
    minimumHeight: 120,
  },
  {
    id: 'effects',
    title: 'Effects',
    referencePanel: 'preview',
    referenceDirection: 'right',
    gridDirection: 'right',
    initialWidth: 300,
    minimumWidth: 220,
    minimumHeight: 120,
  },
  {
    id: 'text',
    title: 'Text',
    referencePanel: 'effects',
    referenceDirection: 'within',
    gridDirection: 'right',
    initialWidth: 300,
    minimumWidth: 220,
    minimumHeight: 120,
  },
  {
    id: 'audio',
    title: 'Audio',
    referencePanel: 'effects',
    referenceDirection: 'within',
    gridDirection: 'right',
    initialWidth: 300,
    minimumWidth: 220,
    minimumHeight: 120,
  },
  {
    id: 'transition',
    title: 'Transition',
    referencePanel: 'effects',
    referenceDirection: 'within',
    gridDirection: 'right',
    initialWidth: 300,
    minimumWidth: 220,
    minimumHeight: 120,
  },
  {
    id: 'frame',
    title: 'Frame',
    referencePanel: 'effects',
    referenceDirection: 'within',
    gridDirection: 'right',
    initialWidth: 300,
    minimumWidth: 220,
    minimumHeight: 120,
  },
  {
    id: 'export',
    title: 'Export',
    referencePanel: 'effects',
    referenceDirection: 'within',
    gridDirection: 'right',
    initialWidth: 300,
    minimumWidth: 220,
    minimumHeight: 120,
  },
  // No reference = relative to the whole grid → a full-width bottom row.
  {
    id: 'timeline',
    title: 'Timeline',
    gridDirection: 'below',
    initialHeight: 300,
    minimumHeight: 140,
    renderer: 'always',
  },
];

// Where a collapsed panel was living, so expanding puts it back in the same
// group at the same tab index (session-scoped; persisted reopen falls back to
// the panel's default neighbors).
const collapseAnchors = new Map<string, { groupId: string; index: number }>();

/**
 * Open a closed/collapsed panel, or focus it if already open. Placement
 * priority: the exact group it was collapsed from → its preferred neighbor →
 * the grid edge from its definition.
 */
export function openDockPanel(api: DockviewApi, id: string) {
  const store = useDockStore.getState();
  if (store.collapsedPanelIds.includes(id)) {
    store.setCollapsedPanelIds(store.collapsedPanelIds.filter((x) => x !== id));
  }

  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const def = DOCK_PANELS.find((d) => d.id === id);
  if (!def) return;

  const common = {
    id: def.id,
    component: def.id,
    title: def.title,
    minimumWidth: def.minimumWidth,
    minimumHeight: def.minimumHeight,
    renderer: def.renderer,
  };

  const anchor = collapseAnchors.get(id);
  if (anchor && api.getGroup(anchor.groupId)) {
    collapseAnchors.delete(id);
    api.addPanel({
      ...common,
      position: { referenceGroup: anchor.groupId, index: anchor.index },
    });
    return;
  }
  collapseAnchors.delete(id);

  const neighborOpen = def.referencePanel && api.getPanel(def.referencePanel);
  api.addPanel({
    ...common,
    position: neighborOpen
      ? { referencePanel: def.referencePanel!, direction: def.referenceDirection }
      : def.gridDirection
        ? { direction: def.gridDirection }
        : undefined,
    initialWidth: def.initialWidth,
    initialHeight: def.initialHeight,
  });
}

/** Window-menu semantics: checked → close, unchecked → reopen. */
export function toggleDockPanel(api: DockviewApi, id: string) {
  const panel = api.getPanel(id);
  if (panel) api.removePanel(panel);
  else openDockPanel(api, id);
}

/**
 * Collapse-to-header: remove the panel from the grid but park it as a chip in
 * the horizontal bar; remember its group + tab index so expanding restores it
 * in place.
 */
export function collapsePanel(api: DockviewApi, id: string) {
  const panel = api.getPanel(id);
  if (!panel) return;
  collapseAnchors.set(id, {
    groupId: panel.group.id,
    index: Math.max(0, panel.group.panels.indexOf(panel)),
  });
  api.removePanel(panel);
  const store = useDockStore.getState();
  if (!store.collapsedPanelIds.includes(id)) {
    store.setCollapsedPanelIds([...store.collapsedPanelIds, id]);
  }
}

/** Default Adobe-style arrangement; also the "Reset layout" target. */
export function buildDefaultLayout(api: DockviewApi) {
  collapseAnchors.clear();
  useDockStore.getState().setCollapsedPanelIds([]);
  api.clear();
  for (const def of DOCK_PANELS) openDockPanel(api, def.id);
  api.getPanel('effects')?.api.setActive();
}

/* ---- persistence --------------------------------------------------------- */

const STORAGE_KEY = 'editor.dock.workspace.v1';

interface PersistedWorkspace {
  layout: SerializedDockview;
  collapsed: string[];
}

let saveTimer: number | undefined;

function scheduleSave(api: DockviewApi) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const data: PersistedWorkspace = {
        layout: api.toJSON(),
        collapsed: useDockStore.getState().collapsedPanelIds,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Persistence is best-effort (quota, private mode…): the session still works.
    }
  }, 400);
}

/** Restore the saved workspace; false = first run or unusable data. */
function restoreWorkspace(api: DockviewApi): boolean {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw) as PersistedWorkspace;
    const known = new Set(DOCK_PANELS.map((d) => d.id));
    const panelIds = Object.keys(data.layout?.panels ?? {});
    // Empty layout or panels from an older schema: fall back to the default.
    if (panelIds.length === 0) return false;
    if (!panelIds.every((pid) => known.has(pid))) return false;
    api.fromJSON(data.layout);
    useDockStore
      .getState()
      .setCollapsedPanelIds(
        (data.collapsed ?? []).filter((pid) => known.has(pid) && !api.getPanel(pid)),
      );
    return true;
  } catch {
    localStorage.removeItem(STORAGE_KEY); // corrupt: never wedge startup on it
    return false;
  }
}

/* ---- chrome: custom tab, group actions, watermark ------------------------ */

const stopTabDrag = (e: ReactPointerEvent | ReactMouseEvent) => e.stopPropagation();

/** Tab = title + collapse-to-header + close. Drag/activate stays on the wrapper. */
function DockTab(props: IDockviewPanelHeaderProps) {
  return (
    <div className="dock-tab">
      <span className="dock-tab__title">{props.api.title ?? props.api.id}</span>
      <span className="dock-tab__actions">
        <button
          type="button"
          className="dock-tab__btn"
          title="Collapse to header bar"
          onPointerDown={stopTabDrag}
          onMouseDown={stopTabDrag}
          onClick={(e) => {
            e.stopPropagation();
            collapsePanel(props.containerApi, props.api.id);
          }}
        >
          –
        </button>
        <button
          type="button"
          className="dock-tab__btn"
          title="Close panel"
          onPointerDown={stopTabDrag}
          onMouseDown={stopTabDrag}
          onClick={(e) => {
            e.stopPropagation();
            props.api.close();
          }}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/** Right side of each group header: maximize / restore the group. */
function GroupActions(props: IDockviewHeaderActionsProps) {
  const [isMaximized, setIsMaximized] = useState(() => props.api.isMaximized());
  useEffect(() => {
    const disposable = props.containerApi.onDidMaximizedGroupChange(() =>
      setIsMaximized(props.api.isMaximized()),
    );
    setIsMaximized(props.api.isMaximized());
    return () => disposable.dispose();
  }, [props.api, props.containerApi]);

  return (
    <div className="dock-groupactions">
      <button
        type="button"
        className="dock-tab__btn"
        title={isMaximized ? 'Restore group' : 'Maximize group'}
        onClick={() =>
          props.api.isMaximized() ? props.api.exitMaximized() : props.api.maximize()
        }
      >
        {isMaximized ? '⤡' : '⤢'}
      </button>
    </div>
  );
}

/** Shown when the workspace (or a group) has no panels. */
function Watermark(props: IWatermarkPanelProps) {
  return (
    <div className="dock-watermark">
      <p>No panels here.</p>
      <p>
        Reopen panels from the toolbar's <strong>Panels ▾</strong> menu, or
      </p>
      <button
        type="button"
        className="dock-export__btn"
        onClick={() => buildDefaultLayout(props.containerApi)}
      >
        Reset layout
      </button>
    </div>
  );
}

/* ---- the workspace -------------------------------------------------------- */

export function DockLayout() {
  const api = useDockStore((s) => s.api);
  const collapsedIds = useDockStore((s) => s.collapsedPanelIds);

  const onReady = (event: DockviewReadyEvent) => {
    const readyApi = event.api;
    // Publish the api + keep the open-panel list in sync for the Panels menu.
    const sync = () =>
      useDockStore.getState().setOpenPanelIds(readyApi.panels.map((p) => p.id));
    readyApi.onDidAddPanel(sync);
    readyApi.onDidRemovePanel(sync);
    useDockStore.getState().setApi(readyApi);
    if (!restoreWorkspace(readyApi)) buildDefaultLayout(readyApi);
    sync();
    // Registered after restore/build: every later change (drag, resize, tabs,
    // collapse/expand — those also add/remove panels) schedules a save.
    readyApi.onDidLayoutChange(() => scheduleSave(readyApi));
  };

  return (
    <div className="dock-workspace">
      {collapsedIds.length > 0 && (
        <div className="dock-collapsed-bar" aria-label="Collapsed panels">
          {collapsedIds.map((id) => {
            const def = DOCK_PANELS.find((d) => d.id === id);
            if (!def) return null;
            return (
              <button
                key={id}
                type="button"
                className="dock-chip"
                title="Expand panel"
                onClick={() => api && openDockPanel(api, id)}
              >
                <span className="dock-chip__arrow">▸</span>
                {def.title}
              </button>
            );
          })}
        </div>
      )}
      <div className="dock-workspace__grid">
        <DockviewReact
          className="dock-root"
          theme={themeDark}
          components={components}
          defaultTabComponent={DockTab}
          rightHeaderActionsComponent={GroupActions}
          watermarkComponent={Watermark}
          onReady={onReady}
          floatingGroupBounds="boundedWithinViewport"
        />
      </div>
    </div>
  );
}
