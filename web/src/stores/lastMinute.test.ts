import { afterEach, beforeEach, expect, test } from "vitest";
import { followLastMinute } from "./lastMinute";
import { DEFAULT_LAYOUT, useLayoutStore } from "./layout";
import { useSelectionStore } from "./selection";
import { useUiStore } from "./ui";
import { DEFAULT_UI_PREFS } from "../persist/uiState";

let stop = () => {};

beforeEach(() => {
  useLayoutStore.getState().load(DEFAULT_LAYOUT);
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
  useSelectionStore.setState({ activeSlot: 0 });
  stop = followLastMinute();
});

afterEach(() => stop());

const lastMinute = () => useUiStore.getState().prefs.lastMinute;

test("활성 칸의 봉 주기가 분봉으로 바뀌면 마지막 분봉을 바꾸고, 분봉이 아닌 주기는 무시한다", () => {
  const { setPeriod } = useLayoutStore.getState();
  setPeriod(0, "10m");
  expect(lastMinute()).toBe("10m");
  setPeriod(0, "D");
  expect(lastMinute()).toBe("10m");
  setPeriod(0, "60m");
  expect(lastMinute()).toBe("60m");
});

test("같은 분봉으로 다시 정해도 저장할 변경을 만들지 않는다", () => {
  useLayoutStore.getState().setPeriod(0, "5m");
  const revision = useUiStore.getState().revision;
  useLayoutStore.getState().setPeriod(0, "5m");
  useLayoutStore.getState().setPeriod(0, "D");
  expect(useUiStore.getState().revision).toBe(revision);
});

test("분봉 칸을 활성 칸으로 고르거나 분봉 칸이 활성인 레이아웃을 열면 그 분봉을 마지막 분봉으로 삼는다", () => {
  const [first] = DEFAULT_LAYOUT.cells;
  useLayoutStore.getState().load({ ...DEFAULT_LAYOUT, cells: [first!, { ...first!, slot: 1, period: "15m" }] });
  expect(lastMinute()).toBe("3m");
  useSelectionStore.setState({ activeSlot: 1 });
  expect(lastMinute()).toBe("15m");
  useLayoutStore.getState().load({ ...DEFAULT_LAYOUT, cells: [{ ...first!, period: "1m" }] });
  expect(lastMinute()).toBe("1m");
});
