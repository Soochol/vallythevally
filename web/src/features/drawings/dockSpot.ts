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
