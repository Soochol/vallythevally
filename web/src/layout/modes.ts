import { CASCADE_STEP, fitCanvas } from "./canvas/arrange";
import { keepHeadInArea, minWindowSize, toRatio, type Area } from "./canvas/geometry";
import { defaultDock, fitDock, type WindowList } from "./dock/fit";
import { layoutDock, type Size } from "./dock/geometry";
import type { WindowId } from "./kinds";
import type { CanvasPlacement, DockPlacement, Placement, Rect } from "./placement";

export type LayoutMode = "dock" | "canvas";
export type PlacementRoom = { dock: { area: Size; gap: number }; canvas: Area };

export function canvasFromDock(dock: DockPlacement, windows: WindowList, room: PlacementRoom): CanvasPlacement {
  const rects = new Map<WindowId, Rect>();
  const order: WindowId[] = [];
  for (const { group, rect } of layoutDock(dock.root, room.dock.area, room.dock.gap).groups) {
    const inactive = group.tabs.filter((id) => id !== group.active);
    inactive.forEach((id, index) => {
      const window = windows.find((candidate) => candidate.id === id);
      if (!window) return;
      const min = minWindowSize(window.kind);
      const offset = (index + 1) * CASCADE_STEP;
      const dx = Math.max(0, Math.min(offset, rect.w - min.w));
      const dy = Math.max(0, Math.min(offset, rect.h - min.h));
      rects.set(id, toRatio(keepHeadInArea({ x: rect.x + dx, y: rect.y + dy, w: rect.w - dx, h: rect.h - dy }, room.canvas), room.canvas));
      order.push(id);
    });
    rects.set(group.active, toRatio(keepHeadInArea(rect, room.canvas), room.canvas));
    order.push(group.active);
  }
  for (const float of dock.floats) {
    const rect = { x: float.rect.x * room.dock.area.w, y: float.rect.y * room.dock.area.h, w: float.rect.w * room.dock.area.w, h: float.rect.h * room.dock.area.h };
    rects.set(float.window, toRatio(keepHeadInArea(rect, room.canvas), room.canvas));
    order.push(float.window);
  }
  return { rects: Object.fromEntries(rects), order };
}

export function dockFromCanvas(canvas: CanvasPlacement, windows: WindowList): DockPlacement {
  const chartOrder = [...canvas.order].reverse();
  const charts = windows.filter((window) => window.kind === "chart").sort((a, b) => chartOrder.indexOf(a.id) - chartOrder.indexOf(b.id));
  const ordered = [...charts, ...windows.filter((window) => window.kind !== "chart")];
  const [first, ...rest] = ordered;
  return defaultDock(first ? [first, ...rest] : windows);
}

export function placementForMode(placement: Placement, windows: WindowList, target: LayoutMode, room: PlacementRoom): Placement {
  if (target === "dock") {
    const dock = placement.dock ? fitDock(placement.dock, windows) : placement.canvas ? dockFromCanvas(placement.canvas, windows) : defaultDock(windows);
    return dock === placement.dock ? placement : { ...placement, dock };
  }
  const canvas = placement.canvas ? fitCanvas(placement.canvas, windows, room.canvas) : canvasFromDock(fitDock(placement.dock, windows), windows, room);
  return canvas === placement.canvas ? placement : { ...placement, canvas };
}
