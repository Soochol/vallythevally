import { WINDOW_HEAD_HEIGHT, WINDOW_KINDS, type WindowId, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement, Rect } from "../placement";
import { splitAt, updateSplit, type GroupNode, type SplitNode, type SplitPath } from "./tree";

export type Size = { w: number; h: number };
export type DockSpace = { area: Size; gap: number; windows: readonly WindowRef[] };

export function windowMinSize(windows: readonly WindowRef[], window: WindowId): Size {
  const ref = windows.find((candidate) => candidate.id === window);
  if (!ref) throw new Error(`창 목록에 없는 창 ${window}의 최소 크기를 찾았습니다`);
  return WINDOW_KINDS[ref.kind].minSize;
}

export function tabsMinSize(windows: readonly WindowRef[], tabs: readonly WindowId[]): Size {
  const sizes = tabs.map((tab) => windowMinSize(windows, tab));
  return { w: Math.max(...sizes.map((size) => size.w)), h: Math.max(...sizes.map((size) => size.h)) + WINDOW_HEAD_HEIGHT };
}

export function dockMinSize(node: DockNode, space: Pick<DockSpace, "gap" | "windows">): Size {
  if (node.kind === "group") return tabsMinSize(space.windows, node.tabs);
  const first = dockMinSize(node.first, space);
  const second = dockMinSize(node.second, space);
  return node.dir === "row"
    ? { w: first.w + second.w + space.gap, h: Math.max(first.h, second.h) }
    : { w: Math.max(first.w, second.w), h: first.h + second.h + space.gap };
}

export type GroupBox = { group: GroupNode; rect: Rect };
export type GutterBox = { path: SplitPath; dir: SplitNode["dir"]; split: Rect; rect: Rect };
export type DockLayout = { groups: GroupBox[]; gutters: GutterBox[] };

function splitRects(split: SplitNode, rect: Rect, gap: number): { first: Rect; gutter: Rect; second: Rect } {
  const row = split.dir === "row";
  const along = row ? rect.w : rect.h;
  const available = Math.max(0, along - gap);
  const lead = Math.round(available * split.ratio);
  const cut = (offset: number, length: number): Rect =>
    row ? { x: rect.x + offset, y: rect.y, w: length, h: rect.h } : { x: rect.x, y: rect.y + offset, w: rect.w, h: length };
  return { first: cut(0, lead), gutter: cut(lead, along - available), second: cut(along - (available - lead), available - lead) };
}

export function layoutDock(root: DockNode, area: Size, gap: number): DockLayout {
  const layout: DockLayout = { groups: [], gutters: [] };
  const visit = (node: DockNode, rect: Rect, path: SplitPath) => {
    if (node.kind === "group") {
      layout.groups.push({ group: node, rect });
      return;
    }
    const parts = splitRects(node, rect, gap);
    layout.gutters.push({ path, dir: node.dir, split: rect, rect: parts.gutter });
    visit(node.first, parts.first, [...path, "first"]);
    visit(node.second, parts.second, [...path, "second"]);
  };
  visit(root, { x: 0, y: 0, ...area }, []);
  return layout;
}

export type DividerResult = { dock: DockPlacement; clamped: boolean };

export function moveDivider(dock: DockPlacement, path: SplitPath, ratio: number, space: DockSpace): DividerResult {
  const split = splitAt(dock.root, path);
  const box = layoutDock(dock.root, space.area, space.gap).gutters.find((gutter) => gutter.path.join() === path.join());
  if (!split || !box || !Number.isFinite(ratio)) return { dock, clamped: false };
  const row = split.dir === "row";
  const available = (row ? box.split.w : box.split.h) - space.gap;
  const firstMin = dockMinSize(split.first, space);
  const secondMin = dockMinSize(split.second, space);
  const lowest = (row ? firstMin.w : firstMin.h) / available;
  const highest = 1 - (row ? secondMin.w : secondMin.h) / available;
  if (!(lowest <= highest)) return { dock, clamped: true };
  const next = Math.max(lowest, Math.min(highest, ratio));
  const clamped = next !== ratio;
  if (next === split.ratio) return { dock, clamped };
  return { dock: { ...dock, root: updateSplit(dock.root, path, (node) => ({ ...node, ratio: next })) }, clamped };
}

export type Edge = "left" | "right" | "top" | "bottom";
export type DropZone = Edge | "center";
export type DropTarget = { zone: DropZone; preview: Rect };

export const EDGE_ZONE_SHARE = 0.24;

export function edgePreview(rect: Rect, edge: Edge): Rect {
  switch (edge) {
    case "left":
      return { ...rect, w: rect.w / 2 };
    case "right":
      return { ...rect, x: rect.x + rect.w / 2, w: rect.w / 2 };
    case "top":
      return { ...rect, h: rect.h / 2 };
    case "bottom":
      return { ...rect, y: rect.y + rect.h / 2, h: rect.h / 2 };
    default: {
      const _exhaustive: never = edge;
      return _exhaustive;
    }
  }
}

export function dropTarget(rect: Rect, point: { x: number; y: number }): DropTarget {
  const dx = (point.x - rect.x) / rect.w;
  const dy = (point.y - rect.y) / rect.h;
  const distances: [Edge, number][] = [["left", dx], ["right", 1 - dx], ["top", dy], ["bottom", 1 - dy]];
  const [edge, distance] = distances.reduce((near, candidate) => (candidate[1] < near[1] ? candidate : near));
  return distance < EDGE_ZONE_SHARE ? { zone: edge, preview: edgePreview(rect, edge) } : { zone: "center", preview: rect };
}
