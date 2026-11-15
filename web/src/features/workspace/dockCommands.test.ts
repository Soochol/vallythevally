import { expect, test } from "vitest";
import { defaultDock } from "../../layout/dock/fit";
import { layoutDock, type DockSpace } from "../../layout/dock/geometry";
import { windowId, type WindowRef } from "../../layout/kinds";
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
