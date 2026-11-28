import { expect, test } from "vitest";
import type { BookReplayDay } from "../../api/generated/BookReplayDay";
import { barInterval } from "../../chart/crosshairSync";
import { buildDefaultLadder } from "../market-window/ladder";
import { tickRuleOf } from "../market-window/tick";
import { replayReference, resolveReplayPreviousClose, todayRefreshDelayMs } from "./replay";

const TODAY_MIDNIGHT = Date.UTC(2026, 10, 22, 15, 0, 0) / 1000;
const DAY_SECONDS = 86_400;

test("오늘 봉은 당일 기준가와 상·하한가를 쓰고, 지난 날 봉은 해당 날짜 기준가를 쓰되 상·하한가만 비워 밖 호가를 남긴다", () => {
  const live = { previousClose: 70_000, bounds: { lower: 49_000, upper: 91_000 } };
  const now = TODAY_MIDNIGHT + 14 * 3600;

  expect(replayReference(TODAY_MIDNIGHT + 9 * 3600 + 299, now, live, null)).toEqual(live);
  expect(replayReference(TODAY_MIDNIGHT + 9 * 3600 + 299, now, live, 70_500)).toEqual({
    previousClose: 70_500,
    bounds: live.bounds,
  });

  const pastWithoutBase = replayReference(TODAY_MIDNIGHT - DAY_SECONDS + 9 * 3600 + 299, now, live, null);
  expect(pastWithoutBase).toEqual({ previousClose: null, bounds: { lower: null, upper: null } });

  const pastWithBase = replayReference(TODAY_MIDNIGHT - DAY_SECONDS + 9 * 3600 + 299, now, live, 119_000);
  expect(pastWithBase).toEqual({ previousClose: 119_000, bounds: { lower: null, upper: null } });

  const asks = [{ price: 120_000, quantity: 50, change: 0 }];
  const bids = [{ price: 119_900, quantity: 80, change: 0 }];
  const rowsNoBase = buildDefaultLadder({
    asks,
    bids,
    lastPrice: 120_000,
    previousClose: pastWithoutBase.previousClose,
    bounds: pastWithoutBase.bounds,
    skipSpreadGap: false,
    tickRule: tickRuleOf("common", [120_000, 119_900]),
  });
  expect(rowsNoBase.some((row) => row.price === 120_000 && row.ask?.quantity === 50)).toBe(true);
  expect(rowsNoBase.some((row) => row.price === 119_900 && row.bid?.quantity === 80)).toBe(true);
  expect(rowsNoBase.every((row) => row.rate === null)).toBe(true);

  const rowsWithBase = buildDefaultLadder({
    asks,
    bids,
    lastPrice: 120_000,
    previousClose: pastWithBase.previousClose,
    bounds: pastWithBase.bounds,
    skipSpreadGap: false,
    tickRule: tickRuleOf("common", [120_000, 119_900]),
  });
  const askRow = rowsWithBase.find((row) => row.price === 120_000);
  const bidRow = rowsWithBase.find((row) => row.price === 119_900);
  expect(askRow?.ask?.quantity).toBe(50);
  expect(askRow?.rate).toBeCloseTo(((120_000 - 119_000) / 119_000) * 100, 6);
  expect(bidRow?.bid?.quantity).toBe(80);
  expect(bidRow?.rate).toBeCloseTo(((119_900 - 119_000) / 119_000) * 100, 6);
});

test("마지막 거래일에서 자정이 지나 다음날이 되어도 해당 거래일의 수집 기준가는 유지되고 없으면 null이다", () => {
  const live = { previousClose: 72_000, bounds: { lower: 50_400, upper: 93_600 } };
  const lastTradingBar = TODAY_MIDNIGHT + 15 * 3600 + 29 * 60 + 59;
  const nextDayMorning = TODAY_MIDNIGHT + DAY_SECONDS + 8 * 3600;

  expect(replayReference(lastTradingBar, nextDayMorning, live, 70_000)).toEqual({
    previousClose: 70_000,
    bounds: { lower: null, upper: null },
  });
  expect(replayReference(lastTradingBar, nextDayMorning, live, null)).toEqual({
    previousClose: null,
    bounds: { lower: null, upper: null },
  });
  expect(resolveReplayPreviousClose(70_000, false, 72_000)).toBe(70_000);
  expect(resolveReplayPreviousClose(null, false, 72_000)).toBeNull();
  expect(resolveReplayPreviousClose(null, true, 72_000)).toBe(72_000);
  expect(resolveReplayPreviousClose(0, true, 72_000)).toBe(72_000);
});

test("오늘 마감 봉이 미수집이면 응답 나이에 따라 즉시 또는 남은 시간 뒤에 다시 받는다", () => {
  const at = (hour: number, minute: number) => TODAY_MIDNIGHT + hour * 3600 + minute * 60;
  const day: BookReplayDay = {
    symbol: "005930",
    date: "20261123",
    coverage: "collected",
    previousClose: 70_000,
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
