import { expect, test } from "vitest";
import { type InfoLine, quoteInfoItems } from "./quoteInfo";

const known = {
  price: 70_300,
  previousClose: 70_000,
  summary: { open: 70_100, high: 71_000, low: 69_000, volume: 1_234_567, tradeValueWon: 86_790_000_000 },
  sameTimeRatio: 93.95,
  fundamentals: { upperLimit: 91_000, lowerLimit: 49_000, marketCap: 82_400_000_000, listedShares: 50_000_000 },
};
const unknown = { price: null, previousClose: null, summary: null, sameTimeRatio: null, fundamentals: null };

const PAGE_0 = ["open", "high", "low", "base", "volume", "value"] as const;
const PAGE_1 = ["upper", "lower", "cap"] as const;
const shown = (lines: readonly InfoLine[]) => lines.map((line) => [line.item.label, line.item.value, line.item.tone]);

test("시세 쪽 칸을 바꾸면 그 칸만 다른 이름·값이 되고 나머지는 그대로다", () => {
  expect(shown(quoteInfoItems(0, known, new Set(PAGE_0)))).toEqual([
    ["시가 등락", "+0.14%", "up"],
    ["고가 등락", "+1.43%", "up"],
    ["저가 등락", "−1.43%", "down"],
    ["평균가", "70,300", "up"],
    ["동시간비", "93.95%", null],
    ["회전율", "2.47%", null],
  ]);
  const before = shown(quoteInfoItems(0, known));
  const after = shown(quoteInfoItems(0, known, new Set(["high"])));
  expect(before.map(([label]) => label)).toEqual(["시가", "고가", "저가", "기준가", "거래량", "거래대금"]);
  expect(after).toEqual(before.map((row) => (row[0] === "고가" ? ["고가 등락", "+1.43%", "up"] : row)));
});

test("종목 쪽 칸을 바꾸면 상·하한까지 남은 폭과 상장주식이 된다", () => {
  const lines = quoteInfoItems(1, known, new Set(PAGE_1));
  expect(shown(lines)).toEqual([
    ["상한까지", "+29.45%", "up"],
    ["하한까지", "−30.30%", "down"],
    ["상장주식", "5,000만주", null],
  ]);
});

test("모르는 값으로 바꾼 칸은 대시다", () => {
  for (const [page, keys] of [[0, PAGE_0], [1, PAGE_1]] as const) {
    const lines = quoteInfoItems(page, unknown, new Set(keys));
    expect(lines.every((line) => line.kind === "item" && line.item.value === "-" && line.item.tone === null)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  }
});
