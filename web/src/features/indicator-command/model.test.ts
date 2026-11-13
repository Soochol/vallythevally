import { expect, test } from "vitest";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { DEFAULT_CHART_SETTINGS, type ChartSettings } from "../../chart/settings";
import { commandKey, commandRows, modeAfterInput, selectedRow } from "./model";

const empty = { rows: [], selectable: true, empty: true };
const info: SymbolInfo = { code: "005930", name: "삼성전자", market: "kospi", kind: "common", nxtEnabled: true };
const withMa: ChartSettings = {
  ...DEFAULT_CHART_SETTINGS,
  indicators: [...DEFAULT_CHART_SETTINGS.indicators, { id: "ma", spec: { kind: "ma", method: "sma", period: 20 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } }],
};

test("띄운 지표 탭은 띄운 지표만 가격 패널·아래 패널로 묶고 첫 지표를 고른다", () => {
  const rows = commandRows(withMa, "", "current", { rows: [{ info, group: "result" }], selectable: true, empty: false });
  expect(rows.map((row) => [row.kind, row.group])).toEqual([["current", "가격 패널"], ["current", "아래 패널"]]);
  expect(selectedRow(rows, "")).toMatchObject({ kind: "current", config: { id: "ma" } });
  expect(selectedRow(rows, rows[1]!.key)).toMatchObject({ kind: "current", config: { spec: { kind: "volume" } } });
});

test("지표 추가 탭은 입력한 설정의 후보만 고르고 빈 입력은 모든 종류를 묶어 보인다", () => {
  const typed = commandRows(withMa, "이평 20", "add", { rows: [{ info, group: "result" }], selectable: true, empty: false });
  expect(typed.map((row) => row.kind)).toEqual(["candidate"]);
  expect(selectedRow(typed, "")).toMatchObject({ kind: "candidate", group: "가격 패널", candidate: { label: "이동평균 단순 20" } });
  const all = commandRows(withMa, "", "add", empty);
  expect([...new Set(all.map((row) => row.group))]).toEqual(["가격 패널", "아래 패널", "재무지표"]);
  expect(all.filter((row) => row.group === "재무지표").map((row) => row.kind === "candidate" && row.candidate.kind)).toContain("revenue");
  expect(commandRows(withMa, "005930", "add", { rows: [{ info, group: "result" }], selectable: true, empty: false })).toEqual([]);
});

test("비교 종목 탭은 종목만 고르고 검색이 끝나기 전에는 고르지 않는다", () => {
  const rows = commandRows(withMa, "삼성", "compare", { rows: [{ info, group: "result" }], selectable: true, empty: false });
  expect(rows.map((row) => row.kind)).toEqual(["symbol"]);
  expect(selectedRow(rows, "")).toMatchObject({ kind: "symbol", info, selectable: true });
  const stale = commandRows(withMa, "005930", "compare", { rows: [{ info, group: "result" }], selectable: false, empty: false });
  expect(selectedRow(stale, "")).toBeUndefined();
  expect(selectedRow(stale, stale[0]!.key)).toBeUndefined();
});

test("띄운 지표 탭에서 글자를 치면 지표 추가 탭으로 넘어가고 다른 탭은 그대로다", () => {
  expect(modeAfterInput("current", "이평")).toBe("add");
  expect(modeAfterInput("current", " ")).toBe("current");
  expect(modeAfterInput("add", "")).toBe("add");
  expect(modeAfterInput("compare", "삼성")).toBe("compare");
});

test("Enter는 계속 추가하고 Shift+Enter만 추가 뒤 닫으며 한글 조합은 소비하지 않는다", () => {
  expect(commandKey({ key: "Enter", shiftKey: false, isComposing: false })).toEqual({ kind: "submit", close: false });
  expect(commandKey({ key: "Enter", shiftKey: true, isComposing: false })).toEqual({ kind: "submit", close: true });
  expect(commandKey({ key: "Enter", shiftKey: true, isComposing: true })).toEqual({ kind: "ignore" });
  expect(commandKey({ key: "ArrowDown", shiftKey: false, isComposing: false })).toEqual({ kind: "move", step: 1 });
  expect(commandKey({ key: "ArrowUp", shiftKey: false, isComposing: false })).toEqual({ kind: "move", step: -1 });
  expect(commandKey({ key: "Escape", shiftKey: false, isComposing: false })).toEqual({ kind: "ignore" });
});
