import { create } from "zustand";
import type { Clip } from "../chart/drawings/clipboard";
import type { DrawingBody, DrawingTool } from "../chart/drawings/types";

export type DrawingEditor = { kind: "settings" | "text"; original: DrawingBody; draft: DrawingBody };
export interface Popup { slot: number; x: number; y: number; id: string | null }

interface DrawingSession {
  tool: DrawingTool | null;
  pinnedTool: DrawingTool | null;
  selected: readonly string[];
  clip: Clip | null;
  editor: DrawingEditor | null;
  popup: Popup | null;
  panel: "watch" | "objects";
  toolbarAt: { x: number; y: number } | null;
  setTool(tool: DrawingTool | null, pinned?: boolean): void;
  select(ids: readonly string[], toggle?: boolean): void;
}

export const useDrawingSession = create<DrawingSession>()((set) => ({
  tool: null, pinnedTool: null, selected: [], clip: null, editor: null, popup: null,
  panel: "watch", toolbarAt: null,
  setTool: (tool, pinned = false) => set({ tool, pinnedTool: pinned ? tool : null, selected: [], popup: null }),
  select: (ids, toggle = false) => set((s) => ({ selected: toggle ? [...s.selected.filter((id) => !ids.includes(id)), ...ids.filter((id) => !s.selected.includes(id))] : ids })),
}));
