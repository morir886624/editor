import { PreviewArea } from './components/PreviewArea';
import { Toolbar } from './components/Toolbar';
import { TimelineArea } from './components/TimelineArea';
import { DebugPanel } from './components/DebugPanel';
import { NoticeHost } from './components/NoticeHost';
import { TextEditorPanel } from './components/TextEditorPanel';

/**
 * App shell: three stacked zones (preview / toolbar / timeline), the floating
 * debug panel, transient notices, and the text-overlay editor (shown when a
 * text overlay is selected).
 */
export default function App() {
  return (
    <div className="app">
      <PreviewArea />
      <Toolbar />
      <TimelineArea />
      <DebugPanel />
      <NoticeHost />
      <TextEditorPanel />
    </div>
  );
}
