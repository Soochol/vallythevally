import { expect, test } from "vitest";
import { windowId, type WindowKind, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { layoutDock, type DockSpace } from "./geometry";
import { dockLevels, levelAtDistance, splitLevel } from "./levels";
import { splitArea, splitGroup } from "./split";
import { listGroups } from "./tree";

const ref = (id: string, kind: WindowKind): WindowRef => ({ id: windowId(id), kind });
const group = (id: string, tabs: string[], active = tabs[0] ?? ""): DockNode => ({ kind: "group", id, tabs: tabs.map(windowId), active: windowId(active) });
const split = (dir: "row" | "column", ratio: number, first: DockNode, second: DockNode): DockNode => ({ kind: "split", dir, ratio, first, second });

const windows = [ref("a", "watchlist"), ref("b", "watchlist"), ref("c", "chart"), ref("c2", "watchlist"), ref("x", "watchlist"), ref("y", "watchlist"), ref("s", "watchlist")];
const space: DockSpace = { area: { w: 1416, h: 748 }, gap: 6, windows };
const place = (root: DockNode): DockPlacement => ({ root, floats: [] });
const rects = (root: DockNode, at = space) => Object.fromEntries(layoutDock(root, at.area, at.gap).groups.map(({ group: node, rect }) => [node.id, rect]));

const userRoot = split("row", 0.5, split("column", 0.5, group("gA", ["a"]), group("gB", ["b"])), group("gC", ["c", "c2"]));
const user = place(userRoot);

test("사용자 예: A의 오른쪽 단계는 묶음과 세로 나눔이다", () => {
  const levels = dockLevels(userRoot, "gA", "right", space);
  expect(levels.map((level) => [level.kind, level.path, level.groupCount])).toEqual([["group", ["first", "first"], 1], ["split", ["first"], 2]]);
  expect(levels[1]?.rect).toEqual({ x: 0, y: 0, w: rects(userRoot).gB!.w, h: 748 });
});

test("사용자 예: C2를 왼쪽 나눔 전체의 오른쪽에 놓으면 C는 그대로이고 폭을 왼쪽에서 가져온다", () => {
  const before = rects(userRoot);
  const result = splitLevel(user, windowId("c2"), "gA", "right", 1, space);
  if (!result.ok) throw new Error(result.reason);
  const after = rects(result.dock.root);
  expect(after.gC).toEqual(before.gC);
  const moved = listGroups(result.dock.root).find((node) => node.tabs.includes(windowId("c2")))!;
  const middle = after[moved.id]!;
  expect(middle.h).toBe(748);
  expect(middle.x).toBe(after.gA!.x + after.gA!.w + 6);
  expect(middle.x + middle.w + 6).toBe(after.gC!.x);
  expect(Math.abs(after.gA!.w - middle.w)).toBeLessThanOrEqual(1);
  expect(after.gB!.w).toBe(after.gA!.w);
});

test("순번 0은 splitGroup과 같고 화면 전체 단계는 splitArea와 같다", () => {
  const other = place(split("column", 0.4, group("gA", ["a"]), split("row", 0.5, group("gB", ["b"]), group("gC", ["c", "c2"]))));
  for (const dock of [user, other]) {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      expect(splitLevel(dock, windowId("c2"), "gA", edge, 0, space)).toEqual(splitGroup(dock, windowId("c2"), "gA", edge, space));
      const levels = dockLevels(dock.root, "gA", edge, space);
      const last = levels.length - 1;
      if (levels[last]?.kind === "area") expect(splitLevel(dock, windowId("c2"), "gA", edge, last, space)).toEqual(splitArea(dock, windowId("c2"), edge, space));
    }
  }
});

test("화면 전체 단계는 splitArea와 같다", () => {
  const levels = dockLevels(userRoot, "gB", "bottom", space);
  expect(levels.map((level) => level.kind)).toEqual(["group", "area"]);
  expect(splitLevel(user, windowId("c2"), "gB", "bottom", 1, space)).toEqual(splitArea(user, windowId("c2"), "bottom", space));
  expect(splitLevel(user, windowId("c2"), "gB", "bottom", 9, space)).toEqual(splitArea(user, windowId("c2"), "bottom", space));
});

test("위·아래 변: B의 아래는 [B, 화면 전체]이고 A의 아래는 [A]뿐이다", () => {
  expect(dockLevels(userRoot, "gB", "bottom", space).map((level) => level.kind)).toEqual(["group", "area"]);
  expect(dockLevels(userRoot, "gA", "bottom", space).map((level) => level.kind)).toEqual(["group"]);
});

test("묶음 하나뿐인 화면은 묶음 단계 하나다", () => {
  expect(dockLevels(group("gA", ["a"]), "gA", "left", space).map((level) => level.kind)).toEqual(["group"]);
});

test("같은 길이의 가운데 나눔은 단계에 넣지 않는다", () => {
  const root = split("row", 0.3, group("gX", ["x"]), split("row", 0.5, group("gY", ["y"]), group("gG", ["a"])));
  expect(dockLevels(root, "gG", "right", space).map((level) => level.kind)).toEqual(["group", "area"]);
  expect(dockLevels(root, "gG", "left", space).map((level) => level.kind)).toEqual(["group"]);
});

test("마지막 탭을 끌면 그 묶음이 빠진 트리에서 단계를 구한다", () => {
  const root = split("row", 0.5, split("column", 0.5, group("gA", ["a"]), group("gS", ["s"])), group("gC", ["c"]));
  const dock = place(root);
  const result = splitLevel(dock, windowId("s"), "gA", "right", 1, space);
  if (!result.ok) throw new Error(result.reason);
  const after = rects(result.dock.root);
  expect(Object.keys(after).sort()).toEqual(["g1", "gA", "gC"]);
  expect(after.gA!.h).toBe(748);
  expect(after.g1!.h).toBe(748);
  const remaining = split("row", 0.5, group("gA", ["a"]), group("gC", ["c"]));
  expect(dockLevels(remaining, "gA", "left", space).map((level) => level.kind)).toEqual(["group", "area"]);
  const own = splitLevel(dock, windowId("s"), "gS", "right", 0, space);
  expect(own.ok && own.dock).toBe(dock);
});

test("자리가 모자라면 too-small이다", () => {
  const narrow: DockSpace = { ...space, area: { w: 300, h: 748 } };
  const root = split("row", 0.5, split("column", 0.5, group("gA", ["a"]), group("gB", ["b"])), group("gC", ["c", "c2"]));
  expect(splitLevel(place(root), windowId("c2"), "gA", "right", 1, narrow)).toEqual({ ok: false, reason: "too-small" });
});

test("띠 판정: 단계가 하나면 언제나 0", () => {
  for (const distance of [0, 10, 500]) expect(levelAtDistance(distance, 200, 1)).toBe(0);
});

test.each([
  [200, [[0, 2], [23, 2], [24, 1], [47, 1], [48, 0], [199, 0]]],
  [48, [[0, 2], [15, 2], [16, 1], [31, 1], [32, 0]]],
] as const)("띠 판정: 단계 셋, 띠 깊이 %i", (depth, cases) => {
  for (const [distance, expected] of cases) expect(levelAtDistance(distance, depth, 3)).toBe(expected);
});
