import type { DockAt } from "../../chart/drawings/prefs";

export interface Size { width: number; height: number }
export interface Spot { left: number; top: number }

export const DOCK_SNAP = 16;
export const DOCK_STEP = 16;

export function spotOf(at: DockAt, area: Size, bar: Size): Spot {
  return { left: at.x * area.width - bar.width / 2, top: at.y * area.height };
}

export function dockAtOf(spot: Spot, area: Size, bar: Size): DockAt {
  const ratio = (value: number, total: number) => total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  return { x: ratio(spot.left + bar.width / 2, area.width), y: ratio(spot.top, area.height) };
}

export function clampSpot(spot: Spot, area: Size, bar: Size, margin: number): Spot {
  const within = (value: number, size: number, total: number) => Math.max(margin, Math.min(value, total - size - margin));
  return { left: within(spot.left, bar.width, area.width), top: within(spot.top, bar.height, area.height) };
}

export function settleSpot(spot: Spot, home: Spot, area: Size, bar: Size): DockAt | null {
  const nearHome = Math.abs(spot.left - home.left) < DOCK_SNAP && Math.abs(spot.top - home.top) < DOCK_SNAP;
  return nearHome ? null : dockAtOf(spot, area, bar);
}

export interface Edges { left: number; top: number; right: number; bottom: number }

export function avoidDock(left: number, tops: readonly number[], bar: Size, pane: Size, dock: Edges, drawing: Edges | null, clearance: number, margin: number): Spot {
  const within = (value: number, size: number, total: number) => Math.max(margin, Math.min(value, total - size - margin));
  const apart = (box: Edges, spot: Spot, gap: number) => spot.left + bar.width + gap <= box.left || spot.left >= box.right + gap || spot.top + bar.height + gap <= box.top || spot.top >= box.bottom + gap;
  const preferred = { left, top: tops.find((top) => top === within(top, bar.height, pane.height)) ?? tops[0] ?? margin };
  const natural = clampSpot(preferred, pane, bar, margin);
  const nearest = (obstacles: readonly Edges[], gap: number, inset: number): Spot | null => {
    if (bar.width + inset * 2 > pane.width || bar.height + inset * 2 > pane.height) return null;
    const xs = [natural.left, inset, pane.width - bar.width - inset, ...obstacles.flatMap((box) => [box.left - bar.width - gap, box.right + gap])];
    const ys = [natural.top, ...tops, inset, pane.height - bar.height - inset, ...obstacles.flatMap((box) => [box.top - bar.height - gap, box.bottom + gap])];
    let best: Spot | null = null;
    let distance = Infinity;
    for (const x of xs) for (const y of ys) {
      const spot = clampSpot({ left: x, top: y }, pane, bar, inset);
      if (!obstacles.every((box) => apart(box, spot, gap))) continue;
      const next = (spot.left - natural.left) ** 2 + (spot.top - natural.top) ** 2;
      if (next < distance) { best = spot; distance = next; }
    }
    return best;
  };
  const obstacles = drawing ? [dock, drawing] : [dock];
  for (const boxes of [obstacles, [dock]]) {
    for (const { gap, inset } of [{ gap: clearance, inset: margin }, { gap: 0, inset: margin }, { gap: 0, inset: 0 }]) {
      const spot = nearest(boxes, gap, inset);
      if (spot) return spot;
    }
  }
  return clampSpot(preferred, pane, bar, 0);
}
