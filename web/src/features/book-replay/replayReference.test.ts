import { expect, test } from "vitest";
import type { BookReplayDay } from "../../api/generated/BookReplayDay";
import { barInterval } from "../../chart/crosshairSync";
import { buildDefaultLadder } from "../market-window/ladder";
import { tickRuleOf } from "../market-window/tick";
import { replayReference, todayRefreshDelayMs } from "./replay";

const TODAY_MIDNIGHT = Date.UTC(2026, 10, 22, 15, 0, 0) / 1000;
const DAY_SECONDS = 86_400;

test("오늘 봉은 실시간 전일 종가와 상·하한가를 쓰고, 지난 날 봉은 모두 비워 등락률 없이 상·하한 밖 호가를 남긴다", () => {
  const live = { previousClose: 70_000, bounds: { lower: 49_000, upper: 91_000 } };
  const now = TODAY_MIDNIGHT + 14 * 3600;

  expect(replayReference(TODAY_MIDNIGHT + 9 * 3600 + 299, now, live)).toEqual(live);

  const pastRef = replayReference(TODAY_MIDNIGHT - DAY_SECONDS + 9 * 3600 + 299, now, live);
  expect(pastRef).toEqual({ previousClose: null, bounds: { lower: null, upper: null } });

  const asks = [{ price: 120_000, quantity: 50, change: 0 }];
  const bids = [{ price: 119_900, quantity: 80, change: 0 }];
  const rows = buildDefaultLadder({
    asks,
    bids,
    lastPrice: 120_000,
    previousClose: pastRef.previousClose,
    bounds: pastRef.bounds,
    skipSpreadGap: false,
    tickRule: tickRuleOf("common", [120_000, 119_900]),
  });
  expect(rows.some((row) => row.price === 120_000 && row.ask?.quantity === 50)).toBe(true);
  expect(rows.some((row) => row.price === 119_900 && row.bid?.quantity === 80)).toBe(true);
  expect(rows.every((row) => row.rate === null)).toBe(true);
});

test("오늘 마감 봉이 미수집이면 응답 나이에 따라 즉시 또는 남은 시간 뒤에 다시 받는다", () => {
  const at = (hour: number, minute: number) => TODAY_MIDNIGHT + hour * 3600 + minute * 60;
  const day: BookReplayDay = {
    symbol: "005930",
    date: "20261123",
    coverage: "collected",
    covered: [[540, 544]],
    books: [{ minute: 540, asks: [[71_200, 10]], bids: [[71_100, 20]], totalAsk: 10, totalBid: 20 }],
    trades: [],
  };
  const bar0900 = barInterval(at(9, 0), "5m");
  const bar0905 = barInterval(at(9, 5), "5m");
  const bar0910 = barInterval(at(9, 10), "5m");
  const now = at(9, 12);

  expect(todayRefreshDelayMs(day, bar0900, now, 1000, 25_000, 20_000)).toBeNull();
  expect(todayRefreshDelayMs(day, bar0910, now, 1000, 25_000, 20_000)).toBeNull();
  expect(todayRefreshDelayMs(day, bar0905, now, 1000, 25_000, 20_000)).toBe(0);
  expect(todayRefreshDelayMs(day, bar0905, now, 1000, 13_000, 20_000)).toBe(8_000);
  expect(todayRefreshDelayMs({ ...day, coverage: "day_not_collected", covered: [] }, bar0905, now, 1000, 21_000, 20_000)).toBe(0);
  expect(todayRefreshDelayMs(day, barInterval(at(9, 5) - DAY_SECONDS, "5m"), now, 1000, 25_000, 20_000)).toBeNull();
});
