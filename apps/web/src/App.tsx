import { Toolbar } from './components/Toolbar';
import { DockLayout } from './components/DockLayout';
import { DebugPanel } from './components/DebugPanel';
import { NoticeHost } from './components/NoticeHost';
import { ExportDialog } from './components/ExportDialog';
import { SplitDialog } from './components/SplitDialog';

/**
 * App shell: the toolbar on top and the dockable workspace filling the rest.
 * Every editor area (preview, timeline, media, inspectors, export) lives as a
 * Dockview panel inside DockLayout; only true overlays stay at app level —
 * the floating debug panel, transient notices, and the modal dialogs.
 */
export default function App() {
  return (
    <div className="app app--dock">
      <Toolbar />
      <div className="app__dock">
        <DockLayout />
      </div>
      <DebugPanel />
      <NoticeHost />
      <ExportDialog />
      <SplitDialog />
    </div>
  );
}
