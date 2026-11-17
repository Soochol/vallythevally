import { expect, test } from "vitest";
import { buildLadder, LADDER_DEPTH, ratioSplit, type BookLevel } from "./ladder";

const level = (price: number, quantity: number, change = 0): BookLevel => ({ price, quantity, change });
const run = (from: number, step: number, count: number, quantity: (i: number) => number): BookLevel[] =>
  Array.from({ length: count }, (_, i) => level(from + step * i, quantity(i)));
const prices = (rows: ReturnType<typeof buildLadder>, side: "ask" | "bid") => rows.filter((r) => r.side === side).map((r) => r.level?.price ?? null);

test("호가가 10단보다 적어도 행은 매도 10·매수 10으로 스무 개다", () => {
  const rows = buildLadder({ asks: [level(101, 5)], bids: [level(100, 7), level(99, 3)], lastPrice: 100, previousClose: 100 });
  expect(rows).toHaveLength(2 * LADDER_DEPTH);
  expect(rows.filter((r) => r.side === "ask")).toHaveLength(LADDER_DEPTH);
  expect(rows.filter((r) => r.side === "bid")).toHaveLength(LADDER_DEPTH);
  expect(rows.filter((r) => r.level === null)).toHaveLength(2 * LADDER_DEPTH - 3);
});

test("빈 자리는 가격에서 먼 쪽에 둔다: 매도는 위, 매수는 아래", () => {
  const rows = buildLadder({ asks: [level(101, 5)], bids: [level(100, 7)], lastPrice: null, previousClose: null });
  expect(rows[LADDER_DEPTH - 1]!.level?.price).toBe(101);
  expect(rows[LADDER_DEPTH]!.level?.price).toBe(100);
  expect(rows[0]!.level).toBeNull();
  expect(rows.at(-1)!.level).toBeNull();
});

test("교차 호가(매수 1호가 ≥ 매도 1호가)에서도 매도·매수 행은 각각 가격 내림차순이다", () => {
  const rows = buildLadder({ asks: run(100, 1, 10, () => 1), bids: run(95, 1, 10, () => 1).map((l) => ({ ...l, price: l.price + 5 })), lastPrice: 102, previousClose: 100 });
  const asks = prices(rows, "ask") as number[];
  const bids = prices(rows, "bid") as number[];
  expect(bids[0]!).toBeGreaterThanOrEqual(asks.at(-1)!);
  expect(asks).toEqual([...asks].sort((a, b) => b - a));
  expect(bids).toEqual([...bids].sort((a, b) => b - a));
});

test("입력 순서가 뒤섞여도 정렬하고 가격에 가장 가까운 10단만 남긴다", () => {
  const rows = buildLadder({ asks: run(101, 1, 12, () => 1).reverse(), bids: run(80, 1, 12, () => 1), lastPrice: null, previousClose: null });
  expect(prices(rows, "ask")).toEqual([110, 109, 108, 107, 106, 105, 104, 103, 102, 101]);
  expect(prices(rows, "bid")).toEqual([91, 90, 89, 88, 87, 86, 85, 84, 83, 82]);
});

test("막대 비율은 보이는 행의 최대 잔량 기준이다", () => {
  const rows = buildLadder({ asks: [level(101, 50), level(102, 400)], bids: [level(100, 200)], lastPrice: null, previousClose: null });
  const ratio = (price: number) => rows.find((r) => r.level?.price === price)!.barRatio;
  expect([ratio(101), ratio(102), ratio(100)]).toEqual([0.125, 1, 0.5]);
  expect(rows.filter((r) => r.level === null).every((r) => r.barRatio === 0)).toBe(true);
});

test("11번째 이후 먼 호가는 보이지 않으므로 막대 기준에 들지 않는다", () => {
  const far = run(101, 1, 11, (i) => (i === 10 ? 1_000_000 : 10));
  const rows = buildLadder({ asks: far, bids: [], lastPrice: null, previousClose: null });
  expect(Math.max(...rows.map((r) => r.barRatio))).toBe(1);
  expect(rows.find((r) => r.level?.price === 101)!.barRatio).toBe(1);
});

test("현재가 행만 표시하고 등락률은 전일 종가 기준이다", () => {
  const rows = buildLadder({ asks: [level(101, 5)], bids: [level(100, 7)], lastPrice: 100, previousClose: 80 });
  expect(rows.filter((r) => r.current).map((r) => r.level?.price)).toEqual([100]);
  expect(rows.find((r) => r.level?.price === 100)!.rate).toBe(25);
  expect(rows.find((r) => r.level?.price === 101)!.rate).toBe(26.25);
});

test("전일 종가가 없으면 등락률도 없다", () => {
  const rows = buildLadder({ asks: [level(101, 5)], bids: [], lastPrice: null, previousClose: null });
  expect(rows.every((r) => r.rate === null)).toBe(true);
});

test("매수·매도 비율은 합이 100이고 둘 다 0이면 반반이다", () => {
  expect(ratioSplit(3, 1)).toEqual({ buy: 75, sell: 25 });
  expect(ratioSplit(0, 0)).toEqual({ buy: 50, sell: 50 });
});
