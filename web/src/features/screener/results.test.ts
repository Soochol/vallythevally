import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import { DEFAULT_SORT, nextSort, sortRows } from "../../lib/screener";
import { MiniChart } from "./ResultPreview";
import { ResultTable } from "./ResultTable";
import { nextResult, previewRow, resultKeyAction } from "./results";

const screen: Screen = { id: "s", name: "신고가", markets: [], exclude: [], conditions: [] };
const rows: ScreenerRow[] = [
  { symbol: "005930", name: "삼성전자", close: 70000, changeRate: 2.5, matchedDate: "2026-11-12", latestBarDate: "2026-11-12", provisional: false },
  { symbol: "000660", name: "가상하이닉스", close: 180000, changeRate: -1.5, matchedDate: "2026-11-11", latestBarDate: "2026-11-11", provisional: true },
  { symbol: "035420", name: "다음", close: 180000, changeRate: null, matchedDate: "2026-11-10", latestBarDate: "2026-11-12", provisional: false },
];

test("모든 열을 양방향으로 정렬하고 알 수 없는 등락률은 마지막에 둔다", () => {
  for (const [key, expected] of [
    ["name", ["000660", "035420", "005930"]],
    ["close", ["005930", "000660", "035420"]],
    ["changeRate", ["000660", "005930", "035420"]],
    ["matchedDate", ["035420", "000660", "005930"]],
  ] as const) {
    expect(sortRows(rows, { key, descending: false }).map((row) => row.symbol)).toEqual(expected);
    const descending = nextSort({ key, descending: false }, key);
    expect(descending.descending).toBe(true);
    const sorted = sortRows(rows, descending);
    expect(sorted[0]?.symbol).toBe(key === "name" || key === "changeRate" || key === "matchedDate" ? "005930" : "000660");
  }
  expect(rows[0]?.symbol).toBe("005930");
});

test("↑↓는 표시 순서로 이동하고 양 끝과 빈 결과에서는 멈춘다", () => {
  const sorted = sortRows(rows, { key: "close", descending: true });
  expect(nextResult(sorted, null, 1)).toBe("000660");
  expect(nextResult(sorted, null, -1)).toBe("005930");
  expect(nextResult(sorted, "000660", 1)).toBe("035420");
  expect(nextResult(sorted, "000660", -1)).toBeNull();
  expect(nextResult(sorted, "005930", 1)).toBeNull();
  expect(nextResult([], null, 1)).toBeNull();
});

test("미리보기는 정렬해도 고른 종목을 유지하고 없어진 결과는 현재 종목이나 첫 행으로 돌아간다", () => {
  const sorted = sortRows(rows, { key: "name", descending: false });
  expect(previewRow(sorted, "035420", "005930")?.symbol).toBe("035420");
  expect(previewRow(sorted, "gone", "005930")?.symbol).toBe("005930");
  expect(previewRow(sorted, "gone", "gone")?.symbol).toBe("000660");
  expect(previewRow([], null, "005930")).toBeNull();
});

const key = (key: string, patch: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, ...patch });

test("실행과 넓게 보기의 칸 열기 단축키를 구분하고 다른 조합과 조합 중 입력은 무시한다", () => {
  expect(resultKeyAction(key("Enter", { ctrlKey: true }), false)).toEqual({ kind: "run" });
  expect(resultKeyAction(key("Enter", { metaKey: true }), true)).toEqual({ kind: "run" });
  expect(resultKeyAction(key("Enter"), true)).toEqual({ kind: "open" });
  expect(resultKeyAction(key("Enter"), false)).toBeNull();
  expect(resultKeyAction(key("ArrowDown"), true)).toEqual({ kind: "move", step: 1 });
  expect(resultKeyAction(key("ArrowUp"), false)).toEqual({ kind: "move", step: -1 });
  for (const patch of [{ isComposing: true }, { defaultPrevented: true }, { altKey: true }, { shiftKey: true }, { ctrlKey: true }]) {
    expect(resultKeyAction(key("ArrowDown", patch), true)).toBeNull();
  }
});

test("결과 표는 서버의 네 열과 정렬 상태, 오래된 일봉·잠정 정보를 읽을 수 있게 표시한다", () => {
  const html = renderToStaticMarkup(createElement(ResultTable, { screen, rows, asOf: "2026-11-12", selected: "000660", sort: DEFAULT_SORT, onSort: () => {}, onSelect: () => {} }));
  expect(html.match(/scope="col"/g)).toHaveLength(4);
  expect(html).toContain('aria-sort="descending"');
  expect(html).toContain('aria-label="종가 순으로 정렬"');
  expect(html).toContain('aria-label="충족일 순으로 정렬"');
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain("삼성전자");
  expect(html).toContain("최신 일봉 2026-11-11 · 당일 요약 잠정");
  expect(html).toContain("11-11");
  expect(html).toContain("−1.50%");
  expect(html).not.toContain("시가총액");
  expect(html).not.toContain("60일");
});

test("미니 차트는 실제 OHLC를 그리고 빈 자료와 가격이 같은 봉을 처리한다", () => {
  expect(renderToStaticMarkup(createElement(MiniChart, { bars: [], name: "삼성전자" }))).toContain("일봉이 없습니다");
  const html = renderToStaticMarkup(createElement(MiniChart, { bars: [
    { t: 1, o: 100, h: 105, l: 95, c: 101, v: 10 },
    { t: 2, o: 100, h: 100, l: 100, c: 100, v: 0 },
  ], name: "삼성전자" }));
  expect(html).toContain('aria-label="삼성전자 KRX 일봉 미니 차트"');
  expect(html.match(/<rect/g)).toHaveLength(2);
  expect(html).not.toMatch(/NaN|Infinity/);
});
