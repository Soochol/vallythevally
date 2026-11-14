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
