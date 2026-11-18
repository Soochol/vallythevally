import { expect, test } from "vitest";
import { basePrice, buildLadder, buildLadderRows, gridPrices, LADDER_ROWS, ratioSplit, type BookLevel } from "./ladder";

const NO_BOUNDS = { lower: null, upper: null };
const level = (price: number, quantity: number, change = 0): BookLevel => ({ price, quantity, change });
const build = (input: Partial<Parameters<typeof buildLadder>[0]>) => buildLadder({ asks: [], bids: [], lastPrice: null, previousClose: null, bounds: NO_BOUNDS, tickRule: "stock", ...input });
const prices = (rows: ReturnType<typeof buildLadder>) => rows.map((row) => row.price);
const rowAt = (rows: ReturnType<typeof buildLadder>, price: number) => rows.find((row) => row.price === price)!;

test("기준 가격 위 10틱과 아래 10행(기준 포함)의 가격이 나온다", () => {
  const rows = build({ lastPrice: 70_000 });
  expect(rows).toHaveLength(LADDER_ROWS);
  expect(prices(rows)).toEqual([
    71_000, 70_900, 70_800, 70_700, 70_600, 70_500, 70_400, 70_300, 70_200, 70_100,
    70_000, 69_900, 69_800, 69_700, 69_600, 69_500, 69_400, 69_300, 69_200, 69_100,
  ]);
});

test("틱 경계(20,000원 아래 10원, 위 50원)를 넘는 격자가 맞는 틱으로 이어진다", () => {
  const rows = build({ lastPrice: 20_000 });
  expect(prices(rows)).toEqual([
    20_500, 20_450, 20_400, 20_350, 20_300, 20_250, 20_200, 20_150, 20_100, 20_050,
    20_000, 19_990, 19_980, 19_970, 19_960, 19_950, 19_940, 19_930, 19_920, 19_910,
  ]);
});

test("교차 호가(매도 1호가 ≤ 매수 1호가)는 같은 가격 행에 매도·매수 잔량이 함께 있고 같은 가격 행이 둘이 아니다", () => {
  const rows = build({ asks: [level(70_000, 30), level(70_100, 20)], bids: [level(70_100, 25), level(70_000, 15)], lastPrice: 70_100 });
  const shown = prices(rows).filter((price) => price !== null);
  expect(new Set(shown).size).toBe(shown.length);
  expect([rowAt(rows, 70_100).ask?.quantity, rowAt(rows, 70_100).bid?.quantity]).toEqual([20, 25]);
  expect([rowAt(rows, 70_000).ask?.quantity, rowAt(rows, 70_000).bid?.quantity]).toEqual([30, 15]);
  expect(rows.filter((row) => row.current).map((row) => row.price)).toEqual([70_100]);
});

test("상한·하한 밖의 행은 빈 행이다", () => {
  const nearUpper = build({ lastPrice: 70_800, bounds: { lower: 49_000, upper: 71_000 } });
  expect(prices(nearUpper).slice(0, 10)).toEqual([null, null, null, null, null, null, null, null, 71_000, 70_900]);
  const nearLower = build({ lastPrice: 50_000, bounds: { lower: 49_900, upper: 91_000 } });
  expect(prices(nearLower).slice(-10)).toEqual([50_000, 49_950, 49_900, null, null, null, null, null, null, null]);
  expect(nearUpper.filter((row) => row.price === null).every((row) => row.ask === null && row.bid === null && row.rate === null)).toBe(true);
});

test("현재가가 없으면 매수 1호가, 그것도 없으면 기준가가 기준이다", () => {
  const quotes = { asks: [level(70_100, 5)], bids: [level(69_800, 3), level(70_000, 7)], previousClose: 69_000 };
  expect(basePrice({ ...quotes, lastPrice: 70_500 })).toBe(70_500);
  expect(basePrice({ ...quotes, lastPrice: null })).toBe(70_000);
  expect(basePrice({ asks: quotes.asks, bids: [], lastPrice: null, previousClose: 69_000 })).toBe(69_000);
  expect(basePrice({ asks: [], bids: [], lastPrice: null, previousClose: null })).toBeNull();
  expect(prices(build({ ...quotes, lastPrice: null }))[10]).toBe(70_000);
  expect(prices(build({ lastPrice: null })).every((price) => price === null)).toBe(true);
});

test("받은 단 가운데 격자에 들지 않는 가격은 행에 없다", () => {
  const rows = build({ asks: [level(71_000, 1), level(71_100, 2)], bids: [level(69_100, 3), level(69_000, 4), level(70_050, 5)], lastPrice: 70_000 });
  expect(rows.some((row) => row.ask?.price === 71_100 || row.bid?.price === 69_000)).toBe(false);
  expect(rows.filter((row) => row.ask || row.bid).map((row) => row.price)).toEqual([71_000, 69_100]);
});

test("막대 비율은 보이는 행의 최대 잔량 기준이다", () => {
  const rows = build({ asks: [level(70_100, 50), level(70_200, 400)], bids: [level(70_000, 200)], lastPrice: 70_000 });
  expect([rowAt(rows, 70_100).askRatio, rowAt(rows, 70_200).askRatio, rowAt(rows, 70_000).bidRatio]).toEqual([0.125, 1, 0.5]);
  expect(rows.filter((row) => !row.ask && !row.bid).every((row) => row.askRatio === 0 && row.bidRatio === 0)).toBe(true);
});

test("격자 밖 먼 호가는 막대 기준에 들지 않는다", () => {
  const rows = build({ asks: [level(70_100, 10), level(75_000, 1_000_000)], bids: [], lastPrice: 70_000 });
  expect(rowAt(rows, 70_100).askRatio).toBe(1);
});

test("현재가 행만 표시하고 등락률은 전일 종가 기준으로 값이 있는 모든 행에 있다", () => {
  const rows = build({ lastPrice: 70_000, previousClose: 56_000 });
  expect(rows.filter((row) => row.current).map((row) => row.price)).toEqual([70_000]);
  expect(rowAt(rows, 70_000).rate).toBe(25);
  expect(rowAt(rows, 70_100).rate).toBeCloseTo(25.1786, 3);
  expect(rows.every((row) => row.rate !== null)).toBe(true);
});

test("전일 종가가 없으면 등락률도 없고 빈 행도 등락률이 없다", () => {
  const rows = build({ lastPrice: 70_000, bounds: { lower: 69_000, upper: 70_300 } });
  expect(rows.every((row) => row.rate === null)).toBe(true);
});

test("잔량에 NaN·음수가 있어도 나머지 막대는 정상이고 그 행은 0이다", () => {
  const rows = build({ asks: [level(70_100, Number.NaN), level(70_200, -5)], bids: [level(70_000, 8), level(69_900, 4)], lastPrice: 70_000 });
  expect([rowAt(rows, 70_200).askRatio, rowAt(rows, 70_100).askRatio, rowAt(rows, 70_000).bidRatio, rowAt(rows, 69_900).bidRatio]).toEqual([0, 0, 1, 0.5]);
});

test("격자 가격 목록은 기준이 없으면 모두 비고 있으면 내림차순이다", () => {
  expect(gridPrices(null, NO_BOUNDS, "stock")).toEqual(Array(LADDER_ROWS).fill(null));
  const listed = gridPrices(70_000, NO_BOUNDS, "stock") as number[];
  expect(listed).toEqual([...listed].sort((a, b) => b - a));
});

test("가격 목록을 직접 주면 그 가격으로 행을 만든다", () => {
  const rows = buildLadderRows([70_300, 70_200, null], { asks: [level(70_200, 40)], bids: [], lastPrice: 70_300, previousClose: 70_000 });
  expect(rows.map((row) => [row.price, row.ask?.quantity ?? null, row.current])).toEqual([[70_300, null, true], [70_200, 40, false], [null, null, false]]);
});

test("매수·매도 비율은 합이 100이고 둘 다 0이면 반반이다", () => {
  expect(ratioSplit(3, 1)).toEqual({ buy: 75, sell: 25 });
  expect(ratioSplit(0, 0)).toEqual({ buy: 50, sell: 50 });
});

test("ETF 호가 단위(2,000원 이상 5원)로 만든 격자에 받은 스무 단이 모두 자기 행에 있다", () => {
  const asks = Array.from({ length: 10 }, (_, i) => level(35_010 + 5 * i, 100 + i));
  const bids = Array.from({ length: 10 }, (_, i) => level(35_005 - 5 * i, 200 + i));
  const rows = build({ asks, bids, lastPrice: 35_005, tickRule: "etf" });
  expect(prices(rows)[0]).toBe(35_055);
  expect(prices(rows)[10]).toBe(35_005);
  expect(prices(rows)[19]).toBe(34_960);
  expect(rows.filter((row) => row.ask || row.bid)).toHaveLength(20);
  expect(rows.filter((row) => row.ask && row.bid)).toHaveLength(0);
});

test("기준 가격이 0·NaN·음수이면 매수 1호가, 그것도 못 쓰면 기준가로 넘어간다", () => {
  const bids = [level(70_000, 3), level(69_900, 4)];
  for (const lastPrice of [0, Number.NaN, -100]) {
    expect(basePrice({ asks: [], bids, lastPrice, previousClose: 69_000 })).toBe(70_000);
    expect(basePrice({ asks: [], bids: [], lastPrice, previousClose: 69_000 })).toBe(69_000);
    expect(basePrice({ asks: [], bids: [], lastPrice, previousClose: Number.NaN })).toBeNull();
  }
  expect(basePrice({ asks: [], bids: [level(Number.NaN, 1), level(0, 1), level(69_900, 4)], lastPrice: null, previousClose: null })).toBe(69_900);
  expect(prices(build({ bids, lastPrice: 0 }))[10]).toBe(70_000);
});

test("같은 가격의 단이 둘이면 잔량과 증감을 합친다", () => {
  const rows = build({ asks: [level(70_100, 5, 1), level(70_100, 7, 2)], bids: [], lastPrice: 70_000 });
  expect(rowAt(rows, 70_100).ask).toEqual({ price: 70_100, quantity: 12, change: 3 });
  expect(rowAt(rows, 70_100).askRatio).toBe(1);
});
