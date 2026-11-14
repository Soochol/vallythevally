import { expect, test } from "vitest";
import { allowsMany, WINDOW_KIND_LIST, WINDOW_KINDS } from "./kinds";

test("창 종류는 다섯 가지이고 차트만 여러 개를 둘 수 있다", () => {
  expect(WINDOW_KIND_LIST).toEqual(["chart", "watchlist", "screener", "objects", "indicators"]);
  expect(WINDOW_KIND_LIST.filter(allowsMany)).toEqual(["chart"]);
  expect(WINDOW_KINDS.chart.maxCount).toBe(8);
});

test("차트는 넓은 자리에서 따르고 관심종목·스크리너는 옆 자리에서 보낸다", () => {
  expect(WINDOW_KIND_LIST.map((kind) => [kind, WINDOW_KINDS[kind].home, WINDOW_KINDS[kind].link])).toEqual([
    ["chart", "wide", "follows"],
    ["watchlist", "side", "sends"],
    ["screener", "side", "sends"],
    ["objects", "side", "none"],
    ["indicators", "side", "none"],
  ]);
});
