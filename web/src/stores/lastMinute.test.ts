import { afterEach, beforeEach, expect, test } from "vitest";
import { followLastMinute } from "./lastMinute";
import { windowId } from "../layout/kinds";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "./layout";
import { useSelectionStore } from "./selection";
import { useUiStore } from "./ui";
import { DEFAULT_UI_PREFS } from "../persist/uiState";

const CELL = chartWindows(DEFAULT_LAYOUT)[0]!.id;
let stop = () => {};

beforeEach(() => {
  useLayoutStore.getState().load(DEFAULT_LAYOUT);
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
  useSelectionStore.setState({ activeCell: CELL });
  stop = followLastMinute();
});

afterEach(() => stop());

const lastMinute = () => useUiStore.getState().prefs.lastMinute;

test("활성 칸의 봉 주기가 분봉으로 바뀌면 마지막 분봉을 바꾸고, 분봉이 아닌 주기는 무시한다", () => {
  const { setPeriod } = useLayoutStore.getState();
  setPeriod(CELL, "10m");
  expect(lastMinute()).toBe("10m");
  setPeriod(CELL, "D");
  expect(lastMinute()).toBe("10m");
  setPeriod(CELL, "60m");
  expect(lastMinute()).toBe("60m");
});

test("같은 분봉으로 다시 정해도 저장할 변경을 만들지 않는다", () => {
  useLayoutStore.getState().setPeriod(CELL, "5m");
  const revision = useUiStore.getState().revision;
  useLayoutStore.getState().setPeriod(CELL, "5m");
  useLayoutStore.getState().setPeriod(CELL, "D");
  expect(useUiStore.getState().revision).toBe(revision);
});

test("분봉 칸을 활성 칸으로 고르거나 분봉 칸이 활성인 레이아웃을 열면 그 분봉을 마지막 분봉으로 삼는다", () => {
  const [first, ...others] = DEFAULT_LAYOUT.windows;
  const second = windowId("cell-1");
  useLayoutStore.getState().load({ ...DEFAULT_LAYOUT, windows: [first!, { ...chartWindows(DEFAULT_LAYOUT)[0]!, id: second, period: "15m" }, ...others] });
  expect(lastMinute()).toBe("3m");
  useSelectionStore.setState({ activeCell: second });
  expect(lastMinute()).toBe("15m");
  useLayoutStore.getState().load({ ...DEFAULT_LAYOUT, windows: [{ ...chartWindows(DEFAULT_LAYOUT)[0]!, period: "1m" }, ...others] });
  expect(lastMinute()).toBe("1m");
});
