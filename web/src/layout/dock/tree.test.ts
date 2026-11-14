import { expect, test } from "vitest";
import { windowId, type WindowId, type WindowKind, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { defaultDock, fitDock, type WindowList } from "./fit";
import { layoutDock, moveDivider, type DockSpace } from "./geometry";
import { splitArea, splitGroup } from "./split";
import { findGroup, groupOfWindow, listGroups, putTab, removeWindow, selectTab } from "./tree";

const ref = (id: string, kind: WindowKind): WindowRef => ({ id: windowId(id), kind });
const group = (id: string, tabs: string[], active = tabs[0] ?? ""): DockNode => ({ kind: "group", id, tabs: tabs.map(windowId), active: windowId(active) });
const id = windowId;

const c1 = ref("c1", "chart");
const c2 = ref("c2", "chart");
const c3 = ref("c3", "chart");
const w = ref("w", "watchlist");
const s = ref("s", "screener");
const o = ref("o", "objects");
const i = ref("i", "indicators");
const space: DockSpace = { area: { w: 1256, h: 684 }, gap: 6, windows: [c1, c2, w, s, o, i] };

const removed = (dock: DockPlacement, window: string): DockPlacement => {
  const result = removeWindow(dock, id(window));
  if (!result.ok) throw new Error(result.reason);
  return result.dock;
};

test("묶음을 차례로 돌고, 창이나 id로 묶음을 찾는다", () => {
  const { root } = defaultDock([c1, c2, w, s]);
  expect(listGroups(root).map((node) => node.id)).toEqual(["g1", "g2", "g3"]);
  expect(groupOfWindow(root, id("s"))?.id).toBe("g3");
  expect(groupOfWindow(root, id("o"))).toBeNull();
  expect(findGroup(root, "g2")?.tabs).toEqual(["c2"]);
  expect(findGroup(root, "g9")).toBeNull();
});

test("마지막 탭을 빼면 묶음이 사라지고 이웃이 자리를 채운다", () => {
  const dock = removed(defaultDock([c1, c2, w]), "c2");
  expect(dock.root).toEqual({ kind: "split", dir: "row", ratio: 0.72, first: group("g1", ["c1"]), second: group("g3", ["w"]) });
  expect(layoutDock(dock.root, space.area, space.gap).groups[0]?.rect).toEqual({ x: 0, y: 0, w: 900, h: 684 });
});

test("뿌리 묶음의 마지막 탭은 빼지 않는다", () => {
  const dock: DockPlacement = { root: group("g1", ["c1"]), floats: [{ window: id("c2"), rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }] };
  expect(removeWindow(dock, id("c1"))).toEqual({ ok: false, reason: "last-tab" });
  expect(removed(dock, "c2")).toEqual({ root: group("g1", ["c1"]), floats: [] });
});

test("고른 탭을 빼면 그 옆 탭을 고른다", () => {
  const dock: DockPlacement = { root: group("g1", ["w", "s", "o"], "s"), floats: [] };
  expect(removed(dock, "s").root).toEqual(group("g1", ["w", "o"], "o"));
  expect(removed(selectTab(dock, id("o")), "o").root).toEqual(group("g1", ["w", "s"], "s"));
  expect(removed(dock, "w").root).toEqual(group("g1", ["s", "o"], "s"));
});

test("탭을 고르면 그 묶음만 바뀌고, 없는 창을 고르면 그대로다", () => {
  const dock = defaultDock([c1, w, s]);
  expect(listGroups(selectTab(dock, id("s")).root).map((node) => node.active)).toEqual(["c1", "s"]);
  expect(selectTab(dock, id("gone"))).toBe(dock);
});

test("탭을 더하고, 순서를 바꾸고, 다른 묶음으로 옮긴다", () => {
  const dock = defaultDock([c1, w, s]);
  const added = putTab(dock, id("o"), "g2");
  expect(findGroup(added.root, "g2")).toEqual(group("g2", ["w", "s", "o"], "o"));
  expect(findGroup(putTab(added, id("o"), "g2", 0).root, "g2")).toEqual(group("g2", ["o", "w", "s"], "o"));
  const moved = putTab(added, id("w"), "g1", 0);
  expect(listGroups(moved.root)).toEqual([group("g1", ["w", "c1"], "w"), group("g2", ["s", "o"], "o")]);
  const emptied = putTab(defaultDock([c1, c2, w]), id("c2"), "g1");
  expect(listGroups(emptied.root).map((node) => node.id)).toEqual(["g1", "g3"]);
  expect(putTab(dock, id("o"), "g9")).toBe(dock);
});

test("떠 있는 창을 묶음에 탭으로 넣으면 떠 있는 항목이 사라진다", () => {
  const dock: DockPlacement = { root: group("g1", ["c1"]), floats: [{ window: id("w"), rect: { x: 0.6, y: 0.1, w: 0.3, h: 0.4 } }] };
  expect(putTab(dock, id("w"), "g1")).toEqual({ root: group("g1", ["c1", "w"], "w"), floats: [] });
});

function problems(dock: DockPlacement, windows: readonly WindowRef[]): string[] {
  const found: string[] = [];
  const seen = new Map<WindowId, number>();
  const count = (window: WindowId) => seen.set(window, (seen.get(window) ?? 0) + 1);
  const groupIds = new Set<string>();
  const visit = (node: DockNode) => {
    if (node.kind === "split") {
      if (!(node.ratio > 0 && node.ratio < 1)) found.push(`ratio ${node.ratio}`);
      visit(node.first);
      visit(node.second);
      return;
    }
    if (groupIds.has(node.id)) found.push(`같은 묶음 id ${node.id}`);
    groupIds.add(node.id);
    if (node.tabs.length === 0) found.push(`빈 묶음 ${node.id}`);
    if (!node.tabs.includes(node.active)) found.push(`${node.id}의 고른 탭 ${node.active}`);
    node.tabs.forEach(count);
  };
  visit(dock.root);
  dock.floats.forEach((float) => count(float.window));
  for (const window of windows) if (seen.get(window.id) !== 1) found.push(`${window.id}가 ${seen.get(window.id) ?? 0}번 나온다`);
  for (const window of seen.keys()) if (!windows.some((candidate) => candidate.id === window)) found.push(`목록에 없는 ${window}`);
  return found;
}

const ok = (result: { ok: true; dock: DockPlacement } | { ok: false }, before: DockPlacement) => (result.ok ? result.dock : before);

test("연산을 이어 적용해도 창은 한 번씩, 빈 묶음 없음, 비율 범위, 묶음 id 고유가 지켜진다", () => {
  const all: WindowList = [c1, c2, w, s, o, i];
  const steps: [string, readonly WindowRef[], (dock: DockPlacement) => DockPlacement][] = [
    ["스크리너를 차트 오른쪽에", all, (dock) => ok(splitGroup(dock, id("s"), "g1", "right", space), dock)],
    ["지표를 둘째 차트 묶음에", all, (dock) => putTab(dock, id("i"), "g2")],
    ["뿌리 경계를 끝까지", all, (dock) => moveDivider(dock, [], 0.99, space).dock],
    ["관심종목을 전체 왼쪽에", all, (dock) => ok(splitArea(dock, id("w"), "left", space), dock)],
    ["작은 자리에 나누기 거절", all, (dock) => ok(splitGroup(dock, id("o"), "g2", "top", { ...space, area: { w: 700, h: 400 } }), dock)],
    ["둘째 차트 빼기", [c1, w, s, o, i], (dock) => removed(dock, "c2")],
    ["개체 목록 띄우기", [c1, w, s, o, i], (dock) => ({ ...removed(dock, "o"), floats: [{ window: id("o"), rect: { x: 0.5, y: 0.5, w: 0.3, h: 0.3 } }] })],
    ["차트 되살리기와 지표 닫기", [c1, c2, w, s, o], (dock) => fitDock(dock, [c1, c2, w, s, o])],
    ["떠 있던 창을 묶음 아래에", [c1, c2, w, s, o], (dock) => ok(splitGroup(dock, id("o"), groupOfWindow(dock.root, id("c1"))?.id ?? "", "bottom", space), dock)],
    ["차트 하나 더", [c1, c2, c3, w, s, o], (dock) => fitDock(dock, [c1, c2, c3, w, s, o])],
    ["탭 순서 바꾸기", [c1, c2, c3, w, s, o], (dock) => putTab(dock, id("c3"), groupOfWindow(dock.root, id("c1"))?.id ?? "", 0)],
    ["관심종목 빼기", [c1, c2, c3, s, o], (dock) => removed(dock, "w")],
  ];
  let dock = defaultDock(all);
  expect(problems(dock, all)).toEqual([]);
  for (const [name, windows, step] of steps) {
    dock = step(dock);
    expect({ name, problems: problems(dock, windows) }).toEqual({ name, problems: [] });
  }
});
