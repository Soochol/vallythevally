import { expect, test } from "vitest";
import type { WhaleEvent } from "../../api/generated/WhaleEvent";
import { aggregateWhaleRows, filterWhaleEvents, formatWhaleWon, parseCustomWon, WHALE_MIN_PRESETS } from "./whaleModel";

const sample = (overrides: Partial<WhaleEvent>): WhaleEvent => ({
  id: 1,
  at: 1_764_205_200,
  symbol: "005930",
  side: "buy",
  price: 78_000,
  quantity: 1_000,
  amountWon: 100_000_000,
  ...overrides,
});

test("최소 금액 프리셋은 3천만~5억+ 다섯 단계다", () => {
  expect(WHALE_MIN_PRESETS.map((p) => [p.label, p.minWon])).toEqual([
    ["3천", 30_000_000],
    ["5천", 50_000_000],
    ["1억", 100_000_000],
    ["3억", 300_000_000],
    ["5억+", 500_000_000],
  ]);
});

test("사용자 정의 금액 문자열을 원 단위로 변환한다", () => {
  expect(parseCustomWon("2억")).toBe(200_000_000);
  expect(parseCustomWon("1.5억")).toBe(150_000_000);
  expect(parseCustomWon("4000만")).toBe(40_000_000);
  expect(parseCustomWon("3천")).toBe(30_000_000);
  expect(parseCustomWon("500만")).toBe(10_000_000);
  expect(parseCustomWon("")).toBeNull();
  expect(parseCustomWon("abc")).toBeNull();
});

test("금액·방향·검색어로 필터링하고 종목별 순매수/횟수로 집계한다", () => {
  const events: WhaleEvent[] = [
    sample({ id: 1, symbol: "005930", side: "buy", amountWon: 35_000_000 }),
    sample({ id: 2, symbol: "005930", side: "sell", amountWon: 120_000_000 }),
    sample({ id: 3, symbol: "000660", side: "buy", amountWon: 250_000_000 }),
  ];
  const names: Record<string, string> = { "005930": "삼성전자", "000660": "SK하이닉스" };
  const nameOf = (code: string) => names[code] ?? code;

  expect(filterWhaleEvents(events, 30_000_000, "all", "", nameOf)).toHaveLength(3);
  expect(filterWhaleEvents(events, 100_000_000, "all", "", nameOf)).toHaveLength(2);
  expect(filterWhaleEvents(events, 30_000_000, "buy", "하이닉스", nameOf).map((e) => e.id)).toEqual([3]);

  const byCount = aggregateWhaleRows(events, "count", nameOf);
  expect(byCount.map((r) => r.symbol)).toEqual(["005930", "000660"]);
  expect(byCount[0]!.netWon).toBe(-85_000_000);

  const byNet = aggregateWhaleRows(events, "net", nameOf);
  expect(byNet.map((r) => r.symbol)).toEqual(["000660", "005930"]);
  expect(formatWhaleWon(250_000_000, true)).toBe("+2.50억");
});
