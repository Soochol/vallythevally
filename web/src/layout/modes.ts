import { CASCADE_STEP, fitCanvas } from "./canvas/arrange";
import { countOverlaps, keepHeadInArea, minWindowSize, toRatio, workArea, type Area } from "./canvas/geometry";
import { floatRects } from "./dock/floats";
import { defaultDock, fitDock, type StackRoom, type WindowList } from "./dock/fit";
import { drawDock, layoutDock, wholePixels, type Size } from "./dock/geometry";
import type { WindowId } from "./kinds";
import type { CanvasPlacement, DockPlacement, Placement, Rect } from "./placement";

export type LayoutMode = "dock" | "canvas";
export type PlacementRoom = { dock: { area: Size; gap: number }; canvas: Area };

export const TIDY_OVERLAP_LIMIT = 3;

const stackRoom = (room: PlacementRoom): StackRoom => {
  const px = wholePixels(room.dock);
  return { h: px.area.h, gap: px.gap };
};

export function canvasFromDock(dock: DockPlacement, windows: WindowList, room: PlacementRoom): CanvasPlacement {
  const rects = new Map<WindowId, Rect>();
  const order: WindowId[] = [];
  const drawn = drawDock(dock, { ...room.dock, windows }).dock;
  for (const { group, rect } of layoutDock(drawn.root, room.dock.area, room.dock.gap).groups) {
    const inactive = group.tabs.filter((id) => id !== group.active);
    inactive.forEach((id, index) => {
      const window = windows.find((candidate) => candidate.id === id);
      if (!window) return;
      const min = minWindowSize(window.kind, window.rateHidden);
      const offset = (index + 1) * CASCADE_STEP;
      const dx = Math.max(0, Math.min(offset, rect.w - min.w));
      const dy = Math.max(0, Math.min(offset, rect.h - min.h));
      rects.set(id, keepHeadInArea({ x: rect.x + dx, y: rect.y + dy, w: rect.w - dx, h: rect.h - dy }, room.canvas));
      order.push(id);
    });
    rects.set(group.active, keepHeadInArea(rect, room.canvas));
    order.push(group.active);
  }
  const dockArea = workArea(room.dock.area.w, room.dock.area.h)!;
  const drawnFloats = floatRects(dock, windows, dockArea);
  for (const float of dock.floats) {
    const rect = drawnFloats[float.window]!;
    rects.set(float.window, keepHeadInArea(rect, room.canvas));
    order.push(float.window);
  }
  if (countOverlaps([...rects.values()]) > TIDY_OVERLAP_LIMIT) return fitCanvas(null, windows, room.canvas);
  return { rects: Object.fromEntries([...rects].map(([id, rect]) => [id, toRatio(rect, room.canvas)])), order };
}

export function dockFromCanvas(canvas: CanvasPlacement, windows: WindowList, room?: StackRoom): DockPlacement {
  const chartOrder = [...canvas.order].reverse();
  const charts = windows.filter((window) => window.kind === "chart").sort((a, b) => chartOrder.indexOf(a.id) - chartOrder.indexOf(b.id));
  const ordered = [...charts, ...windows.filter((window) => window.kind !== "chart")];
  const [first, ...rest] = ordered;
  return defaultDock(first ? [first, ...rest] : windows, room);
}

export function placementForMode(placement: Placement, windows: WindowList, target: LayoutMode, room: PlacementRoom): Placement {
  if (target === "dock") {
    const dock = placement.dock ? fitDock(placement.dock, windows) : placement.canvas ? dockFromCanvas(placement.canvas, windows, stackRoom(room)) : defaultDock(windows, stackRoom(room));
    return dock === placement.dock ? placement : { ...placement, dock };
  }
  if (placement.canvas) {
    const canvas = fitCanvas(placement.canvas, windows, room.canvas);
    return canvas === placement.canvas ? placement : { ...placement, canvas };
  }
  const dock = fitDock(placement.dock, windows);
  return { ...placement, dock, canvas: canvasFromDock(dock, windows, room) };
}
