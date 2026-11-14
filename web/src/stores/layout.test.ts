import { beforeEach, expect, test } from "vitest";
import { groupOfWindow, listGroups } from "../layout/dock/tree";
import { windowId } from "../layout/kinds";
import { DEFAULT_LAYOUT, fittedDock, useLayoutStore } from "./layout";

const state = () => useLayoutStore.getState();
const shownTab = (kind: string) => {
  const { windows, placement } = state().layout;
  const id = windows.find((w) => w.kind === kind)?.id;
  return id !== undefined && placement.dock !== null && groupOfWindow(placement.dock.root, id)?.active === id;
};

beforeEach(() => useLayoutStore.setState({ layout: structuredClone(DEFAULT_LAYOUT), revision: 0 }));

test("탭 고르기는 맞춘 배치에 고른 탭을 남기고 저장 순서를 올린다", () => {
  state().selectTab(windowId("screener"));
  expect(shownTab("screener")).toBe(true);
  expect(state().revision).toBe(1);
  state().selectTab(windowId("screener"));
  expect(state().revision).toBe(1);
});

test("창 보이기는 있는 창의 탭을 고르고, 없는 창은 더해 기본 자리의 탭으로 고른다", () => {
  state().showWindow("objects");
  expect(shownTab("objects")).toBe(true);
  const windows = state().layout.windows.length;
  state().showWindow("indicators");
  expect(state().layout.windows).toHaveLength(windows + 1);
  expect(state().layout.windows.at(-1)).toEqual({ id: "indicators", link: null, kind: "indicators" });
  expect(shownTab("indicators")).toBe(true);
  const side = groupOfWindow(state().layout.placement.dock!.root, windowId("watchlist"))!;
  expect(side.tabs).toContain("indicators");
  state().showWindow("indicators");
  expect(state().layout.windows).toHaveLength(windows + 1);
});

test("새 창 id는 이미 쓰는 id를 피한다", () => {
  const layout = structuredClone(DEFAULT_LAYOUT);
  layout.windows = layout.windows.map((w) => (w.kind === "objects" ? { ...w, id: windowId("indicators") } : w));
  useLayoutStore.setState({ layout });
  state().showWindow("indicators");
  expect(state().layout.windows.filter((w) => w.kind === "indicators")).toEqual([{ id: "indicators-2", link: null, kind: "indicators" }]);
});

test("배치 반영은 같은 배치면 저장하지 않는다", () => {
  const dock = fittedDock(state().layout);
  state().setDock(dock);
  expect(state().revision).toBe(1);
  state().setDock(dock);
  expect(state().revision).toBe(1);
  expect(listGroups(state().layout.placement.dock!.root)).toHaveLength(2);
});
