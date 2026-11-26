import { expect, test } from "vitest";
import { WATCH_COLUMNS } from "../../lib/watchlist";
import { fitColumns, fittedWidth } from "./columns";

test("창 폭에 들어갈 때까지 우선순위가 낮은 열부터 빼고 마지막 한 열은 언제나 남긴다", () => {
  const four = ["price", "change", "changeRate", "volume"] as const;
  expect(fitColumns(four, fittedWidth(four))).toBe(four);
  expect(fitColumns(four, fittedWidth(four) - 1)).toEqual(["price", "change", "changeRate"]);
  expect(fitColumns(four, fittedWidth(["price", "change", "changeRate"]) - 1)).toEqual(["price", "changeRate"]);
  expect(fitColumns(four, fittedWidth(["price", "changeRate"]) - 1)).toEqual(["price"]);
  expect(fitColumns(WATCH_COLUMNS, 0)).toEqual(["price"]);
  expect(fitColumns(["change", "volume"], 0)).toEqual(["change"]);
  expect(fitColumns([], 0)).toEqual([]);
});

test("고른 열의 순서는 지키고 빠지는 열만 우선순위로 정한다", () => {
  expect(fitColumns(["tradedValue", "price", "volume"], fittedWidth(["tradedValue", "price"]))).toEqual(["tradedValue", "price"]);
  expect(fitColumns(["change", "changeRate", "volume"], fittedWidth(["change", "changeRate"]))).toEqual(["change", "changeRate"]);
});

test("창 폭에 따라 수급·거래대금 열도 우선순위로 빠진다", () => {
  const flow = ["price", "changeRate", "program", "whale"] as const;
  expect(fitColumns(flow, fittedWidth(flow))).toBe(flow);
  expect(fitColumns(flow, fittedWidth(flow) - 1)).toEqual(["price", "changeRate", "program"]);
  expect(fitColumns(flow, fittedWidth(["price", "changeRate"]) - 1)).toEqual(["price"]);
});
