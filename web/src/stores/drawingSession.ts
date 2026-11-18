import { create } from "zustand";
import type { Clip } from "../chart/drawings/clipboard";
import type { DrawingBody, DrawingTool } from "../chart/drawings/types";
import type { ModeId } from "../chart/drawings/gestures";
import type { WindowId } from "../layout/kinds";
import { useSelectionStore } from "./selection";

export type DrawingEditor = { kind: "settings" | "text"; original: DrawingBody; draft: DrawingBody };
export interface Popup { x: number; y: number; id: string | null; fromChart?: boolean }

export interface CellDrawing {
  selected: readonly string[];
  editor: DrawingEditor | null;
  popup: Popup | null;
  toolbarAt: { x: number; y: number } | null;
}

const EMPTY_CELL: CellDrawing = { selected: [], editor: null, popup: null, toolbarAt: null };

interface DrawingSession {
  tool: DrawingTool | null;
  mode: ModeId | null;
  pinnedTool: DrawingTool | null;
  clip: Clip | null;
  cells: Readonly<Partial<Record<WindowId, CellDrawing>>>;
  setTool(cellId: WindowId, tool: DrawingTool | null, pinned?: boolean): void;
  select(cellId: WindowId, ids: readonly string[], toggle?: boolean): void;
  patchCell(cellId: WindowId, patch: Partial<CellDrawing>): void;
  updateEditor(cellId: WindowId, change: (editor: DrawingEditor) => DrawingEditor): void;
  clearCells(): void;
}

export const cellDrawing = (state: Pick<DrawingSession, "cells">, cellId: WindowId): CellDrawing => state.cells[cellId] ?? EMPTY_CELL;

export const useDrawingSession = create<DrawingSession>()((set) => {
  const patch = (s: DrawingSession, cellId: WindowId, change: Partial<CellDrawing>) => ({ cells: { ...s.cells, [cellId]: { ...cellDrawing(s, cellId), ...change } } });
  return {
    tool: null, mode: null, pinnedTool: null, clip: null, cells: {},
    setTool: (cellId, tool, pinned = false) => set((s) => ({ tool, mode: null, pinnedTool: pinned ? tool : null, ...patch(s, cellId, { selected: [], popup: null }) })),
    select: (cellId, ids, toggle = false) => set((s) => {
      const current = cellDrawing(s, cellId).selected;
      return patch(s, cellId, { selected: toggle ? [...current.filter((id) => !ids.includes(id)), ...ids.filter((id) => !current.includes(id))] : ids });
    }),
    patchCell: (cellId, change) => set((s) => patch(s, cellId, change)),
    updateEditor: (cellId, change) => set((s) => {
      const editor = cellDrawing(s, cellId).editor;
      return editor ? patch(s, cellId, { editor: change(editor) }) : s;
    }),
    clearCells: () => set({ cells: {} }),
  };
});

useSelectionStore.subscribe((state, previous) => {
  if (state.activeCell === previous.activeCell) return;
  const session = useDrawingSession.getState();
  if (session.tool !== null || session.mode !== null || session.pinnedTool !== null) useDrawingSession.setState({ tool: null, mode: null, pinnedTool: null });
});
