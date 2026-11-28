import { describe, expect, test } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { ReplayEngineFrame } from "../replay-page/replayEngine";
import { kstMidnightUnix, type ReplayFrame, type ReplayMinutePoint, type ReplaySession } from "../replay-page/replayModel";
import { projectTickReplayBars } from "./chartBars";

const DATE = "20261125";
const DAY_START = kstMidnightUnix(DATE);
const PREV_DAY_START = DAY_START - 86_400;

function makeMinute(minute: number, o: number, h: number, l: number, c: number, volume: number): ReplayMinutePoint {
  return {
    minute,
    sec: minute * 60,
    open: o,
    high: h,
    low: l,
    close: c,
    volume,
    vwap: c,
    totalAsk: 1_000,
    totalBid: 1_000,
    obi: 0,
    strength: 100,
    programNetQty: null,
    programNetAmtMillion: null,
    inGap: false,
    singlePrice: false,
  };
}

function makeSession(minutes: readonly ReplayMinutePoint[], frames: readonly ReplayFrame[] = []): ReplaySession {
  return {
    date: DATE,
    dayStartUnix: DAY_START,
    sessionStartSec: 540 * 60,
    sessionEndSec: 930 * 60,
    previousClose: 70_000,
    coveragePct: 100,
    tickStepOf: () => 100,
    books: [],
    frames,
    minutes,
    spans: [],
    gapWindows: [],
    singlePriceWindows: [],
  };
}

function makeFrame(overrides: Partial<ReplayEngineFrame> = {}): ReplayEngineFrame {
  return {
    cursorMs: 540 * 60_000,
    deltaMs: 0,
    playing: false,
    buffering: false,
    resolution: "tick",
    price: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    cumVol: 0,
    cumVal: 0,
    vwap: null,
    strength: 100,
    programBuyQty: null,
    programSellQty: null,
    programNetQty: null,
    programNetAmtMillion: null,
    recentProgramRows: [],
    programTrend: [],
    inGap: false,
    singlePrice: false,
    formingBar: null,
    ladder: {
      rows: [],
      totalAsk: 0,
      totalBid: 0,
      totalAskDelta: 0,
      totalBidDelta: 0,
      askPct: 50,
      bidPct: 50,
      obi: 0,
      spreadTicks: null,
      spreadWon: null,
      singlePrice: false,
      inGap: false,
    },
    cellFlashes: new Map(),
    hitRow: null,
    tradeSummary: { rows: [], totalMatching: 0, net1mQty: 0, whaleBuy: 0, whaleSell: 0 },
    recentTrades: [],
    tradesVersion: 0,
    tradesResetVersion: 0,
    tradesAddedSeq: 0,
    tradesBackfilling: false,
    tradesScannedFromMin: null,
    hasMoreTrades: false,
    skipNotice: null,
    loadedSpans: [],
    ...overrides,
  };
}

describe("projectTickReplayBars", () => {
  const minutes = [
    makeMinute(540, 71_000, 71_200, 70_900, 71_100, 500),
    makeMinute(541, 71_100, 71_400, 71_000, 71_300, 600),
    makeMinute(542, 71_300, 71_500, 71_200, 71_400, 700),
    makeMinute(543, 71_400, 71_800, 71_300, 71_700, 800),
    makeMinute(544, 71_700, 71_900, 71_600, 71_800, 900),
    makeMinute(545, 71_800, 72_500, 71_700, 72_400, 1_500),
  ];
  const session = makeSession(minutes);

  test("hides future minutes and does not leak end-of-minute checkpoint OHLC before first trade", () => {
    const result = projectTickReplayBars({
      session,
      frame: makeFrame({ cursorMs: 540 * 60_000, formingBar: null }),
      period: "1m",
      priorBars: [],
      regularHoursOnly: false,
      isArchive: false,
    });
    expect(result.bars).toEqual([]);
    expect(result.current).toBeNull();
  });

  test("grows forming candle OHLCV per tick on current minute while hiding future bars", () => {
    const tick1 = projectTickReplayBars({
      session,
      frame: makeFrame({
        cursorMs: 541 * 60_000 + 10_000,
        formingBar: { minute: 541, open: 71_100, high: 71_150, low: 71_100, close: 71_150, volume: 120 },
      }),
      period: "1m",
      priorBars: [],
      regularHoursOnly: false,
      isArchive: false,
    });
    expect(tick1.bars).toEqual([{ t: DAY_START + 540 * 60, o: 71_000, h: 71_200, l: 70_900, c: 71_100, v: 500 }]);
    expect(tick1.current).toEqual({ t: DAY_START + 541 * 60, o: 71_100, h: 71_150, l: 71_100, c: 71_150, v: 120 });

    const tick2 = projectTickReplayBars({
      session,
      frame: makeFrame({
        cursorMs: 541 * 60_000 + 35_000,
        formingBar: { minute: 541, open: 71_100, high: 71_350, low: 71_050, close: 71_300, volume: 420 },
      }),
      period: "1m",
      priorBars: [],
      regularHoursOnly: false,
      isArchive: false,
    });
    expect(tick2.bars).toHaveLength(1);
    expect(tick2.current).toEqual({ t: DAY_START + 541 * 60, o: 71_100, h: 71_350, l: 71_050, c: 71_300, v: 420 });
  });

  test("re-aggregates cleanly across 1m, 3m, 5m, and 15m preserving exact cursor time", () => {
    const frame = makeFrame({
      cursorMs: 544 * 60_000 + 20_000,
      formingBar: { minute: 544, open: 71_700, high: 71_750, low: 71_650, close: 71_750, volume: 100 },
    });

    const p1 = projectTickReplayBars({ session, frame, period: "1m", priorBars: [], regularHoursOnly: false, isArchive: false });
    expect(p1.bars).toHaveLength(4);
    expect(p1.current).toEqual({ t: DAY_START + 544 * 60, o: 71_700, h: 71_750, l: 71_650, c: 71_750, v: 100 });

    const p3 = projectTickReplayBars({ session, frame, period: "3m", priorBars: [], regularHoursOnly: false, isArchive: false });
    expect(p3.bars).toEqual([{ t: DAY_START + 540 * 60, o: 71_000, h: 71_500, l: 70_900, c: 71_400, v: 1_800 }]);
    expect(p3.current).toEqual({ t: DAY_START + 543 * 60, o: 71_400, h: 71_800, l: 71_300, c: 71_750, v: 900 });

    const p5 = projectTickReplayBars({ session, frame, period: "5m", priorBars: [], regularHoursOnly: false, isArchive: false });
    expect(p5.bars).toEqual([]);
    expect(p5.current).toEqual({ t: DAY_START + 540 * 60, o: 71_000, h: 71_800, l: 70_900, c: 71_750, v: 2_700 });

    const p15 = projectTickReplayBars({ session, frame, period: "15m", priorBars: [], regularHoursOnly: false, isArchive: false });
    expect(p15.bars).toEqual([]);
    expect(p15.current).toEqual({ t: DAY_START + 540 * 60, o: 71_000, h: 71_800, l: 70_900, c: 71_750, v: 2_700 });
  });

  test("preserves prior-day bars for non-archive sessions and filters regular hours, omitting them on archive", () => {
    const priorBars: Bar[] = [
      { t: PREV_DAY_START + 8 * 3600 + 30 * 60, o: 69_000, h: 69_100, l: 68_900, c: 69_050, v: 100 },
      { t: PREV_DAY_START + 15 * 3600 + 25 * 60, o: 69_900, h: 70_100, l: 69_800, c: 70_000, v: 300 },
      { t: DAY_START + 9 * 3600, o: 99_999, h: 99_999, l: 99_999, c: 99_999, v: 999 },
    ];
    const frame = makeFrame({
      cursorMs: 540 * 60_000 + 15_000,
      formingBar: { minute: 540, open: 71_000, high: 71_000, low: 71_000, close: 71_000, volume: 50 },
    });

    const normal = projectTickReplayBars({ session, frame, period: "1m", priorBars, regularHoursOnly: false, isArchive: false });
    expect(normal.bars.map((b) => b.t)).toEqual([priorBars[0]!.t, priorBars[1]!.t]);
    expect(normal.current?.c).toBe(71_000);

    const regularOnly = projectTickReplayBars({ session, frame, period: "1m", priorBars, regularHoursOnly: true, isArchive: false });
    expect(regularOnly.bars.map((b) => b.t)).toEqual([priorBars[1]!.t]);

    const archive = projectTickReplayBars({ session, frame, period: "1m", priorBars, regularHoursOnly: false, isArchive: true });
    expect(archive.bars).toEqual([]);
    expect(archive.current?.c).toBe(71_000);
  });

  test("aggregates minute_only trades up to curSec and falls back to checkpoint at second 59", () => {
    const frames: ReplayFrame[] = [
      {
        t: 540 * 60 + 10,
        minute: 540,
        price: 71_000,
        open: 71_000,
        high: 71_000,
        low: 71_000,
        inGap: false,
        singlePrice: false,
        asks: [],
        bids: [],
        totalAsk: 0,
        totalBid: 0,
        bookIndex: 0,
        trade: { key: "t1", secondOfDay: 540 * 60 + 10, minute: 540, price: 71_000, quantity: 30, value: 2_130_000, side: "buy", whale: false },
        strength: 100,
        cumVol: 30,
        cumVal: 2_130_000,
        programNetQty: null,
        programNetAmtMillion: null,
      },
      {
        t: 540 * 60 + 40,
        minute: 540,
        price: 71_200,
        open: 71_000,
        high: 71_200,
        low: 71_000,
        inGap: false,
        singlePrice: false,
        asks: [],
        bids: [],
        totalAsk: 0,
        totalBid: 0,
        bookIndex: 0,
        trade: { key: "t2", secondOfDay: 540 * 60 + 40, minute: 540, price: 71_200, quantity: 70, value: 4_984_000, side: "buy", whale: false },
        strength: 100,
        cumVol: 100,
        cumVal: 7_114_000,
        programNetQty: null,
        programNetAmtMillion: null,
      },
    ];
    const minuteSession = makeSession(minutes, frames);

    const mid = projectTickReplayBars({
      session: minuteSession,
      frame: makeFrame({ cursorMs: (540 * 60 + 20) * 1_000, resolution: "minute_only" }),
      period: "1m",
      priorBars: [],
      regularHoursOnly: false,
      isArchive: false,
    });
    expect(mid.current).toEqual({ t: DAY_START + 540 * 60, o: 71_000, h: 71_000, l: 71_000, c: 71_000, v: 30 });

    const endOfMin1 = projectTickReplayBars({
      session: minuteSession,
      frame: makeFrame({ cursorMs: (541 * 60 + 59) * 1_000, resolution: "minute_only" }),
      period: "1m",
      priorBars: [],
      regularHoursOnly: false,
      isArchive: false,
    });
    expect(endOfMin1.bars).toHaveLength(1);
    expect(endOfMin1.current).toEqual({ t: DAY_START + 541 * 60, o: 71_100, h: 71_400, l: 71_000, c: 71_300, v: 600 });
  });

  test("re-aggregates compatible prior-day bars on coarser period switch and drops incompatible finer switches", () => {
    const prevDayStart = DAY_START - 86_400;
    const prior1m: Bar[] = [
      { t: prevDayStart + 540 * 60, o: 69_000, h: 69_500, l: 68_900, c: 69_200, v: 100 },
      { t: prevDayStart + 541 * 60, o: 69_200, h: 69_800, l: 69_100, c: 69_600, v: 250 },
      { t: prevDayStart + 545 * 60, o: 69_600, h: 69_900, l: 69_400, c: 69_700, v: 300 },
    ];
    const session = makeSession([makeMinute(540, 71_000, 71_200, 70_900, 71_100, 400)]);
    const frame = makeFrame({
      cursorMs: (540 * 60 + 20) * 1_000,
      formingBar: { minute: 540, open: 71_000, high: 71_100, low: 71_000, close: 71_100, volume: 120 },
    });

    const res5m = projectTickReplayBars({
      session,
      frame,
      period: "5m",
      priorBars: prior1m,
      priorPeriod: "1m",
      regularHoursOnly: false,
      isArchive: false,
    });
    expect(res5m.bars).toEqual([
      { t: prevDayStart + 540 * 60, o: 69_000, h: 69_800, l: 68_900, c: 69_600, v: 350 },
      { t: prevDayStart + 545 * 60, o: 69_600, h: 69_900, l: 69_400, c: 69_700, v: 300 },
    ]);
    expect(res5m.current).toEqual({ t: DAY_START + 540 * 60, o: 71_000, h: 71_100, l: 71_000, c: 71_100, v: 120 });

    const resIncompatible = projectTickReplayBars({
      session,
      frame,
      period: "1m",
      priorBars: res5m.bars,
      priorPeriod: "5m",
      regularHoursOnly: false,
      isArchive: false,
    });
    expect(resIncompatible.bars).toEqual([]);
    expect(resIncompatible.current).toEqual({ t: DAY_START + 540 * 60, o: 71_000, h: 71_100, l: 71_000, c: 71_100, v: 120 });
  });

  test("omits flat zero-volume candles for collection-gap minutes", () => {
    const gapPoint: ReplayMinutePoint = {
      ...makeMinute(541, 71_100, 71_100, 71_100, 71_100, 0),
      inGap: true,
    };
    const session = makeSession([
      makeMinute(540, 71_000, 71_200, 70_900, 71_100, 400),
      gapPoint,
      makeMinute(542, 71_200, 71_500, 71_100, 71_400, 300),
    ]);
    const res = projectTickReplayBars({
      session,
      frame: makeFrame({
        cursorMs: (542 * 60 + 30) * 1_000,
        formingBar: { minute: 542, open: 71_200, high: 71_300, low: 71_200, close: 71_300, volume: 80 },
      }),
      period: "1m",
      priorBars: [],
      regularHoursOnly: false,
      isArchive: false,
    });
    expect(res.bars.map((b) => b.t)).toEqual([DAY_START + 540 * 60]);
    expect(res.current).toEqual({ t: DAY_START + 542 * 60, o: 71_200, h: 71_300, l: 71_200, c: 71_300, v: 80 });
  });
});
