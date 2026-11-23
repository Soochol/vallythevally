import { expect, test } from "vitest";
import { windowId, type WindowKind, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { carryMove, carryRatios } from "./carry";
import { detachWindow } from "./floats";
import { drawDock, moveDivider, type DockSpace } from "./geometry";
import { pushDivider } from "./push";
import { splitGroup } from "./split";
import { listGroups, putTab } from "./tree";

const ref = (id: string, kind: WindowKind): WindowRef => ({ id: windowId(id), kind });
const group = (id: string, tabs: string[], active = tabs[0] ?? ""): DockNode => ({ kind: "group", id, tabs: tabs.map(windowId), active: windowId(active) });
const row = (ratio: number, first: DockNode, second: DockNode): DockNode => ({ kind: "split", dir: "row", ratio, first, second });
const placed = (root: DockNode): DockPlacement => ({ root, floats: [] });
const tabsOf = (dock: DockPlacement) => listGroups(dock.root).map((node) => node.tabs);

const windows = [ref("c", "chart"), ref("b", "brokers"), ref("w", "watchlist"), ref("o", "order")];
const narrow: DockSpace = { area: { w: 1000, h: 800 }, gap: 6, windows };
const inner = row(0.45, group("g2", ["b", "w"]), group("g3", ["o"]));
const three = placed(row(0.35, group("g1", ["c"]), inner));
const folded = drawDock(three, narrow).dock;

test("접혀 그려진 경계를 옮기면 저장 배치에는 그 경계의 비율만 옮겨지고 접힌 묶음은 남는다", () => {
  expect(tabsOf(folded)).toEqual([["c"], ["b", "w", "o"]]);
  const moved = moveDivider(folded, [], 0.3, narrow).dock;
  const carried = carryRatios(three, folded, moved);
  expect(carried.root).toEqual(row(0.3, group("g1", ["c"]), inner));
});

test("비율이 눌려 그려진 경계는 다른 경계를 옮겨도 저장 비율을 지킨다", () => {
  const order = [ref("c", "chart"), ref("t", "trades"), ref("o", "order")];
  const saved = placed(row(0.5, group("g1", ["c"]), row(0.7, group("g2", ["t"]), group("g3", ["o"]))));
  const space: DockSpace = { area: { w: 1100, h: 800 }, gap: 6, windows: order };
  const drawn = drawDock(saved, space).dock;
  expect(drawn.root.kind === "split" && drawn.root.second.kind === "split" && drawn.root.second.ratio).not.toBe(0.7);
  const moved = pushDivider(drawn, [], 0.4, space).dock;
  const carried = carryRatios(saved, drawn, moved);
  expect(carried.root.kind === "split" && carried.root.ratio).toBe(moved.root.kind === "split" && moved.root.ratio);
  expect(carried.root.kind === "split" && carried.root.second.kind === "split" && carried.root.second.ratio).toBe(0.7);
});

test("그려진 배치가 바뀌지 않으면 저장 배치를 그대로 돌려준다", () => {
  expect(carryRatios(three, folded, folded)).toBe(three);
});

test("접힌 묶음 안의 탭 순서는 그 탭의 저장 묶음 안에서 바뀐다", () => {
  const next = putTab(folded, windowId("b"), "g2", 1);
  expect(tabsOf(next)).toEqual([["c"], ["w", "b", "o"]]);
  expect(carryMove(three, folded, next, windowId("b")).root).toEqual(row(0.35, group("g1", ["c"]), row(0.45, group("g2", ["w", "b"], "b"), group("g3", ["o"]))));
});

test("접혀 들어온 탭을 넘는 순서 바꾸기는 저장 묶음을 바꾸지 않는다", () => {
  const next = putTab(folded, windowId("w"), "g2", 2);
  expect(tabsOf(next)).toEqual([["c"], ["b", "o", "w"]]);
  expect(tabsOf(carryMove(three, folded, next, windowId("w")))).toEqual(tabsOf(three));
});

test("다른 묶음에서 접힌 묶음 끝으로 옮긴 탭은 바로 앞 탭의 저장 묶음에 들어간다", () => {
  const four = [...windows, ref("k", "trades")];
  const saved = placed(row(0.35, row(0.5, group("g1", ["c"]), group("g4", ["k"])), inner));
  const drawn = drawDock(saved, { ...narrow, windows: four }).dock;
  const next = putTab(drawn, windowId("k"), "g2");
  expect(listGroups(next.root).find((node) => node.tabs.includes(windowId("k")))?.tabs.at(-1)).toBe("k");
  expect(carryMove(saved, drawn, next, windowId("k")).root).toEqual(row(0.35, group("g1", ["c"]), row(0.45, group("g2", ["b", "w"]), group("g3", ["o", "k"], "k"))));
});

test("접힌 묶음 옆에 나눠 놓으면 저장 배치에서 그 묶음만 감싸고 나머지 비율과 묶음은 남는다", () => {
  const split = splitGroup(folded, windowId("c"), "g2", "right", narrow);
  expect(split.ok).toBe(true);
  if (!split.ok) return;
  const carried = carryMove(three, folded, split.dock, windowId("c"));
  const added = split.dock.root.kind === "split" ? split.dock.root : null;
  expect(added?.second.kind === "group" && added.second.tabs).toEqual(["c"]);
  expect(carried.root).toEqual(row(0.45, row(added?.ratio ?? 0, group("g2", ["b", "w"]), group("g1", ["c"])), group("g3", ["o"])));
});

test("접힌 묶음에서 띄운 창은 저장 배치에서만 빠지고 접힌 묶음은 남는다", () => {
  const rect = { x: 0.1, y: 0.1, w: 0.3, h: 0.4 };
  const next = detachWindow(folded, windowId("w"), rect);
  expect(carryMove(three, folded, next, windowId("w"))).toEqual({ root: row(0.35, group("g1", ["c"]), row(0.45, group("g2", ["b"]), group("g3", ["o"]))), floats: [{ window: "w", rect }] });
});

const lone = placed(row(0.35, group("g1", ["c"]), row(0.45, group("g2", ["b"]), group("g3", ["o"]))));
const loneWindows = [ref("c", "chart"), ref("b", "brokers"), ref("o", "order")];
const loneSpace: DockSpace = { area: { w: 1000, h: 800 }, gap: 6, windows: loneWindows };
const loneFolded = drawDock(lone, loneSpace).dock;
const homeOf = (dock: DockPlacement, tab: string) => listGroups(dock.root).find((node) => node.tabs.includes(windowId(tab)));

test("저장 묶음에 혼자인 탭을 접힌 묶음 안에서 옮기는 순서 바꾸기는 저장 배치를 바꾸지 않는다", () => {
  expect(tabsOf(loneFolded)).toEqual([["c"], ["b", "o"]]);
  const source = homeOf(loneFolded, "b")!;
  const next = putTab(loneFolded, windowId("b"), source.id, 1);
  expect(tabsOf(next)).toEqual([["c"], ["o", "b"]]);
  expect(carryMove(lone, loneFolded, next, windowId("b"))).toEqual(lone);
});

test("저장 묶음에 혼자인 탭을 접힌 묶음에서 다른 묶음으로 옮기면 그 탭만 옮겨 가고 나머지 묶음과 비율은 남는다", () => {
  const next = putTab(loneFolded, windowId("b"), "g1");
  expect(carryMove(lone, loneFolded, next, windowId("b")).root).toEqual(row(0.35, group("g1", ["c", "b"], "b"), group("g3", ["o"])));
});

const EDGES = ["left", "right", "top", "bottom"] as const;
const everyWindow = (dock: DockPlacement) => [...listGroups(dock.root).flatMap((node) => node.tabs), ...dock.floats.map((float) => float.window)].sort();
const partition = (dock: DockPlacement) => listGroups(dock.root).map((node) => [...node.tabs].sort().join(",")).sort();

test("접힌 배치의 어떤 이동도 저장 배치에 빈 묶음을 남기지 않고 창을 잃거나 겹치지 않으며 순서 바꾸기는 저장 묶음 구성을 지킨다", () => {
  const four = [...windows, ref("k", "trades")];
  const cases: [DockPlacement, DockSpace][] = [
    [lone, loneSpace],
    [three, narrow],
    [placed(row(0.35, row(0.5, group("g1", ["c"]), group("g4", ["k"])), inner)), { ...narrow, windows: four }],
  ];
  let reorders = 0;
  for (const [saved, space] of cases) {
    const drawn = drawDock(saved, space).dock;
    for (const { id } of space.windows) {
      const source = listGroups(drawn.root).find((node) => node.tabs.includes(id))!;
      const moves: { next: DockPlacement; reorder: boolean }[] = [];
      for (let at = 0; at < source.tabs.length; at += 1) moves.push({ next: putTab(drawn, id, source.id, at), reorder: true });
      for (const target of listGroups(drawn.root)) {
        if (target.id !== source.id) moves.push({ next: putTab(drawn, id, target.id), reorder: false });
        for (const edge of EDGES) {
          const split = splitGroup(drawn, id, target.id, edge, space);
          if (split.ok) moves.push({ next: split.dock, reorder: false });
        }
      }
      moves.push({ next: detachWindow(drawn, id, { x: 0.1, y: 0.1, w: 0.3, h: 0.4 }), reorder: false });
      for (const { next, reorder } of moves) {
        const carried = carryMove(saved, drawn, next, id);
        const ids = listGroups(carried.root).map((node) => node.id);
        expect(listGroups(carried.root).every((node) => node.tabs.length > 0)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
        expect(everyWindow(carried)).toEqual(everyWindow(saved));
        if (reorder) {
          reorders += 1;
          expect(partition(carried)).toEqual(partition(saved));
        }
      }
    }
  }
  expect(reorders).toBeGreaterThan(0);
});
