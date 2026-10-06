import { create } from 'zustand';

interface SettingsDialogStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useSettingsDialogStore = create<SettingsDialogStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
