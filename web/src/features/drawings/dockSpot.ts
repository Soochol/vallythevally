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
  const clear = (spot: Spot) => apart(dock, spot, clearance);
  const natural = { left, top: tops.find((top) => top === within(top, bar.height, pane.height)) ?? within(tops[0] ?? margin, bar.height, pane.height) };
  if (clear(natural)) return natural;
  const spots = [
    ...[...tops, dock.bottom + clearance, dock.top - bar.height - clearance].map((y) => ({ left, top: within(y, bar.height, pane.height) })),
    ...[dock.right + clearance, dock.left - bar.width - clearance].filter((x) => x === within(x, bar.width, pane.width)).map((x) => ({ left: x, top: natural.top })),
  ].filter(clear);
  const free = drawing ? spots.filter((spot) => apart(drawing, spot, 0)) : spots;
  const distance = (spot: Spot) => Math.hypot(spot.left - natural.left, spot.top - natural.top);
  return (free.length ? free : spots).reduce<Spot | null>((best, spot) => best && distance(best) <= distance(spot) ? best : spot, null) ?? natural;
}
