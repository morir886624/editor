// ---------------------------------------------------------------------------
// Global keyboard shortcuts for the editor (mounted once in App):
//  - Delete / Backspace  → remove the selected text overlay (unless locked)
//  - Ctrl/Cmd+D          → duplicate the selected text overlay
//  - Ctrl/Cmd+Z          → undo;  Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y → redo
// All of them stand down while the user is typing (inputs, textareas,
// selects, contenteditable) so native text editing keeps its own keys.
// ---------------------------------------------------------------------------

import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';

const isTypingTarget = (e: KeyboardEvent): boolean => {
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el?.isContentEditable;
};

export function useOverlayHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      const s = useEditorStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        s.undo();
        return;
      }
      if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        s.redo();
        return;
      }

      // The remaining shortcuts act on the SELECTED TEXT OVERLAY only —
      // selectedItemId is shared with clips/audio, so membership decides.
      const overlay = s.selectedItemId
        ? s.textOverlays.find((t) => t.id === s.selectedItemId)
        : undefined;
      if (!overlay) return;

      if (mod && key === 'd') {
        e.preventDefault(); // keep the browser's bookmark dialog closed
        s.duplicateTextOverlay(overlay.id);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (overlay.locked) return; // lock protects against stray deletes
        e.preventDefault();
        s.removeTextOverlay(overlay.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
