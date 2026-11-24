import { expect, test } from "vitest";
import { buildLadder } from "./ladder";
import { infoCardRows, type InfoKey, type InfoLine, type InfoPage, quoteInfoItems } from "./quoteInfo";

const known = {
  price: 70_300,
  previousClose: 70_000,
  summary: { open: 70_100, high: 71_000, low: 69_000, volume: 1_234_567, tradeValueWon: 86_790_000_000 },
  sameTimeRatio: 93.95,
  fundamentals: { upperLimit: 91_000, lowerLimit: 49_000, high52w: 88_000, low52w: 51_000, marketCap: 82_400_000_000, per: 14.21, pbr: 1.1, foreignExhaustionRate: 54.12, listedShares: 50_000_000, eps: 4_926, bps: 63_636, creditRate: 0.32 },
};
const KEYS: readonly InfoKey[] = ["open", "high", "low", "base", "volume", "value", "upper", "lower", "cap"];
const labels = (lines: readonly InfoLine[]) => lines.map((line) => (line.kind === "item" ? line.item.label : line.kind));
const shown = (page: InfoPage, flipped?: ReadonlySet<InfoKey>) => labels(quoteInfoItems(page, known, flipped));

test("정보란 1쪽과 2쪽에는 당일 범위·전일대비·52주 범위·PER·PBR·외국인소진율 칸이 없다", () => {
  expect(shown(0)).toEqual(["시가", "고가", "저가", "기준가", "거래량", "거래대금"]);
  expect(shown(1)).toEqual(["상한가", "하한가", "상승VI", "하락VI", "시가총액"]);
  expect(shown(0, new Set(KEYS))).toEqual(["시가 등락", "고가 등락", "저가 등락", "평균가", "동시간비", "회전율"]);
  expect(shown(1, new Set(KEYS))).toEqual(["상한까지", "하한까지", "상승VI", "하락VI", "상장주식"]);
});

function rowsWithBidAt(...askRows: number[]) {
  const prices = askRows.map((row) => 71_500 + 100 * (11 - row));
  return buildLadder({
    asks: [{ price: 71_600, quantity: 300, change: 0 }],
    bids: [{ price: 71_500, quantity: 450, change: 0 }, ...prices.map((price) => ({ price, quantity: 10, change: 0 }))],
    lastPrice: 71_500,
    previousClose: 70_000,
    bounds: { lower: null, upper: null },
    tickRule: "stock",
  });
}

test("정보란은 매도 10호가 옆 열 칸을 모두 쓰고 매수 잔량이 있는 행이 있으면 그 위까지만 쓴다", () => {
  expect(infoCardRows(rowsWithBidAt())).toBe(10);
  expect(infoCardRows(rowsWithBidAt(8))).toBe(7);
  expect(infoCardRows(rowsWithBidAt(1))).toBe(0);
});
