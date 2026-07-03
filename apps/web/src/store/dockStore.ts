import { create } from 'zustand';
import type { DockviewApi } from 'dockview-react';

/**
 * Bridge between the Dockview workspace and the rest of the UI (the toolbar's
 * Panels menu, the collapsed-header bar). DockLayout publishes its api on
 * ready and keeps openPanelIds in sync via onDidAddPanel/onDidRemovePanel;
 * consumers subscribe to these lists for render state and call through `api`
 * for actions. Layout state itself stays inside Dockview — this store never
 * mirrors it. collapsedPanelIds are panels removed from the grid but parked
 * as header chips (both lists are persisted with the layout).
 */
interface DockState {
  api: DockviewApi | null;
  openPanelIds: string[];
  collapsedPanelIds: string[];
  setApi: (api: DockviewApi | null) => void;
  setOpenPanelIds: (ids: string[]) => void;
  setCollapsedPanelIds: (ids: string[]) => void;
}

export const useDockStore = create<DockState>((set) => ({
  api: null,
  openPanelIds: [],
  collapsedPanelIds: [],
  setApi: (api) => set({ api }),
  setOpenPanelIds: (openPanelIds) => set({ openPanelIds }),
  setCollapsedPanelIds: (collapsedPanelIds) => set({ collapsedPanelIds }),
}));
