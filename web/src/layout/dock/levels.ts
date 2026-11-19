import type { WindowId } from "../kinds";
import type { DockNode, DockPlacement, Rect } from "../placement";
import { layoutDock, wholePixels, type DockSpace, type Edge } from "./geometry";
import { splitBeside, type SplitResult } from "./split";
import { listGroups, newGroupId, withoutWindow, type Branch, type SplitPath } from "./tree";

export type DockLevelKind = "group" | "split" | "area";
export type DockLevel = { path: SplitPath; rect: Rect; groupCount: number; kind: DockLevelKind };

export const LEVEL_BAND_WIDTH = 24;

const horizontalEdge = (edge: Edge): boolean => edge === "left" || edge === "right";
const outerBranch = (edge: Edge): Branch => (edge === "right" || edge === "bottom" ? "second" : "first");

function nodeAt(root: DockNode, path: SplitPath): DockNode {
  return path.reduce<DockNode>((node, branch) => (node.kind === "split" ? node[branch] : node), root);
}

function replaceAt(node: DockNode, path: SplitPath, replacement: DockNode): DockNode {
  const [branch, ...rest] = path;
  if (!branch || node.kind !== "split") return replacement;
  const child = replaceAt(node[branch], rest, replacement);
  return branch === "first" ? { ...node, first: child } : { ...node, second: child };
}

function pathOfGroup(node: DockNode, groupId: string): SplitPath | null {
  if (node.kind === "group") return node.id === groupId ? [] : null;
  for (const branch of ["first", "second"] as const) {
    const found = pathOfGroup(node[branch], groupId);
    if (found) return [branch, ...found];
  }
  return null;
}

function boundsOf(root: DockNode, path: SplitPath, space: Pick<DockSpace, "area" | "gap">): Rect {
  const inside = new Set(listGroups(nodeAt(root, path)).map((group) => group.id));
  const rects = layoutDock(root, space.area, space.gap).groups.filter(({ group }) => inside.has(group.id)).map(({ rect }) => rect);
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  return {
    x: left,
    y: top,
    w: Math.max(...rects.map((rect) => rect.x + rect.w)) - left,
    h: Math.max(...rects.map((rect) => rect.y + rect.h)) - top,
  };
}

export function dockLevels(root: DockNode, groupId: string, edge: Edge, space: Pick<DockSpace, "area" | "gap">): DockLevel[] {
  const px = wholePixels(space);
  const groupPath = pathOfGroup(root, groupId);
  if (!groupPath) return [];
  const lengthOf = (rect: Rect) => (horizontalEdge(edge) ? rect.h : rect.w);
  const level = (path: SplitPath, kind: DockLevelKind): DockLevel => {
    const node = nodeAt(root, path);
    return { path, rect: boundsOf(root, path, px), groupCount: listGroups(node).length, kind };
  };
  const levels = [level(groupPath, "group")];
  for (let depth = groupPath.length - 1; depth >= 0; depth -= 1) {
    const ancestor = nodeAt(root, groupPath.slice(0, depth));
    if (ancestor.kind !== "split") break;
    const alongEdge = (ancestor.dir === "row") === horizontalEdge(edge);
    if (alongEdge && groupPath[depth] !== outerBranch(edge)) break;
    const path = groupPath.slice(0, depth);
    const candidate = level(path, depth === 0 ? "area" : "split");
    const last = levels[levels.length - 1];
    if (depth === 0 || !last || lengthOf(candidate.rect) !== lengthOf(last.rect)) levels.push(candidate);
  }
  return levels;
}

export function splitLevel(dock: DockPlacement, window: WindowId, groupId: string, edge: Edge, levelIndex: number, space: DockSpace): SplitResult {
  const px = wholePixels(space);
  const rest = withoutWindow(dock, window);
  const levels = rest ? dockLevels(rest.root, groupId, edge, px) : [];
  const level = levels[Math.max(0, Math.min(levelIndex, levels.length - 1))];
  if (!rest || !level) return { ok: true, dock };
  const split = splitBeside(nodeAt(rest.root, level.path), level.rect, window, edge, newGroupId(rest.root), px);
  if (!split) return { ok: false, reason: "too-small" };
  return { ok: true, dock: { ...rest, root: replaceAt(rest.root, level.path, split) } };
}

export function levelAtDistance(distance: number, bandDepth: number, levelCount: number): number {
  const outer = levelCount - 1;
  if (outer <= 0) return 0;
  const width = Math.min(LEVEL_BAND_WIDTH, bandDepth / (outer + 1));
  return distance < outer * width ? outer - Math.floor(distance / width) : 0;
}
