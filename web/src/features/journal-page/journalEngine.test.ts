import { describe, expect, it } from "vitest";
import {
  aggregateSummary,
  autoTfOf,
  buildCalendarWeeks,
  buildRoundTrips,
  buildTableGroups,
  computeHistoryQueryRange,
  computePeriodRange,
  matchTradeFilter,
  synthesizeDemoBars,
  tfStepMinutes,
} from "./journalEngine";
import { combineDayExecutionsWithForensics } from "./journalNotes";
import { useJournalStore } from "./journalStore";
import { EMPTY_FILTERS, JOURNAL_TFS, TF_TO_PERIOD, type StoredDayExecutions } from "./journalTypes";

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

  it("기간별 이력 조회 범위를 계산하고 월 경계 주간·전체 기간을 빠짐없이 포함한다", () => {
    expect(computeHistoryQueryRange({ type: "day", anchor: "2026-11-27" }, "2026-11-27")).toEqual(["2026-11-01", "2026-11-30"]);
    expect(computeHistoryQueryRange({ type: "month", anchor: "2026-10-15" }, "2026-11-27")).toEqual(["2026-10-01", "2026-10-31"]);
    expect(computeHistoryQueryRange({ type: "week", anchor: "2026-12-02" }, "2026-12-02")).toEqual(["2026-11-30", "2026-12-31"]);
    expect(computeHistoryQueryRange({ type: "year", anchor: "2025-06-15" }, "2026-11-27")).toEqual(["2025-01-01", "2025-12-31"]);
    expect(computeHistoryQueryRange({ type: "all", anchor: "2026-11-27" }, "2026-11-27")).toBeNull();
  });

  it("체결 해부 지표는 같은 날짜의 동일 주문번호에만 병합된다", () => {
    const days = new Map([
      [
        "2026-11-20",
        [{ orderNo: "0001", code: "005930", name: "삼성전자", side: "buy" as const, quantity: 10, price: 70_000, time: "09:10:00", venue: "krx" as const }],
      ],
      [
        "2026-11-27",
        [{ orderNo: "0001", code: "005930", name: "삼성전자", side: "buy" as const, quantity: 10, price: 72_000, time: "09:10:00", venue: "krx" as const }],
      ],
    ]);
    const merged = combineDayExecutionsWithForensics(days, "20261120", [
      {
        orderNo: "0001",
        code: "005930",
        name: "삼성전자",
        side: "buy",
        time: "09:10:00",
        fillAt: 1_795_133_400,
        price: 70_000,
        quantity: 10,
        collected: true,
        diagnosis: "neutral",
        mfePct: 1.8,
        maePct: -0.4,
        slippageTicks: 0,
        preEntryCancelRatePct: 0,
        programDeltaMillionWon: 0,
        whaleNetDeltaMillionWon: 0,
        summary: "",
      },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.day).toBe("2026-11-20");
    expect(merged[0]!.executions[0]!.mfePct).toBe(1.8);
    expect(merged[1]!.day).toBe("2026-11-27");
    expect(merged[1]!.executions[0]!.mfePct).toBeNull();
  });

  it("초기 서버 날짜 동기화는 사용자가 과거 기간을 고른 뒤에는 기준일을 덮어쓰지 않는다", () => {
    useJournalStore.setState({ period: { type: "month", anchor: "2026-11-01" }, anchorTouched: false });
    useJournalStore.getState().syncInitialAnchor("2026-11-27");
    expect(useJournalStore.getState().period.anchor).toBe("2026-11-27");

    useJournalStore.getState().stepPeriod(-1, "2026-11-27");
    expect(useJournalStore.getState().period.anchor).toBe("2026-10-15");

    useJournalStore.getState().syncInitialAnchor("2026-11-27");
    expect(useJournalStore.getState().period.anchor).toBe("2026-10-15");
  });

  it("5개 봉 주기(1·3·5·10분·일봉) 매핑과 합성 봉 간격이 정확하다", () => {
    expect(JOURNAL_TFS.map((entry) => TF_TO_PERIOD[entry.tf])).toEqual(["1m", "3m", "5m", "10m", "D"]);
    expect([tfStepMinutes("1"), tfStepMinutes("3"), tfStepMinutes("5"), tfStepMinutes("10")]).toEqual([1, 3, 5, 10]);

    const trades = buildRoundTrips(SAMPLE_HISTORY);
    const intraday = trades[1]!;
    for (const tf of ["1", "3", "5", "10", "D"] as const) {
      const bars = synthesizeDemoBars(intraday, tf);
      expect(bars.length).toBeGreaterThan(10);
      for (let i = 1; i < bars.length; i += 1) {
        expect(bars[i]!.t).toBeGreaterThan(bars[i - 1]!.t);
      }
      if (tf !== "D") {
        expect(bars[1]!.t - bars[0]!.t).toBe(tfStepMinutes(tf) * 60);
      }
    }
  });
});
