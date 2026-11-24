import { expect, test } from "vitest";
import type { BookReplayDay } from "../../api/generated/BookReplayDay";
import { barInterval } from "../../chart/crosshairSync";
import { replayDate, replayView } from "./replay";

const MIDNIGHT = Date.UTC(2026, 10, 22, 15, 0, 0) / 1000;
const at = (hour: number, minute: number, second = 0) => MIDNIGHT + hour * 3600 + minute * 60 + second;
const fiveMinutes = (hour: number, minute: number) => barInterval(at(hour, minute), "5m");
const LATER = at(23, 0);

const DAY: BookReplayDay = {
  symbol: "005930",
  date: "20261123",
  coverage: "collected",
  covered: [[540, 600], [602, 900]],
  books: [
    { minute: 540, asks: [[71_200, 30], [71_300, 31]], bids: [[71_100, 60]], totalAsk: 300, totalBid: 600 },
    { minute: 542, asks: [[71_300, 40], [71_400, 41]], bids: [[71_200, 80], [71_100, 82]], totalAsk: 400, totalBid: 800 },
    { minute: 560, asks: [[72_000, 1]], bids: [], totalAsk: 1, totalBid: 0 },
  ],
  trades: [
    ...Array.from({ length: 10 }, (_, i): [number, number, number, number] => [540, 32_400 + i, 71_000 + i, i + 1]),
    [542, 32_521, 71_210, -5],
    [542, 32_522, 71_220, 6],
    [542, 32_523, 71_230, -7],
    [560, 33_600, 72_000, 9],
  ],
};

const reason = (day: BookReplayDay, bar = fiveMinutes(9, 0), now = LATER) => {
  const view = replayView(day, bar, now);
  return view.kind === "none" ? view.reason : view.kind;
};

test("봉의 마지막 분 호가와 그때까지의 체결 10건을 준다", () => {
  const view = replayView(DAY, fiveMinutes(9, 0), LATER);
  if (view.kind !== "past") throw new Error(`past가 아닙니다: ${JSON.stringify(view)}`);
  expect(view.at).toBe(at(9, 4, 59));
  expect(view.book.asks).toEqual([{ price: 71_300, quantity: 40, change: 0 }, { price: 71_400, quantity: 41, change: 0 }]);
  expect(view.book.bids).toEqual([{ price: 71_200, quantity: 80, change: 0 }, { price: 71_100, quantity: 82, change: 0 }]);
  expect([view.book.totalAsk, view.book.totalBid, view.book.expected]).toEqual([400, 800, null]);
  expect(view.lastPrice).toBe(71_230);
  expect(view.trades.map((trade) => [trade.secondOfDay, trade.price, trade.quantity, trade.side])).toEqual([
    [32_523, 71_230, 7, "sell"],
    [32_522, 71_220, 6, "buy"],
    [32_521, 71_210, 5, "sell"],
    ...Array.from({ length: 7 }, (_, i) => [32_409 - i, 71_009 - i, 10 - i, "buy"]),
  ]);
  expect(new Set(view.trades.map((trade) => trade.key)).size).toBe(10);

  const oneMinute = replayView(DAY, barInterval(at(9, 0), "1m"), LATER);
  expect(oneMinute.kind === "past" && [oneMinute.at, oneMinute.book.asks[0]?.price, oneMinute.lastPrice]).toEqual([at(9, 0, 59), 71_200, 71_009]);
  const quiet = replayView(DAY, barInterval(at(9, 30), "3m"), LATER);
  expect(quiet.kind === "past" && quiet.book.asks[0]?.price).toBe(72_000);
  const noTrades = replayView({ ...DAY, trades: [] }, fiveMinutes(9, 0), LATER);
  expect(noTrades.kind === "past" && [noTrades.lastPrice, noTrades.trades]).toEqual([null, []]);
  expect(replayDate(fiveMinutes(9, 0))).toBe("20261123");
  expect(replayDate(fiveMinutes(0, 5))).toBe("20261123");
});

test("수집 호가가 없는 봉은 이유마다 다른 글을 준다", () => {
  expect(reason(DAY, fiveMinutes(9, 0), at(9, 4, 59))).toBe("아직 진행 중인 봉입니다");
  expect(reason(DAY, fiveMinutes(9, 0), at(9, 5))).toBe("past");
  const empty = { covered: [], books: [], trades: [] };
  expect(reason({ ...DAY, ...empty, coverage: "day_not_collected" })).toBe("이 날은 수집하지 않았습니다");
  expect(reason({ ...DAY, ...empty, coverage: "symbol_not_collected" })).toBe("수집하지 않는 종목입니다");
  expect(reason(DAY, barInterval(at(10, 1), "1m"))).toBe("수집이 끊긴 시각입니다");
  expect(reason(DAY, barInterval(at(10, 0), "1m"))).toBe("past");
  expect(reason(DAY, barInterval(at(15, 1), "1m"))).toBe("아직 수집되지 않은 구간입니다");
  expect(reason(DAY, barInterval(at(15, 0), "1m"))).toBe("past");
  expect(reason(DAY, barInterval(at(8, 50), "5m"))).toBe("이 시각의 수집 호가가 없습니다");
  expect(reason({ ...DAY, ...empty })).toBe("이 시각의 수집 호가가 없습니다");
});
