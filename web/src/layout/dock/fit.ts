import { WINDOW_KINDS, type HomeSpot, type WindowId, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { listGroups, newGroupId, pruneGroups, rewriteGroups, singleGroup, type GroupNode } from "./tree";

export type WindowList = readonly [WindowRef, ...WindowRef[]];

export const WIDE_SHARE = 0.72;

const homeOf = (window: WindowRef): HomeSpot => WINDOW_KINDS[window.kind].home;

function stack(groups: readonly [GroupNode, ...GroupNode[]]): DockNode {
  const [head, ...rest] = groups;
  const [next, ...more] = rest;
  return next ? { kind: "split", dir: "column", ratio: 1 / groups.length, first: head, second: stack([next, ...more]) } : head;
}

export function defaultDock(windows: WindowList): DockPlacement {
  const wide = windows.filter((window) => homeOf(window) === "wide");
  const side = windows.filter((window) => homeOf(window) !== "wide").map((window) => window.id);
  const wideGroups = wide.map((window, index) => singleGroup(`g${index + 1}`, window.id));
  const [firstSide] = side;
  const sideGroup: GroupNode | null = firstSide ? { kind: "group", id: `g${wide.length + 1}`, tabs: side, active: firstSide } : null;
  const [firstWide, ...moreWide] = wideGroups;
  const left = firstWide ? stack([firstWide, ...moreWide]) : null;
  const root: DockNode | null =
    left && sideGroup ? { kind: "split", dir: "row", ratio: WIDE_SHARE, first: left, second: sideGroup } : (left ?? sideGroup);
  if (!root) throw new Error("창이 없는 목록으로 기본 배치를 만들 수 없습니다");
  return { root, floats: [] };
}

function insertMissing(root: DockNode, window: WindowRef, windows: readonly WindowRef[]): DockNode {
  const home = homeOf(window);
  const sameHome = (tab: WindowId) => windows.some((candidate) => candidate.id === tab && homeOf(candidate) === home);
  const target = listGroups(root).find((group) => group.tabs.some(sameHome));
  if (target) return rewriteGroups(root, (group) => (group === target ? { ...group, tabs: [...group.tabs, window.id] } : group));
  return {
    kind: "split",
    dir: "row",
    ratio: home === "wide" ? 1 - WIDE_SHARE : WIDE_SHARE,
    first: root,
    second: singleGroup(newGroupId(root), window.id),
  };
}

export function fitDock(dock: DockPlacement | null, windows: WindowList): DockPlacement {
  if (!dock) return defaultDock(windows);
  const known = new Set(windows.map((window) => window.id));
  const placed = new Set<WindowId>();
  const claim = (window: WindowId): boolean => {
    if (!known.has(window) || placed.has(window)) return false;
    placed.add(window);
    return true;
  };
  const kept = pruneGroups(dock.root, (group) => {
    const tabs = group.tabs.filter(claim);
    const [firstTab] = tabs;
    if (!firstTab) return null;
    const active = tabs.includes(group.active) ? group.active : firstTab;
    return tabs.length === group.tabs.length && active === group.active ? group : { ...group, tabs, active };
  });
  const floats = dock.floats.filter((float) => claim(float.window));
  const missing = windows.filter((window) => !placed.has(window.id));
  if (!kept) {
    const [first, ...more] = missing;
    if (first) return { root: defaultDock([first, ...more]).root, floats };
    const [docked, ...stillFloating] = floats;
    const dockedRef = docked && windows.find((window) => window.id === docked.window);
    return dockedRef ? { root: defaultDock([dockedRef]).root, floats: stillFloating } : defaultDock(windows);
  }
  const root = missing.reduce((node, window) => insertMissing(node, window, windows), kept);
  return root === dock.root && floats.length === dock.floats.length ? dock : { root, floats };
}
