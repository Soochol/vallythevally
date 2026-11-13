import { beforeEach, expect, test } from "vitest";
import { DEFAULT_UI_PREFS } from "../persist/uiState";
import { useUiStore } from "./ui";

beforeEach(() => useUiStore.getState().load(DEFAULT_UI_PREFS, {}));

test("관심종목 그룹을 접고 펴면서 없어진 그룹 id는 지운다", () => {
  const s = useUiStore.getState();
  s.setWatchGroupCollapsed("A", true, ["A", "B"]);
  s.setWatchGroupCollapsed("B", true, ["A", "B"]);
  expect(useUiStore.getState().prefs.collapsedWatchGroups).toEqual(["A", "B"]);
  const revision = useUiStore.getState().revision;
  s.setWatchGroupCollapsed("A", true, ["A", "B"]);
  expect(useUiStore.getState().revision).toBe(revision);
  s.setWatchGroupCollapsed("C", true, ["C", "B"]);
  expect(useUiStore.getState().prefs.collapsedWatchGroups).toEqual(["B", "C"]);
  s.setWatchGroupCollapsed("B", false, ["C", "B"]);
  expect(useUiStore.getState().prefs.collapsedWatchGroups).toEqual(["C"]);
  s.setWatchGroupCollapsed("Z", true, ["C"]);
  expect(useUiStore.getState().prefs.collapsedWatchGroups).toEqual(["C"]);
});

test("지표 창을 가운데 창으로 되돌리면 지표 보기였던 우측 패널은 관심종목으로 돌아가고 지표 보기는 고를 수 없다", () => {
  const s = useUiStore.getState();
  s.setRightPanel("indicators");
  expect(useUiStore.getState().prefs.rightPanel).toBe("watch");
  s.setIndicatorWindow("inspector");
  s.setRightPanel("indicators");
  expect(useUiStore.getState().prefs.rightPanel).toBe("indicators");
  s.setIndicatorWindow("dialog");
  expect(useUiStore.getState().prefs).toMatchObject({ indicatorWindow: "dialog", rightPanel: "watch" });
  s.setRightPanel("screener");
  s.setIndicatorWindow("inspector");
  s.setIndicatorWindow("dialog");
  expect(useUiStore.getState().prefs.rightPanel).toBe("screener");
});
