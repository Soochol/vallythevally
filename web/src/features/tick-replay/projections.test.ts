import { describe, expect, test } from "vitest";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { windowId } from "../../layout/kinds";
import type { ActiveTickReplayState } from "../../stores/tickReplay";
import { REPLAY_REASON } from "../book-replay/replay";
import type { ReplayEngineFrame } from "../replay-page/replayEngine";
import { kstMidnightUnix, type ReplaySession } from "../replay-page/replayModel";
import { projectTickReplayBook, projectTickReplayProgram, projectTickReplayTrades } from "./projections";

const CODE: SymbolCode = "005930";
const DATE = "20261125";
const DAY_START = kstMidnightUnix(DATE);

const SESSION: ReplaySession = {
  date: DATE,
  dayStartUnix: DAY_START,
  sessionStartSec: 540 * 60,
  sessionEndSec: 930 * 60,
  previousClose: 70_000,
  coveragePct: 100,
  tickStepOf: () => 100,
  books: [],
  frames: [],
  minutes: [],
  spans: [],
  gapWindows: [],
  singlePriceWindows: [],
};

function makeActive(overrides: Partial<ActiveTickReplayState> = {}): ActiveTickReplayState {
  return {
    kind: "active",
    runId: 1,
    target: {
      cellId: windowId("cell-0"),
      symbol: CODE,
      link: "a",
      date: DATE,
      initialSec: 540 * 60,
      autoPlay: false,
    },
    load: { kind: "ready" },
    session: SESSION,
    engine: null,
    isArchive: false,
    control: {
      playing: false,
      buffering: false,
      mode: { kind: "time", speed: 1, skipIdleMs: null },
      activeSecond: 540 * 60 + 10,
      loadedSpanCount: 1,
    },
    ...overrides,
  };
}

function makeFrame(overrides: Partial<ReplayEngineFrame> = {}): ReplayEngineFrame {
  return {
    cursorMs: (540 * 60 + 10) * 1_000,
    deltaMs: 250,
    playing: false,
    buffering: false,
    resolution: "tick",
    price: 71_100,
    dayOpen: 71_000,
    dayHigh: 71_100,
    dayLow: 71_000,
    cumVol: 900,
    cumVal: 63_980_000,
    vwap: 71_088,
    strength: 180,
    programBuyQty: 3_000,
    programSellQty: 400,
    programNetQty: 2_600,
    programNetAmtMillion: 185,
    recentProgramRows: [
      {
        key: "p-540-1",
        recvMs: (540 * 60 + 10) * 1_000,
        time: "09:00:10",
        price: 71_100,
        buyQty: 3_000,
        sellQty: 400,
        netQty: 2_600,
        netQtyChange: 1_400,
        netAmountMillionWon: 185,
      },
      {
        key: "p-540-0",
        recvMs: 540 * 60 * 1_000,
        time: "09:00:00",
        price: 71_000,
        buyQty: 1_500,
        sellQty: 300,
        netQty: 1_200,
        netQtyChange: 1_200,
        netAmountMillionWon: 85,
      },
    ],
    programTrend: [1_200, 2_600],
    inGap: false,
    singlePrice: false,
    formingBar: null,
    ladder: {
      rows: [
        { side: "ask", price: 71_200, quantity: 900, delta: -100, ratio: 0.5, rate: 1.71, wall: false, current: false, lastHit: null, tags: [], dimmed: false },
        { side: "ask", price: 71_100, quantity: 1_500, delta: 500, ratio: 0.8, rate: 1.57, wall: false, current: true, lastHit: "buy", tags: [], dimmed: false },
        { side: "bid", price: 71_000, quantity: 1_900, delta: 200, ratio: 1, rate: 1.43, wall: false, current: false, lastHit: null, tags: [], dimmed: false },
        { side: "bid", price: 70_900, quantity: 1_100, delta: 0, ratio: 0.6, rate: 1.29, wall: false, current: false, lastHit: null, tags: [], dimmed: false },
      ],
      totalAsk: 7_800,
      totalBid: 4_700,
      totalAskDelta: 200,
      totalBidDelta: 500,
      askPct: 62,
      bidPct: 38,
      obi: -0.25,
      spreadTicks: 1,
      spreadWon: 100,
      singlePrice: false,
      inGap: false,
    },
    cellFlashes: new Map(),
    hitRow: null,
    tradeSummary: { rows: [], totalMatching: 2, net1mQty: 900, whaleBuy: 1, whaleSell: 0 },
    recentTrades: [
      { key: "540-1", recvMs: (540 * 60 + 10) * 1_000, secondOfDay: 540 * 60 + 10, minute: 540, price: 71_100, quantity: 800, value: 56_880_000, side: "buy", whale: true, freshUntilMs: 0 },
      { key: "540-0", recvMs: (540 * 60 + 5) * 1_000, secondOfDay: 540 * 60 + 5, minute: 540, price: 71_000, quantity: 100, value: 7_100_000, side: "buy", whale: false, freshUntilMs: 0 },
    ],
    tradesVersion: 1,
    tradesResetVersion: 0,
    tradesAddedSeq: 2,
    tradesBackfilling: false,
    tradesScannedFromMin: null,
    hasMoreTrades: false,
    skipNotice: null,
    loadedSpans: [540],
    ...overrides,
  };
}

describe("tick-replay projections", () => {
  test("projects book levels sorted ascending asks and descending bids with deltas and archive scope", () => {
    const view = projectTickReplayBook(makeActive({ isArchive: true }), makeFrame());
    expect(view.kind).toBe("past");
    if (view.kind !== "past") return;
    expect(view.at).toBe(DAY_START + 540 * 60 + 10);
    expect(view.venueScope).toBe("krx_archive");
    expect(view.book.asks.map((l) => [l.price, l.quantity, l.change])).toEqual([
      [71_100, 1_500, 500],
      [71_200, 900, -100],
    ]);
    expect(view.book.bids.map((l) => [l.price, l.quantity, l.change])).toEqual([
      [71_000, 1_900, 200],
      [70_900, 1_100, 0],
    ]);
    expect(view.trades).toHaveLength(2);
    expect(view.lastPrice).toBe(71_100);
    expect(view.previousClose).toBe(70_000);
  });

  test("filters trades by minWon and preserves strength, cumVolume, and archive scope", () => {
    const all = projectTickReplayTrades(makeActive(), makeFrame(), 0);
    expect(all.kind).toBe("past");
    if (all.kind !== "past") return;
    expect(all.entries).toHaveLength(2);
    expect(all.cumVolume).toBe(900);
    expect(all.strength).toBe(180);
    expect(all.venueScope).toBeUndefined();

    const big = projectTickReplayTrades(makeActive({ isArchive: true }), makeFrame(), 30_000_000);
    expect(big.kind).toBe("past");
    if (big.kind !== "past") return;
    expect(big.entries).toHaveLength(1);
    expect(big.venueScope).toBe("krx_archive");
    expect(big.venue).toBe("krx");
  });

  test("reverses program rows into ascending order and projects latest totals and trend", () => {
    const prog = projectTickReplayProgram(makeActive(), makeFrame());
    expect(prog.kind).toBe("past");
    if (prog.kind !== "past") return;
    expect(prog.rowCount).toBe(2);
    expect(prog.latest?.netQty).toBe(2_600);
    expect(prog.latest?.buyQty).toBe(3_000);
    expect(prog.latest?.sellQty).toBe(400);
    expect(prog.lines.map((l) => (l.kind === "row" ? l.row.time : "gap"))).toEqual(["09:00:00", "09:00:10"]);
    expect(prog.trend).toEqual([1_200, 2_600]);
  });

  test("returns none with gap or loading reason when unavailable", () => {
    const gapFrame = makeFrame({ inGap: true });
    expect(projectTickReplayBook(makeActive(), gapFrame)).toEqual({ kind: "none", reason: REPLAY_REASON.gap });
    expect(projectTickReplayTrades(makeActive(), gapFrame, 0)).toEqual({ kind: "none", reason: REPLAY_REASON.gap });
    expect(projectTickReplayProgram(makeActive(), gapFrame)).toEqual({ kind: "none", reason: REPLAY_REASON.gap });

    const loadingActive = makeActive({ load: { kind: "loading" }, session: null });
    expect(projectTickReplayBook(loadingActive, null)).toEqual({ kind: "none", reason: REPLAY_REASON.loading });
  });
});
