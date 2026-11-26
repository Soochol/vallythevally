import { describe, expect, it } from "vitest";
import {
  aggregateReplayBars,
  focusViewport,
  panViewport,
  zoomViewport,
} from "./replayChartModel";
import type { ReplayEngineFrame } from "./replayEngine";
import type { ReplayMinutePoint } from "./replayModel";

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
    totalAsk: 5000,
    totalBid: 6000,
    obi: 10,
    strength: 120,
    programNetQty: 100,
    programNetAmtMillion: 5,
    inGap: false,
    singlePrice: false,
  };
}

function makeFrame(cursorMin: number, forming?: { minute: number; open: number; high: number; low: number; close: number; volume: number }): ReplayEngineFrame {
  return {
    cursorMs: cursorMin * 60_000 + 15_000,
    deltaMs: 0,
    playing: false,
    buffering: false,
    resolution: "tick",
    price: forming?.close ?? 71_000,
    dayOpen: 71_000,
    dayHigh: 71_500,
    dayLow: 70_900,
    cumVol: 1000,
    cumVal: 71_000_000,
    vwap: 71_100,
    strength: 120,
    programNetQty: 100,
    programNetAmtMillion: 5,
    inGap: false,
    singlePrice: false,
    formingBar: forming ?? null,
    ladder: {
      rows: [],
      totalAsk: 5000,
      totalBid: 6000,
      totalAskDelta: 0,
      totalBidDelta: 0,
      askPct: 45,
      bidPct: 55,
      obi: 0.1,
      spreadTicks: 1,
      spreadWon: 100,
      singlePrice: false,
      inGap: false,
    },
    cellFlashes: new Map(),
    hitRow: null,
    tradeSummary: { rows: [], net1mQty: 0, whaleBuy: 0, whaleSell: 0 },
    recentTrades: [],
    skipNotice: null,
    loadedSpans: [],
  };
}

describe("replayChartModel", () => {
  it("aggregates 1m bars into higher minute timeframes without leaking future minutes in forming bucket", () => {
    const minutes = [
      makeMinute(540, 71_000, 71_200, 70_900, 71_100, 100),
      makeMinute(541, 71_100, 71_400, 71_000, 71_300, 200),
      makeMinute(542, 71_300, 72_000, 71_200, 71_900, 900),
      makeMinute(543, 71_900, 72_200, 71_800, 72_100, 300),
    ];

    const frame = makeFrame(541, {
      minute: 541,
      open: 71_100,
      high: 71_350,
      low: 71_050,
      close: 71_250,
      volume: 150,
    });

    const bars3m = aggregateReplayBars(minutes, 3, frame, 541);
    expect(bars3m).toHaveLength(2);
    expect(bars3m[0]!.startMinute).toBe(540);
    expect(bars3m[0]!.open).toBe(71_000);
    expect(bars3m[0]!.high).toBe(71_350);
    expect(bars3m[0]!.low).toBe(70_900);
    expect(bars3m[0]!.close).toBe(71_250);
    expect(bars3m[0]!.volume).toBe(250);
    expect(bars3m[0]!.isCurrent).toBe(true);
    expect(bars3m[1]!.isFuture).toBe(true);
  });

  it("zooms around anchor ratio, pans within bounds, and focuses window cleanly", () => {
    const full = { start: 0, end: 100 };
    const zoomed = zoomViewport(full, 100, 0.5, 0.5);
    expect(zoomed.end - zoomed.start).toBeCloseTo(50, 5);
    expect((zoomed.start + zoomed.end) / 2).toBeCloseTo(50, 5);

    const pannedLeft = panViewport(zoomed, 100, -40);
    expect(pannedLeft.start).toBe(0);
    expect(pannedLeft.end).toBeCloseTo(50, 5);

    const pannedRight = panViewport(zoomed, 100, 80);
    expect(pannedRight.end).toBe(100);
    expect(pannedRight.start).toBeCloseTo(50, 5);

    const focused = focusViewport(100, 10, 20);
    expect(focused.start).toBe(0);
    expect(focused.end).toBe(20);
  });
});
