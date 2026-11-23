import { expect, test } from "vitest";
import { WATCH_COLUMNS } from "../../lib/watchlist";
import { fitColumns, fittedWidth } from "./columns";

test("창 폭에 들어갈 때까지 거래량, 등락, 등락률 순으로 빼고 마지막 한 열은 언제나 남긴다", () => {
  const all = WATCH_COLUMNS;
  expect(fitColumns(all, fittedWidth(all))).toBe(all);
  expect(fitColumns(all, fittedWidth(all) - 1)).toEqual(["price", "change", "changeRate"]);
  expect(fitColumns(all, fittedWidth(["price", "change", "changeRate"]) - 1)).toEqual(["price", "changeRate"]);
  expect(fitColumns(all, fittedWidth(["price", "changeRate"]) - 1)).toEqual(["price"]);
  expect(fitColumns(all, 0)).toEqual(["price"]);
  expect(fitColumns(["change", "volume"], 0)).toEqual(["change"]);
  expect(fitColumns([], 0)).toEqual([]);
});

test("고른 열의 순서는 지키고 빠지는 열만 우선순위로 정한다", () => {
  expect(fitColumns(["price", "change", "volume"], fittedWidth(["price", "change"]))).toEqual(["price", "change"]);
  expect(fitColumns(["change", "changeRate", "volume"], fittedWidth(["change", "changeRate"]))).toEqual(["change", "changeRate"]);
});

test("창 폭 358px에서 열 넷은 거래량을 빼고 242px에서는 현재가만 남는다", () => {
  expect(fitColumns(WATCH_COLUMNS, 358)).toEqual(["price", "change", "changeRate"]);
  expect(fitColumns(WATCH_COLUMNS, 242)).toEqual(["price"]);
});
