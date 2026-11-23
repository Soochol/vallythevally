import type { WindowId } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { findGroup, groupOfWindow, listGroups, newGroupId, putTab, updateSplit, withoutWindow, type Branch, type SplitNode, type SplitPath } from "./tree";

const groupIds = (node: DockNode): Set<string> => new Set(listGroups(node).map((group) => group.id));
const tabsOf = (node: DockNode): WindowId[] => listGroups(node).flatMap((group) => group.tabs);
const BRANCHES: readonly Branch[] = ["first", "second"];

function commonPath(root: DockNode, ids: ReadonlySet<string>): SplitPath {
  const path: Branch[] = [];
  let node = root;
  while (node.kind === "split" && ids.size > 0) {
    const split: SplitNode = node;
    const branch = BRANCHES.find((side) => {
      const inside = groupIds(split[side]);
      return [...ids].every((id) => inside.has(id));
    });
    if (!branch) break;
    path.push(branch);
    node = split[branch];
  }
  return path;
}

function savedPathOf(saved: DockNode, drawn: DockNode): SplitPath {
  const kept = [...groupIds(drawn)].filter((id) => findGroup(saved, id));
  if (kept.length > 0) return commonPath(saved, new Set(kept));
  const tabs = new Set(tabsOf(drawn));
  return commonPath(saved, new Set(listGroups(saved).filter((group) => group.tabs.some((tab) => tabs.has(tab))).map((group) => group.id)));
}

function pathOfWindow(node: DockNode, window: WindowId): SplitPath | null {
  if (node.kind === "group") return node.tabs.includes(window) ? [] : null;
  for (const branch of BRANCHES) {
    const found = pathOfWindow(node[branch], window);
    if (found) return [branch, ...found];
  }
  return null;
}

function nodeAt(root: DockNode, path: SplitPath): DockNode {
  return path.reduce<DockNode>((node, branch) => (node.kind === "split" ? node[branch] : node), root);
}

function replaceAt(node: DockNode, path: SplitPath, replacement: DockNode): DockNode {
  const [branch, ...rest] = path;
  if (!branch || node.kind !== "split") return replacement;
  const child = replaceAt(node[branch], rest, replacement);
  return branch === "first" ? { ...node, first: child } : { ...node, second: child };
}

export function carryRatios(saved: DockPlacement, drawn: DockPlacement, next: DockPlacement): DockPlacement {
  let root = saved.root;
  const visit = (before: DockNode, after: DockNode) => {
    if (before.kind !== "split" || after.kind !== "split") return;
    if (after.ratio !== before.ratio) root = updateSplit(root, commonPath(saved.root, groupIds(before)), (split) => ({ ...split, ratio: after.ratio }));
    visit(before.first, after.first);
    visit(before.second, after.second);
  };
  visit(drawn.root, next.root);
  return root === saved.root ? saved : { ...saved, root };
}

function stayedInGroup(drawn: DockPlacement, next: DockPlacement, window: WindowId): WindowId[] | null {
  const source = groupOfWindow(drawn.root, window);
  const target = groupOfWindow(next.root, window);
  if (!source || !target || source.id !== target.id || source.tabs.length < 2 || target.tabs.length !== source.tabs.length) return null;
  return source.tabs.every((tab) => target.tabs.includes(tab)) ? target.tabs : null;
}

function reorderHome(saved: DockPlacement, order: readonly WindowId[], window: WindowId): DockPlacement {
  const home = groupOfWindow(saved.root, window);
  if (!home) return saved;
  const tabs = order.filter((tab) => home.tabs.includes(tab));
  return tabs.every((tab, index) => tab === home.tabs[index]) ? saved : putTab(saved, window, home.id, tabs.indexOf(window));
}

export function carryMove(saved: DockPlacement, drawn: DockPlacement, next: DockPlacement, window: WindowId): DockPlacement {
  const order = stayedInGroup(drawn, next, window);
  if (order) return reorderHome(saved, order, window);
  const rest = withoutWindow(saved, window);
  if (!rest) return saved;
  if (next.floats.some((float) => float.window === window)) return { root: rest.root, floats: next.floats };
  const path = pathOfWindow(next.root, window);
  const target = groupOfWindow(next.root, window);
  if (!path || !target) return saved;
  const branch = path.at(-1);
  const parent = nodeAt(next.root, path.slice(0, -1));
  if (target.tabs.length === 1 && branch && parent.kind === "split") {
    const besidePath = savedPathOf(rest.root, parent[branch === "first" ? "second" : "first"]);
    const beside = nodeAt(rest.root, besidePath);
    const group = { ...target, id: newGroupId(rest.root) };
    const split: SplitNode = { ...parent, first: branch === "first" ? group : beside, second: branch === "first" ? beside : group };
    return { ...rest, root: replaceAt(rest.root, besidePath, split) };
  }
  const index = target.tabs.indexOf(window);
  const before = target.tabs[index - 1];
  const neighbour = before ?? target.tabs[index + 1];
  const host = neighbour && groupOfWindow(rest.root, neighbour);
  if (!neighbour || !host) return saved;
  return putTab(rest, window, host.id, host.tabs.indexOf(neighbour) + (before ? 1 : 0));
}
