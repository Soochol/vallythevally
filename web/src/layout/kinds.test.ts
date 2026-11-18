import { expect, test } from "vitest";
import { allowsMany, isSingleton, MAX_WINDOWS, WINDOW_KIND_LIST, WINDOW_KINDS } from "./kinds";

test("창 종류는 아홉 가지이고 지표만 하나이며 차트는 8개, 나머지는 창 상한까지 둘 수 있다", () => {
  expect(WINDOW_KIND_LIST).toEqual(["chart", "watchlist", "screener", "indicators", "trades", "book", "program", "brokers", "order"]);
  expect(WINDOW_KIND_LIST.filter(isSingleton)).toEqual(["indicators"]);
  expect(WINDOW_KIND_LIST.filter(allowsMany)).toEqual(WINDOW_KIND_LIST.filter((kind) => kind !== "indicators"));
  expect(WINDOW_KINDS.chart.maxCount).toBe(8);
  expect(MAX_WINDOWS).toBe(50);
  expect(WINDOW_KIND_LIST.filter((kind) => kind !== "chart" && kind !== "indicators").map((kind) => WINDOW_KINDS[kind].maxCount)).toEqual(Array(7).fill(MAX_WINDOWS));
});

test("차트와 시세 창은 연동 색을 따르고 관심종목·스크리너는 보낸다", () => {
  expect(WINDOW_KIND_LIST.map((kind) => [kind, WINDOW_KINDS[kind].home, WINDOW_KINDS[kind].link])).toEqual([
    ["chart", "wide", "follows"],
    ["watchlist", "side", "sends"],
    ["screener", "side", "sends"],
    ["indicators", "side", "none"],
    ["trades", "side", "follows"],
    ["book", "side", "follows"],
    ["program", "side", "follows"],
    ["brokers", "wide", "follows"],
    ["order", "wide", "follows"],
  ]);
});

test("시세 창의 이름과 최소 크기는 제안을 따른다", () => {
  expect(["trades", "book", "program", "brokers"].map((kind) => [WINDOW_KINDS[kind as "trades"].name, WINDOW_KINDS[kind as "trades"].minSize])).toEqual([
    ["체결", { w: 220, h: 200 }],
    ["10호가", { w: 280, h: 300 }],
    ["프로그램 체결", { w: 260, h: 240 }],
    ["거래원 입체분석", { w: 360, h: 300 }],
  ]);
});
