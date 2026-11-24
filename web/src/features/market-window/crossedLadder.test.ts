import { expect, test } from "vitest";
import { type BookLevel, buildDefaultLadder, defaultLadderPrices, LADDER_ROWS, type LadderInput, ROWS_ABOVE_BASE } from "./ladder";

const level = (price: number, quantity: number): BookLevel => ({ price, quantity, change: 0 });
const side = (from: number, step: number, quantity: number) => Array.from({ length: ROWS_ABOVE_BASE }, (_, i) => level(from + step * i, quantity + i));
const input = (asks: BookLevel[], bids: BookLevel[], lastPrice: number): LadderInput => ({ asks, bids, lastPrice, previousClose: lastPrice, bounds: { lower: null, upper: null }, tickRule: "stock" });

test("매도 1호가와 매수 1호가가 같은 가격이면 매도 열 줄과 매수 열 줄을 따로 채운다", () => {
  const rows = buildDefaultLadder(input(side(855_000, 1_000, 177), side(855_000, -1_000, 45), 855_000));
  expect(rows.map((row) => row.price)).toEqual([
    864_000, 863_000, 862_000, 861_000, 860_000, 859_000, 858_000, 857_000, 856_000, 855_000,
    855_000, 854_000, 853_000, 852_000, 851_000, 850_000, 849_000, 848_000, 847_000, 846_000,
  ]);
  const upper = rows.slice(0, ROWS_ABOVE_BASE);
  const lower = rows.slice(ROWS_ABOVE_BASE);
  expect(upper.every((row) => row.ask !== null && row.bid === null)).toBe(true);
  expect(lower.every((row) => row.bid !== null && row.ask === null)).toBe(true);
  expect([upper[9]!.ask?.quantity, lower[0]!.bid?.quantity, lower[9]!.bid?.quantity]).toEqual([177, 45, 54]);
  expect(new Set(rows.map((row) => row.key)).size).toBe(LADDER_ROWS);
});

test("매수 1호가가 매도 1호가보다 높아도 매도는 위 열 줄, 매수는 아래 열 줄이다", () => {
  const rows = buildDefaultLadder(input(side(70_100, 100, 10), side(70_300, -100, 20), 70_200));
  expect([rows[9]!.price, rows[10]!.price]).toEqual([70_100, 70_300]);
  expect(rows.slice(0, 10).every((row) => row.ask !== null && row.bid === null)).toBe(true);
  expect(rows.slice(10).every((row) => row.bid !== null && row.ask === null)).toBe(true);
});

test("교차 호가를 합치지 않아도 붙은 호가와 벌어진 호가의 사다리는 그대로다", () => {
  for (const bestBid of [70_000, 69_800]) {
    const { prices, sidesSplit } = defaultLadderPrices(input(side(70_100, 100, 10), side(bestBid, -100, 20), 70_000));
    expect(sidesSplit).toBe(false);
    expect(prices).toEqual(Array.from({ length: LADDER_ROWS }, (_, i) => 71_000 - 100 * i));
  }
});
