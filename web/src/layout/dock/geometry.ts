import { WINDOW_HEAD_HEIGHT, WINDOW_KINDS, type WindowId, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement, Rect } from "../placement";
import { updateSplit, type GroupNode, type SplitNode, type SplitPath } from "./tree";

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

export const leadLength = (ratio: number, along: number, gap: number): number =>
  Math.max(0, Math.min(along, Math.round(ratio * (along + gap)) - gap));

export const ratioForLead = (lead: number, along: number, gap: number): number => (lead + gap) / (along + gap);

function splitFits(ratio: number, along: number, gap: number, firstMin: number, secondMin: number): boolean {
  const lead = leadLength(ratio, along, gap);
  return lead >= firstMin && along - lead - Math.min(gap, along - lead) >= secondMin;
}

const ROUNDING_STEPS = 3;

function leastAlong(ratio: number, gap: number, firstMin: number, secondMin: number): number {
  const floor = firstMin + gap + secondMin;
  let along = Math.max(floor, Math.ceil((firstMin + gap - 0.5) / ratio) - gap, Math.floor((secondMin + gap - 0.5) / (1 - ratio)) + 1 - gap);
  for (let step = 0; step < ROUNDING_STEPS && along > floor && splitFits(ratio, along - 1, gap, firstMin, secondMin); step += 1) along -= 1;
  for (let step = 0; step < ROUNDING_STEPS && !splitFits(ratio, along, gap, firstMin, secondMin); step += 1) along += 1;
  return along;
}

export function heldMinSize(node: DockNode, space: Pick<DockSpace, "gap" | "windows">): Size {
  if (node.kind === "group") return tabsMinSize(space.windows, node.tabs);
  const first = heldMinSize(node.first, space);
  const second = heldMinSize(node.second, space);
  return node.dir === "row"
    ? { w: leastAlong(node.ratio, space.gap, first.w, second.w), h: Math.max(first.h, second.h) }
    : { w: Math.max(first.w, second.w), h: leastAlong(node.ratio, space.gap, first.h, second.h) };
}

export function wholePixels<T extends Pick<DockSpace, "area" | "gap">>(space: T): T {
  const whole = (length: number, round: (x: number) => number) => (Number.isFinite(length) ? Math.max(0, round(length)) : 0);
  return { ...space, area: { w: whole(space.area.w, Math.floor), h: whole(space.area.h, Math.floor) }, gap: whole(space.gap, Math.round) };
}

export type GroupBox = { group: GroupNode; rect: Rect };
export type GutterBox = { path: SplitPath; node: SplitNode; bounds: Rect; rect: Rect };
export type DockLayout = { groups: GroupBox[]; gutters: GutterBox[] };

function splitRects(split: SplitNode, rect: Rect, gap: number): { first: Rect; gutter: Rect; second: Rect } {
  const row = split.dir === "row";
  const along = row ? rect.w : rect.h;
  const lead = leadLength(split.ratio, along, gap);
  const gutter = Math.min(gap, along - lead);
  const cut = (offset: number, length: number): Rect =>
    row ? { x: rect.x + offset, y: rect.y, w: length, h: rect.h } : { x: rect.x, y: rect.y + offset, w: rect.w, h: length };
  return { first: cut(0, lead), gutter: cut(lead, gutter), second: cut(lead + gutter, along - lead - gutter) };
}

export function layoutDock(root: DockNode, area: Size, gap: number): DockLayout {
  const space = wholePixels({ area, gap });
  const layout: DockLayout = { groups: [], gutters: [] };
  const visit = (node: DockNode, rect: Rect, path: SplitPath) => {
    if (node.kind === "group") {
      layout.groups.push({ group: node, rect });
      return;
    }
    const parts = splitRects(node, rect, space.gap);
    layout.gutters.push({ path, node, bounds: rect, rect: parts.gutter });
    visit(node.first, parts.first, [...path, "first"]);
    visit(node.second, parts.second, [...path, "second"]);
  };
  visit(root, { x: 0, y: 0, ...space.area }, []);
  return layout;
}

export type DividerResult = { dock: DockPlacement; clamped: boolean };

export function moveDivider(dock: DockPlacement, path: SplitPath, ratio: number, space: DockSpace): DividerResult {
  const px = wholePixels(space);
  const box = layoutDock(dock.root, px.area, px.gap).gutters.find((gutter) => gutter.path.join() === path.join());
  if (!box || Number.isNaN(ratio)) return { dock, clamped: false };
  const row = box.node.dir === "row";
  const along = row ? box.bounds.w : box.bounds.h;
  const firstMin = heldMinSize(box.node.first, px);
  const secondMin = heldMinSize(box.node.second, px);
  const firstLeast = row ? firstMin.w : firstMin.h;
  const secondLeast = row ? secondMin.w : secondMin.h;
  if (firstLeast + px.gap + secondLeast > along) return { dock, clamped: true };
  const next = Math.max(ratioForLead(firstLeast, along, px.gap), Math.min(ratioForLead(along - px.gap - secondLeast, along, px.gap), ratio));
  const clamped = next !== ratio;
  if (next === box.node.ratio) return { dock, clamped };
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
