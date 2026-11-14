import { create } from "zustand";
import type { Clip } from "../chart/drawings/clipboard";
import type { DrawingBody, DrawingTool } from "../chart/drawings/types";
import type { ModeId } from "../chart/drawings/gestures";
import type { WindowId } from "../layout/kinds";

export type DrawingEditor = { kind: "settings" | "text"; original: DrawingBody; draft: DrawingBody };
export interface Popup { cellId: WindowId; x: number; y: number; id: string | null; fromChart?: boolean }

interface DrawingSession {
  tool: DrawingTool | null;
  mode: ModeId | null;
  pinnedTool: DrawingTool | null;
  selected: readonly string[];
  clip: Clip | null;
  editor: DrawingEditor | null;
  popup: Popup | null;
  toolbarAt: { x: number; y: number } | null;
  setTool(tool: DrawingTool | null, pinned?: boolean): void;
  select(ids: readonly string[], toggle?: boolean): void;
}

export const useDrawingSession = create<DrawingSession>()((set) => ({
  tool: null, mode: null, pinnedTool: null, selected: [], clip: null, editor: null, popup: null,
  toolbarAt: null,
  setTool: (tool, pinned = false) => set({ tool, mode: null, pinnedTool: pinned ? tool : null, selected: [], popup: null }),
  select: (ids, toggle = false) => set((s) => ({ selected: toggle ? [...s.selected.filter((id) => !ids.includes(id)), ...ids.filter((id) => !s.selected.includes(id))] : ids })),
}));
