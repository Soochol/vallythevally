import { expect, test } from "vitest";
import { detachWindow } from "../../layout/dock/floats";
import { defaultDock } from "../../layout/dock/fit";
import { layoutDock, type DockSpace } from "../../layout/dock/geometry";
import { windowId, type WindowKind, type WindowRef } from "../../layout/kinds";
import type { DockNode, DockPlacement } from "../../layout/placement";
import { evaluateDock, SMALL_DOCK_NOTICE } from "./dockCommands";

const chart = windowId("chart");
const screener = windowId("screener");
const watchlist = windowId("watchlist");
const refs = [{ id: chart, kind: "chart" }, { id: watchlist, kind: "watchlist" }, { id: screener, kind: "screener" }] satisfies [WindowRef, ...WindowRef[]];
const dock = defaultDock(refs);
const space: DockSpace = { area: { w: 1256, h: 500 }, gap: 6, windows: refs };

test("나눈 결과의 최소 크기와 빈 묶음 정리를 미리 보기에 반영한다", () => {
  const plan = evaluateDock(dock, { kind: "group-edge", window: screener, group: "g1", edge: "bottom" }, space);
  if (plan.kind !== "change") throw new Error("나눌 수 있는 자리를 거절했습니다");
  expect(plan.rect.h).toBe(274);
  expect(plan.rect).toEqual(layoutDock(plan.dock.root, space.area, space.gap).groups.find(({ group }) => group.tabs.includes(screener))?.rect);
  const merged = evaluateDock(plan.dock, { kind: "tab", window: screener, group: "g2" }, space);
  if (merged.kind !== "change") throw new Error("다른 묶음으로 옮기지 못했습니다");
  expect(layoutDock(merged.dock.root, space.area, space.gap).groups).toHaveLength(2);
});

test("작업 영역 가장자리의 미리 보기는 전체 폭이고 작은 자리는 이유와 함께 거절한다", () => {
  const plan = evaluateDock(dock, { kind: "area-edge", window: screener, edge: "bottom" }, space);
  if (plan.kind !== "change") throw new Error("전체 아래를 나누지 못했습니다");
  expect(plan.rect.w).toBe(space.area.w);
  const small = evaluateDock(dock, { kind: "group-edge", window: screener, group: "g1", edge: "bottom" }, { ...space, area: { w: 1256, h: 400 } });
  expect(small).toMatchObject({ kind: "blocked", label: SMALL_DOCK_NOTICE });
});

test("같은 순서로 넣기와 하나뿐인 탭의 자기 묶음 나누기는 변경이 아니다", () => {
  expect(evaluateDock(dock, { kind: "tab", window: screener, group: "g2", at: 1 }, space)).toEqual({ kind: "unchanged" });
  expect(evaluateDock(dock, { kind: "group-edge", window: chart, group: "g1", edge: "left" }, space)).toEqual({ kind: "unchanged" });
  const reordered = evaluateDock(dock, { kind: "tab", window: screener, group: "g2", at: 0 }, space);
  if (reordered.kind !== "change") throw new Error("탭 순서를 바꾸지 못했습니다");
  expect(layoutDock(reordered.dock.root, space.area, space.gap).groups[1]?.group.tabs).toEqual([screener, watchlist]);
});


test("떠 있는 창을 탭 또는 가장자리에 붙이고 작은 나누기는 저장 배치를 건드리지 않는다", () => {
  const floating = detachWindow(dock, screener, { x: .2, y: .2, w: .3, h: .4 });
  for (const command of [{ kind: "tab", window: screener, group: "g1" }, { kind: "group-edge", window: screener, group: "g1", edge: "bottom" }] as const) {
    const plan = evaluateDock(floating, command, space);
    if (plan.kind !== "change") throw new Error("떠 있는 창을 붙이지 못했습니다");
    expect(plan.dock.floats).toHaveLength(0);
    expect(layoutDock(plan.dock.root, space.area, space.gap).groups.flatMap(({ group }) => group.tabs).filter((id) => id === screener)).toHaveLength(1);
  }
  expect(evaluateDock(floating, { kind: "group-edge", window: screener, group: "g1", edge: "bottom" }, { ...space, area: { w: 1256, h: 300 } })).toMatchObject({ kind: "blocked", label: SMALL_DOCK_NOTICE });
  expect(floating.floats).toHaveLength(1);
});

const ref = (id: string, kind: WindowKind): WindowRef => ({ id: windowId(id), kind });
const leaf = (id: string, tabs: string[]): DockNode => ({ kind: "group", id, tabs: tabs.map(windowId), active: windowId(tabs[0] ?? "") });
const levelRefs = [ref("a", "watchlist"), ref("b", "watchlist"), ref("c", "chart"), ref("c2", "watchlist")];
const levelSpace: DockSpace = { area: { w: 1416, h: 748 }, gap: 6, windows: levelRefs };
const levelDock: DockPlacement = { root: { kind: "split", dir: "row", ratio: 0.5, first: { kind: "split", dir: "column", ratio: 0.5, first: leaf("gA", ["a"]), second: leaf("gB", ["b"]) }, second: leaf("gC", ["c", "c2"]) }, floats: [] };

test("단계 순번마다 단계 사각형·단계 목록·문구를 돌려준다", () => {
  const inner = evaluateDock(levelDock, { kind: "group-edge", window: windowId("c2"), group: "gA", edge: "right", level: 0 }, levelSpace);
  const outer = evaluateDock(levelDock, { kind: "group-edge", window: windowId("c2"), group: "gA", edge: "right", level: 1 }, levelSpace);
  if (inner.kind !== "change" || outer.kind !== "change") throw new Error("나눌 수 있는 단계를 거절했습니다");
  expect(inner.label).toBe("오른쪽에 나눠 놓기");
  expect(outer.label).toBe("묶음 2개 전체 오른쪽에 나눠 놓기");
  expect(inner.levels?.steps).toEqual([{ kind: "group", groupCount: 1 }, { kind: "split", groupCount: 2 }]);
  expect([inner.levels?.current, outer.levels?.current]).toEqual([0, 1]);
  expect(inner.levels?.rect.h).toBe(371);
  expect(outer.levels?.rect.h).toBe(748);
  expect(outer.rect.h).toBe(748);
  expect(inner.rect.h).toBe(371);
});

test("단계 순번이 단계 수를 넘으면 가장 바깥 단계로 본다", () => {
  const plan = evaluateDock(levelDock, { kind: "group-edge", window: windowId("c2"), group: "gA", edge: "right", level: 9 }, levelSpace);
  expect(plan).toMatchObject({ kind: "change", label: "묶음 2개 전체 오른쪽에 나눠 놓기" });
});

test("화면 전체 가장자리는 문구에 화면 전체를 붙이고 단계 목록의 마지막이 지금 단계다", () => {
  const plan = evaluateDock(levelDock, { kind: "area-edge", window: windowId("c2"), edge: "bottom", group: "gB" }, levelSpace);
  if (plan.kind !== "change") throw new Error("전체 아래를 나누지 못했습니다");
  expect(plan.label).toBe("화면 전체 아래에 나눠 놓기");
  expect(plan.levels).toMatchObject({ steps: [{ kind: "group" }, { kind: "area" }], current: 1, rect: { x: 0, y: 0, w: 1416, h: 748 } });
  expect(evaluateDock(levelDock, { kind: "area-edge", window: windowId("c2"), edge: "bottom" }, levelSpace)).toMatchObject({ kind: "change", label: "화면 전체 아래에 나눠 놓기" });
});

test("바깥 단계가 들어가지 않으면 그 단계 사각형과 함께 거절한다", () => {
  const plan = evaluateDock(levelDock, { kind: "group-edge", window: windowId("c2"), group: "gA", edge: "right", level: 1 }, { ...levelSpace, area: { w: 300, h: 748 } });
  expect(plan).toMatchObject({ kind: "blocked", label: SMALL_DOCK_NOTICE, levels: { current: 1 } });
});
