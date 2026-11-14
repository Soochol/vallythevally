import type { WindowId } from "../kinds";
import type { DockNode, DockPlacement, Rect } from "../placement";
import { heldMinSize, layoutDock, ratioForLead, tabsMinSize, wholePixels, type DockSpace, type Edge } from "./geometry";
import { newGroupId, rewriteGroups, singleGroup, withoutWindow, type SplitNode } from "./tree";

export type SplitResult = { ok: true; dock: DockPlacement } | { ok: false; reason: "too-small" };

export const SPLIT_SHARE = 0.5;

function splitBeside(target: DockNode, rect: Rect, window: WindowId, edge: Edge, id: string, space: DockSpace): SplitNode | null {
  const row = edge === "left" || edge === "right";
  const leads = edge === "left" || edge === "top";
  const need = tabsMinSize(space.windows, [window]);
  const keep = heldMinSize(target, space);
  const along = row ? rect.w : rect.h;
  const needAlong = row ? need.w : need.h;
  const keepAlong = row ? keep.w : keep.h;
  const across = row ? rect.h : rect.w;
  if (needAlong + space.gap + keepAlong > along || across < Math.max(row ? need.h : need.w, row ? keep.h : keep.w)) return null;
  const share = Math.min(along - space.gap - keepAlong, Math.max(needAlong, Math.floor((along - space.gap) * SPLIT_SHARE)));
  const group = singleGroup(id, window);
  return {
    kind: "split",
    dir: row ? "row" : "column",
    ratio: ratioForLead(leads ? share : along - space.gap - share, along, space.gap),
    first: leads ? group : target,
    second: leads ? target : group,
  };
}

export function splitGroup(dock: DockPlacement, window: WindowId, groupId: string, edge: Edge, space: DockSpace): SplitResult {
  const px = wholePixels(space);
  const rest = withoutWindow(dock, window);
  const box = rest && layoutDock(rest.root, px.area, px.gap).groups.find((candidate) => candidate.group.id === groupId);
  if (!rest || !box) return { ok: true, dock };
  const split = splitBeside(box.group, box.rect, window, edge, newGroupId(rest.root), px);
  if (!split) return { ok: false, reason: "too-small" };
  return { ok: true, dock: { ...rest, root: rewriteGroups(rest.root, (group) => (group.id === groupId ? split : group)) } };
}

export function splitArea(dock: DockPlacement, window: WindowId, edge: Edge, space: DockSpace): SplitResult {
  const px = wholePixels(space);
  const rest = withoutWindow(dock, window);
  if (!rest) return { ok: true, dock };
  const split = splitBeside(rest.root, { x: 0, y: 0, ...px.area }, window, edge, newGroupId(rest.root), px);
  return split ? { ok: true, dock: { ...rest, root: split } } : { ok: false, reason: "too-small" };
}
