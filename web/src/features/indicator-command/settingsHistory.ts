import type { ChartSettings } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";

export const SETTINGS_HISTORY_LIMIT = 50;
export const SETTINGS_COALESCE_MS = 700;

interface Marks { readonly steps: number; readonly drawings: ReadonlyMap<WindowId, number> }
interface Entry { readonly cellId: WindowId; readonly before: ChartSettings; after: ChartSettings; at: number; readonly marks: Marks }

export type UndoScope = { kind: "chart"; cellId: WindowId } | { kind: "workspace" } | { kind: "open" };

const past: Entry[] = [];
const future: Entry[] = [];
const drawingDepths = new Map<WindowId, () => number>();
let applying = false;

export function registerDrawingDepth(cellId: WindowId, depth: () => number): () => void {
  drawingDepths.set(cellId, depth);
  return () => { if (drawingDepths.get(cellId) === depth) drawingDepths.delete(cellId); };
}

const marksNow = (): Marks => ({
  steps: useLayoutStore.getState().steps.length,
  drawings: new Map([...drawingDepths].map(([cellId, depth]) => [cellId, depth()])),
});

export function clearSettingsHistory(): void {
  past.length = 0;
  future.length = 0;
}

export function recordSettingsChange(cellId: WindowId, before: ChartSettings, after: ChartSettings, now: number): void {
  future.length = 0;
  const top = past.at(-1);
  if (top && top.cellId === cellId && now - top.at < SETTINGS_COALESCE_MS) {
    top.after = after;
    top.at = now;
    return;
  }
  past.push({ cellId, before, after, at: now, marks: marksNow() });
  if (past.length > SETTINGS_HISTORY_LIMIT) past.shift();
}

function newerElsewhere(entry: Entry, scope: UndoScope): boolean {
  if (scope.kind === "open") return false;
  if (scope.kind === "workspace") return useLayoutStore.getState().steps.length > entry.marks.steps;
  const depth = drawingDepths.get(scope.cellId)?.() ?? 0;
  return depth > (entry.marks.drawings.get(scope.cellId) ?? 0);
}

function apply(cellId: WindowId, settings: ChartSettings): boolean {
  const store = useLayoutStore.getState();
  if (!chartWindows(store.layout).some((cell) => cell.id === cellId)) return false;
  applying = true;
  try { store.setChartSettings(cellId, settings); } finally { applying = false; }
  return true;
}

export function undoChartSettings(scope: UndoScope, redo = false): boolean {
  const from = redo ? future : past;
  const entry = from.at(-1);
  if (!entry || (!redo && newerElsewhere(entry, scope))) return false;
  from.pop();
  if (!apply(entry.cellId, redo ? entry.after : entry.before)) return true;
  (redo ? past : future).push({ ...entry, at: 0, marks: redo ? marksNow() : entry.marks });
  useSelectionStore.getState().showToast(redo ? "지표·차트 설정 변경을 다시 했습니다" : "지표·차트 설정 변경을 되돌렸습니다");
  return true;
}

export function watchChartSettings(now: () => number = () => performance.now()): () => void {
  return useLayoutStore.subscribe((state, prev) => {
    if (state.layout === prev.layout) return;
    if (state.session !== prev.session || state.layout.id !== prev.layout.id) return clearSettingsHistory();
    if (applying) return;
    const before = new Map(chartWindows(prev.layout).map((cell) => [cell.id, cell.chartSettings]));
    for (const cell of chartWindows(state.layout)) {
      const old = before.get(cell.id);
      if (old !== undefined && old !== cell.chartSettings) recordSettingsChange(cell.id, old, cell.chartSettings, now());
    }
  });
}

export const isUndoKey = (event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): "undo" | "redo" | null => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.code === "KeyZ") return event.shiftKey ? "redo" : "undo";
  return event.code === "KeyY" && !event.shiftKey ? "redo" : null;
};
