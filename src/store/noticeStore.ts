// ---------------------------------------------------------------------------
// Lightweight transient notices (toasts) for import feedback, guard
// rejections, and the "trimmed to 60s" notice. Auto-dismiss after a few
// seconds. Not part of the editor document.
// ---------------------------------------------------------------------------

import { create } from 'zustand';

export type NoticeType = 'info' | 'error' | 'success';

export interface Notice {
  id: string;
  type: NoticeType;
  message: string;
}

interface NoticeState {
  notices: Notice[];
  push: (notice: Omit<Notice, 'id'>) => void;
  dismiss: (id: string) => void;
}

const AUTO_DISMISS_MS = 5000;
let counter = 0;

export const useNoticeStore = create<NoticeState>((set) => ({
  notices: [],
  push: (notice) => {
    const id = `notice_${Date.now().toString(36)}_${counter++}`;
    set((s) => ({ notices: [...s.notices, { ...notice, id }] }));
    setTimeout(() => {
      set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
    }, AUTO_DISMISS_MS);
  },
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));
