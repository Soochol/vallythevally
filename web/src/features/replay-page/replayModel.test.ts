import { describe, expect, it } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { BookReplayDay } from "../../api/generated/BookReplayDay";
import type { ProgramSeriesPoint } from "../../api/generated/ProgramSeriesPoint";
import {
  buildReplaySession,
  computeLadderSnapshot,
  filterRecentTrades,
  formatReplayClock,
  frameIndexAt,
  kstMidnightUnix,
  resolvePreviousClose,
  stepTickSec,
} from "./replayModel";

const DATE = "20261125";
const MIDNIGHT = kstMidnightUnix(DATE);

const SAMPLE_DAY: BookReplayDay = {
  symbol: "042700",
  date: DATE,
  coverage: "collected",
  covered: [[540, 542], [544, 545]],
  books: [
    {
      minute: 540,
      asks: [[118_000, 1000], [118_100, 1200], [118_200, 900], [118_300, 4500]],
      bids: [[117_900, 1100], [117_800, 1300], [117_700, 800], [117_600, 900]],
      totalAsk: 7600,
      totalBid: 4100,
    },
    {
      minute: 541,
      asks: [[118_000, 1450], [118_100, 900], [118_200, 900], [118_300, 4500]],
      bids: [[117_900, 1600], [117_800, 1100], [117_700, 800], [117_600, 900]],
      totalAsk: 7750,
      totalBid: 4400,
    },
    {
      minute: 542,
      asks: [[118_500, 500], [118_600, 400]],
      bids: [[118_400, 600], [118_300, 300]],
      totalAsk: 900,
      totalBid: 900,
    },
  ],
  trades: [
    [540, 32_410, 117_900, 100],
    [540, 32_445, 118_000, 500],
    [541, 32_470, 118_000, -200],
  ],
};

describe("replayModel", () => {
  it("과거 관측일의 전일 정규장 종가를 일봉에서 복원한다", () => {
    const dailyBars: Bar[] = [
      { t: kstMidnightUnix("20261123") + 9 * 3600, o: 110_000, h: 111_000, l: 109_000, c: 110_500, v: 10_000 },
      { t: kstMidnightUnix("20261124") + 9 * 3600, o: 111_000, h: 113_000, l: 110_000, c: 112_000, v: 12_000 },
      { t: MIDNIGHT + 9 * 3600, o: 113_000, h: 119_000, l: 112_500, c: 118_000, v: 15_000 },
    ];
    expect(resolvePreviousClose(dailyBars, DATE)).toBe(112_000);
    expect(resolvePreviousClose(dailyBars, "20261123")).toBeNull();
  });

  it("직전 델타·호가벽·등락률·단일가 VI·수집 끊김을 정확히 계산한다", () => {
    const program: ProgramSeriesPoint[] = [
      { t: MIDNIGHT + 540 * 60, netBuyQty: 500, netBuyAmountMillionWon: 59, buyAmountMillionWon: 80, sellAmountMillionWon: 21, programSharePct: 12 },
      { t: MIDNIGHT + 541 * 60, netBuyQty: 1200, netBuyAmountMillionWon: 141, buyAmountMillionWon: 180, sellAmountMillionWon: 39, programSharePct: 15 },
    ];
    const session = buildReplaySession({
      day: SAMPLE_DAY,
      bars1m: [],
      quoteTotals: [],
      programPoints: program,
      previousClose: 112_000,
      symbolKind: "common",
    });

    const idx541 = frameIndexAt(session.frames, 32_470);
    const snap = computeLadderSnapshot(session, idx541, "tick");
    expect(snap.inGap).toBe(false);
    expect(snap.singlePrice).toBe(false);
    expect(snap.totalAsk).toBe(7750);
    expect(snap.totalAskDelta).toBe(150);
    expect(snap.totalBid).toBe(4400);
    expect(snap.totalBidDelta).toBe(300);
    expect(snap.spreadTicks).toBe(1);

    const ask1 = snap.rows[9]!;
    expect(ask1.price).toBe(118_000);
    expect(ask1.delta).toBe(450);
    expect(ask1.rate).toBeCloseTo(((118_000 - 112_000) / 112_000) * 100, 4);
    expect(ask1.current).toBe(true);

    const ask4 = snap.rows[6]!;
    expect(ask4.wall).toBe(true);

    const idxVi = frameIndexAt(session.frames, 542 * 60 + 59);
    const viSnap = computeLadderSnapshot(session, idxVi, "tick");
    expect(viSnap.singlePrice).toBe(true);
    expect(viSnap.rows[0]!.dimmed).toBe(true);

    const idxGap = frameIndexAt(session.frames, 543 * 60);
    const gapSnap = computeLadderSnapshot(session, idxGap, "tick");
    expect(gapSnap.inGap).toBe(true);
    expect(session.gapWindows).toEqual([{ startSec: 543 * 60, endSec: 544 * 60 }]);
    expect(session.minutes[1]!.programNetQty).toBe(1200);
  });

  it("체결 금액 필터와 1틱 이동 및 시각 포맷이 일관되게 동작한다", () => {
    const session = buildReplaySession({
      day: SAMPLE_DAY,
      bars1m: [],
      quoteTotals: [],
      programPoints: [],
      previousClose: 112_000,
      symbolKind: "common",
    });
    const idx = frameIndexAt(session.frames, 32_470);
    const all = filterRecentTrades(session.frames, idx, 0);
    expect(all.rows).toHaveLength(3);
    expect(all.whaleBuy).toBe(1);
    expect(all.net1mQty).toBe(400);

    const whales = filterRecentTrades(session.frames, idx, 50_000_000);
    expect(whales.rows).toHaveLength(1);
    expect(whales.rows[0]!.quantity).toBe(500);

    expect(stepTickSec(session.frames, 32_410, 1)).toBe(32_445);
    expect(stepTickSec(session.frames, 32_445, -1)).toBe(32_410);
    expect(formatReplayClock(32_410.5, true)).toBe("09:00:10.500");
  });
});
