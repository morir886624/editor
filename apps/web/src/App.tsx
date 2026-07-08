import { Toolbar } from './components/Toolbar';
import { DockLayout } from './components/DockLayout';
import { MobileLayout } from './components/MobileLayout';
import { DebugPanel } from './components/DebugPanel';
import { NoticeHost } from './components/NoticeHost';
import { InstallPrompt } from './components/InstallPrompt';
import { ExportDialog } from './components/ExportDialog';
import { SplitDialog } from './components/SplitDialog';
import { useOverlayHotkeys } from './lib/useOverlayHotkeys';
import { useIsMobile } from './lib/useIsMobile';

/**
 * App shell. Two layouts share the same store and panel components:
 * - Desktop: toolbar on top + the dockable workspace (DockLayout).
 * - Phone (≤768px): CapCut-style vertical shell (MobileLayout) — preview over
 *   timeline, bottom tool bar, panels as bottom sheets.
 * Only true overlays stay at app level — transient notices and the modal
 * dialogs (plus the floating debug panel, desktop-only).
 */
export default function App() {
  // Delete / Ctrl+D / undo-redo shortcuts — app-level so they work even when
  // the preview panel is closed or unfocused.
  useOverlayHotkeys();
  const isMobile = useIsMobile();

  return (
    <div className={'app ' + (isMobile ? 'app--mobile' : 'app--dock')}>
      {isMobile ? (
        <MobileLayout />
      ) : (
        <>
          <Toolbar />
          <div className="app__dock">
            <DockLayout />
          </div>
          <DebugPanel />
        </>
      )}
      <NoticeHost />
      <InstallPrompt />
      <ExportDialog />
      <SplitDialog />
    </div>
  );
}
