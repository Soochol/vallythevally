import type { WindowId } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";

export type GroupNode = Extract<DockNode, { kind: "group" }>;
export type SplitNode = Extract<DockNode, { kind: "split" }>;
export type Branch = "first" | "second";
export type SplitPath = readonly Branch[];

export function listGroups(node: DockNode): GroupNode[] {
  return node.kind === "group" ? [node] : [...listGroups(node.first), ...listGroups(node.second)];
}

export const findGroup = (root: DockNode, id: string): GroupNode | null => listGroups(root).find((group) => group.id === id) ?? null;

export const groupOfWindow = (root: DockNode, window: WindowId): GroupNode | null =>
  listGroups(root).find((group) => group.tabs.includes(window)) ?? null;

export function splitAt(root: DockNode, path: SplitPath): SplitNode | null {
  let node = root;
  for (const branch of path) {
    if (node.kind !== "split") return null;
    node = node[branch];
  }
  return node.kind === "split" ? node : null;
}

export function mapGroups(node: DockNode, change: (group: GroupNode) => DockNode | null): DockNode | null {
  if (node.kind === "group") return change(node);
  const first = mapGroups(node.first, change);
  const second = mapGroups(node.second, change);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function updateSplit(node: DockNode, path: SplitPath, change: (split: SplitNode) => SplitNode): DockNode {
  if (node.kind !== "split") return node;
  const [branch, ...rest] = path;
  if (!branch) return change(node);
  const child = updateSplit(node[branch], rest, change);
  if (child === node[branch]) return node;
  return branch === "first" ? { ...node, first: child } : { ...node, second: child };
}

export function newGroupId(root: DockNode): string {
  const used = new Set(listGroups(root).map((group) => group.id));
  let n = 1;
  while (used.has(`g${n}`)) n += 1;
  return `g${n}`;
}

export const singleGroup = (id: string, window: WindowId): GroupNode => ({ kind: "group", id, tabs: [window], active: window });

function withoutTab(group: GroupNode, window: WindowId): GroupNode | null {
  const index = group.tabs.indexOf(window);
  if (index < 0) return group;
  const tabs = group.tabs.filter((tab) => tab !== window);
  const neighbour = tabs[index] ?? tabs[index - 1];
  if (!neighbour) return null;
  return { ...group, tabs, active: group.active === window ? neighbour : group.active };
}

export function withoutWindow(dock: DockPlacement, window: WindowId): DockPlacement | null {
  const root = mapGroups(dock.root, (group) => withoutTab(group, window));
  if (!root) return null;
  const floats = dock.floats.filter((float) => float.window !== window);
  return root === dock.root && floats.length === dock.floats.length ? dock : { root, floats };
}

export type RemoveResult = { ok: true; dock: DockPlacement } | { ok: false; reason: "last-tab" };

export function removeWindow(dock: DockPlacement, window: WindowId): RemoveResult {
  const next = withoutWindow(dock, window);
  return next ? { ok: true, dock: next } : { ok: false, reason: "last-tab" };
}

export function selectTab(dock: DockPlacement, window: WindowId): DockPlacement {
  const root = mapGroups(dock.root, (group) => (group.tabs.includes(window) && group.active !== window ? { ...group, active: window } : group));
  return root && root !== dock.root ? { ...dock, root } : dock;
}

export function putTab(dock: DockPlacement, window: WindowId, groupId: string, at?: number): DockPlacement {
  if (!findGroup(dock.root, groupId)) return dock;
  const root = mapGroups(dock.root, (group) => {
    if (group.id !== groupId) return withoutTab(group, window);
    const tabs = group.tabs.filter((tab) => tab !== window);
    const index = Math.max(0, Math.min(at ?? tabs.length, tabs.length));
    return { ...group, tabs: [...tabs.slice(0, index), window, ...tabs.slice(index)], active: window };
  });
  if (!root) return dock;
  return { root, floats: dock.floats.filter((float) => float.window !== window) };
}
