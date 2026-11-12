import { expect, test } from "vitest";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { DEFAULT_CHART_SETTINGS } from "../../chart/settings";
import { commandKey, commandRows, selectedRow } from "./model";

const empty = { rows: [], selectable: true, empty: true };
const info: SymbolInfo = { code: "005930", name: "삼성전자", market: "kospi", kind: "common", nxtEnabled: true };

test("같은 목록 위쪽에는 띄운 지표를 두고 입력한 설정의 추가 후보를 고른다", () => {
  const rows = commandRows(DEFAULT_CHART_SETTINGS, "이평 20", "indicators", empty);
  expect(rows.map((row) => row.kind)).toEqual(["current", "candidate"]);
  expect(rows[0]?.group).toBe("이 칸에 띄운 지표");
  expect(selectedRow(rows, "")).toMatchObject({ kind: "candidate", candidate: { label: "이동평균 단순 20" } });
  expect(selectedRow(rows, rows[0]!.key)).toMatchObject({ kind: "current" });
});

test("종목 검색이 끝나기 전에는 현재 지표를 추가 대상으로 대신 고르지 않는다", () => {
  const pending = commandRows(DEFAULT_CHART_SETTINGS, "005930", "indicators", { rows: [], selectable: false, empty: false });
  expect(selectedRow(pending, "")).toBeUndefined();
  const stale = commandRows(DEFAULT_CHART_SETTINGS, "005930", "compare", { rows: [{ info, group: "result" }], selectable: false, empty: false });
  expect(selectedRow(stale, "")).toBeUndefined();
  expect(selectedRow(stale, stale[0]!.key)).toBeUndefined();
  const ready = commandRows(DEFAULT_CHART_SETTINGS, "005930", "indicators", { rows: [{ info, group: "result" }], selectable: true, empty: false });
  expect(selectedRow(ready, "")).toMatchObject({ kind: "symbol", info, selectable: true });
});

test("비교 모드는 같은 입력창에서 종목 후보만 고른다", () => {
  const rows = commandRows(DEFAULT_CHART_SETTINGS, "삼성", "compare", { rows: [{ info, group: "result" }], selectable: true, empty: false });
  expect(rows.map((row) => row.kind)).toEqual(["symbol"]);
});

test("Enter는 계속 추가하고 Shift+Enter만 추가 뒤 닫으며 한글 조합은 소비하지 않는다", () => {
  expect(commandKey({ key: "Enter", shiftKey: false, isComposing: false })).toEqual({ kind: "submit", close: false });
  expect(commandKey({ key: "Enter", shiftKey: true, isComposing: false })).toEqual({ kind: "submit", close: true });
  expect(commandKey({ key: "Enter", shiftKey: true, isComposing: true })).toEqual({ kind: "ignore" });
  expect(commandKey({ key: "ArrowDown", shiftKey: false, isComposing: false })).toEqual({ kind: "move", step: 1 });
  expect(commandKey({ key: "ArrowUp", shiftKey: false, isComposing: false })).toEqual({ kind: "move", step: -1 });
  expect(commandKey({ key: "Escape", shiftKey: false, isComposing: false })).toEqual({ kind: "ignore" });
});
