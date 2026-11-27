import { describe, expect, it } from "vitest";
import {
  aggregateSummary,
  autoTfOf,
  buildCalendarWeeks,
  buildRoundTrips,
  buildTableGroups,
  computePeriodRange,
  matchTradeFilter,
} from "./journalEngine";
import { EMPTY_FILTERS, type StoredDayExecutions } from "./journalTypes";

const SAMPLE_HISTORY: readonly StoredDayExecutions[] = [
  {
    day: "2026-11-25",
    executions: [
      {
        orderNo: "B1",
        code: "042700",
        name: "한미반도체",
        side: "buy",
        quantity: 10,
        price: 120_000,
        time: "09:05:00",
        venue: "krx",
        mfePct: 5.5,
        maePct: -1.2,
        fillAt: null,
      },
      {
        orderNo: "B2",
        code: "042700",
        name: "한미반도체",
        side: "buy",
        quantity: 10,
        price: 124_000,
        time: "09:15:00",
        venue: "krx",
        mfePct: null,
        maePct: null,
        fillAt: null,
      },
    ],
  },
  {
    day: "2026-11-27",
    executions: [
      {
        orderNo: "S1",
        code: "042700",
        name: "한미반도체",
        side: "sell",
        quantity: 20,
        price: 130_000,
        time: "09:40:00",
        venue: "krx",
        mfePct: null,
        maePct: null,
        fillAt: null,
      },
      {
        orderNo: "B3",
        code: "000660",
        name: "SK하이닉스",
        side: "buy",
        quantity: 5,
        price: 200_000,
        time: "11:45:00",
        venue: "krx",
        mfePct: 0.4,
        maePct: -2.5,
        fillAt: null,
      },
      {
        orderNo: "B4",
        code: "000660",
        name: "SK하이닉스",
        side: "buy",
        quantity: 5,
        price: 196_000,
        time: "12:05:00",
        venue: "krx",
        mfePct: null,
        maePct: null,
        fillAt: null,
      },
      {
        orderNo: "S2",
        code: "000660",
        name: "SK하이닉스",
        side: "sell",
        quantity: 10,
        price: 192_000,
        time: "12:35:00",
        venue: "krx",
        mfePct: null,
        maePct: null,
        fillAt: null,
      },
    ],
  },
];

describe("journalEngine", () => {
  it("FIFO 라운드트립을 묶고 스윙·불타기·물타기·세후 손익을 정확히 계산한다", () => {
    const trades = buildRoundTrips(SAMPLE_HISTORY);
    expect(trades).toHaveLength(2);

    const swing = trades[0]!;
    expect(swing.code).toBe("042700");
    expect(swing.swing).toBe(true);
    expect(swing.holdDays).toBe(2);
    expect(swing.styleIdx).toBe(1);
    expect(swing.buyAmt).toBe(2_440_000);
    expect(swing.sellAmt).toBe(2_600_000);
    expect(swing.gross).toBe(160_000);
    expect(swing.net).toBe(160_000 - swing.fee - swing.tax);
    expect(autoTfOf(swing)).toBe("D");

    const intraday = trades[1]!;
    expect(intraday.code).toBe("000660");
    expect(intraday.swing).toBe(false);
    expect(intraday.holdMin).toBe(50);
    expect(intraday.styleIdx).toBe(2);
    expect(intraday.gross).toBe(-60_000);
    expect(autoTfOf(intraday)).toBe("5");
  });

  it("세후·세전 요약과 단일 조건 크로스필터가 일관되게 동작한다", () => {
    const trades = buildRoundTrips(SAMPLE_HISTORY);
    const after = aggregateSummary(trades, true);
    const before = aggregateSummary(trades, false);
    expect(before.net).toBe(100_000);
    expect(after.net).toBe(100_000 - after.cost);
    expect(after.wins).toBe(1);
    expect(after.losses).toBe(1);

    const onlySwing = trades.filter((t) => matchTradeFilter(t, { ...EMPTY_FILTERS, pair: 2 }, {}, true));
    expect(onlySwing.map((t) => t.code)).toEqual(["042700"]);

    const exceptSym = trades.filter((t) => matchTradeFilter(t, { ...EMPTY_FILTERS, sym: "042700" }, {}, true, "sym"));
    expect(exceptSym).toHaveLength(2);
  });

  it("달력 주간 합계와 표(일별·종목별) 집계가 기간 범위와 일치한다", () => {
    const trades = buildRoundTrips(SAMPLE_HISTORY);
    const range = computePeriodRange({ type: "month", anchor: "2026-11-27" }, trades, "2026-11-27");
    expect(range).toEqual(["2026-11-01", "2026-11-30"]);

    const cal = buildCalendarWeeks("2026-11-27", range, trades, false);
    const totalWeekCount = cal.weeks.reduce((s, w) => s + w.weekCount, 0);
    const totalWeekPnl = cal.weeks.reduce((s, w) => s + w.weekPnl, 0);
    expect(totalWeekCount).toBe(2);
    expect(totalWeekPnl).toBe(100_000);

    const bySym = buildTableGroups(trades, "sym", false);
    expect(bySym.map((r) => r.key)).toEqual(["042700", "000660"]);
    expect(bySym[0]!.summary.net).toBe(160_000);
    expect(bySym[1]!.summary.net).toBe(-60_000);
  });
});
