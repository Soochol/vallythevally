import type { WindowId } from "../kinds";
import type { DockNode, DockPlacement, Rect } from "../placement";
import { dockMinSize, layoutDock, tabsMinSize, type DockSpace, type Edge } from "./geometry";
import { findGroup, mapGroups, newGroupId, singleGroup, withoutWindow, type SplitNode } from "./tree";

export type SplitResult = { ok: true; dock: DockPlacement } | { ok: false; reason: "too-small" };

export const SPLIT_SHARE = 0.5;

function splitBeside(target: DockNode, rect: Rect, window: WindowId, edge: Edge, id: string, space: DockSpace): SplitNode | null {
  const row = edge === "left" || edge === "right";
  const leads = edge === "left" || edge === "top";
  const need = tabsMinSize(space.windows, [window]);
  const keep = dockMinSize(target, space);
  const total = (row ? rect.w : rect.h) - space.gap;
  const needAlong = row ? need.w : need.h;
  const keepAlong = row ? keep.w : keep.h;
  if (total < needAlong + keepAlong || (row ? rect.h : rect.w) < (row ? need.h : need.w)) return null;
  const share = Math.min(total - keepAlong, Math.max(needAlong, total * SPLIT_SHARE));
  const group = singleGroup(id, window);
  return {
    kind: "split",
    dir: row ? "row" : "column",
    ratio: (leads ? share : total - share) / total,
    first: leads ? group : target,
    second: leads ? target : group,
  };
}

const isOnlyTab = (dock: DockPlacement, groupId: string, window: WindowId): boolean => {
  const group = findGroup(dock.root, groupId);
  return group !== null && group.tabs.length === 1 && group.tabs[0] === window;
};

export function splitGroup(dock: DockPlacement, window: WindowId, groupId: string, edge: Edge, space: DockSpace): SplitResult {
  if (!findGroup(dock.root, groupId) || isOnlyTab(dock, groupId, window)) return { ok: true, dock };
  const rest = withoutWindow(dock, window);
  const box = rest && layoutDock(rest.root, space.area, space.gap).groups.find((candidate) => candidate.group.id === groupId);
  if (!rest || !box) return { ok: true, dock };
  const split = splitBeside(box.group, box.rect, window, edge, newGroupId(rest.root), space);
  if (!split) return { ok: false, reason: "too-small" };
  const root = mapGroups(rest.root, (group) => (group.id === groupId ? split : group));
  return root ? { ok: true, dock: { ...rest, root } } : { ok: true, dock };
}

export function splitArea(dock: DockPlacement, window: WindowId, edge: Edge, space: DockSpace): SplitResult {
  if (dock.root.kind === "group" && isOnlyTab(dock, dock.root.id, window)) return { ok: true, dock };
  const rest = withoutWindow(dock, window);
  if (!rest) return { ok: true, dock };
  const split = splitBeside(rest.root, { x: 0, y: 0, ...space.area }, window, edge, newGroupId(rest.root), space);
  return split ? { ok: true, dock: { ...rest, root: split } } : { ok: false, reason: "too-small" };
}
