import { expect, test } from "vitest";
import type { Bar } from "../api/generated/Bar";
import { type LegendBar, legendParts, ohlcRow } from "./legend";

const bar = (over: Partial<Bar>): Bar => ({ t: 1_735_689_600, o: 71_200, h: 72_000, l: 70_000, c: 70_600, v: 1_234_567, ...over });
const parts = (prev: Bar | null) => legendParts({ bar: bar({}), prev, isCurrent: false, isIndex: false, period: "D", stalledAt: null } satisfies LegendBar);

test("시·고·저·종마다 직전 봉 종가 대비 등락률과 방향을 붙이고 거래량에는 붙이지 않는다", () => {
  expect(parts(bar({ c: 70_600 })).cells).toEqual([
    ["시", "71,200", { text: "+0.85%", dir: "up" }],
    ["고", "72,000", { text: "+1.98%", dir: "up" }],
    ["저", "70,000", { text: "−0.85%", dir: "down" }],
    ["종", "70,600", { text: "0.00%", dir: "flat" }],
    ["량", "123만", null],
  ]);
});

test("직전 봉이 없거나 직전 봉 종가가 0이면 등락률을 붙이지 않는다", () => {
  for (const prev of [null, bar({ c: 0 })]) {
    expect(parts(prev).cells.map(([, , change]) => change)).toEqual([null, null, null, null, null]);
  }
});

test("봉 값 줄을 끄면 등락률 스위치와 상관없이 숨기고, 켜면 등락률 스위치를 따른다", () => {
  expect(ohlcRow({ showOhlc: false, showOhlcChange: true })).toBe("hidden");
  expect(ohlcRow({ showOhlc: false, showOhlcChange: false })).toBe("hidden");
  expect(ohlcRow({ showOhlc: true, showOhlcChange: false })).toBe("values");
  expect(ohlcRow({ showOhlc: true, showOhlcChange: true })).toBe("valuesWithChange");
});
