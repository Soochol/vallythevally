import { describe, expect, it } from "vitest";
import type { BookReplayDay } from "../../api/generated/BookReplayDay";
import type { BookReplayMeta } from "../../api/generated/BookReplayMeta";
import { encodeHogaSpan } from "./hogaDecode";
import { ReplayEngine } from "./replayEngine";
import { buildReplaySession } from "./replayModel";

const DATE = "20261125";
const M540 = 540 * 60_000;

function makeFixture() {
  const day: BookReplayDay = {
    symbol: "005930",
    date: DATE,
    coverage: "collected",
    previousClose: 70_000,
    covered: [[540, 544]],
    books: [],
    trades: [],
  };
  const session = buildReplaySession({
    day,
    bars1m: [],
    quoteTotals: [],
    programPoints: [],
    previousClose: 70_000,
    symbolKind: "common",
  });
  const meta: BookReplayMeta = {
    symbol: "005930",
    date: DATE,
    coverage: "collected",
    resolution: "tick",
    spanMinutes: 5,
    covered: [[540, 544]],
    gapsMs: [],
    spans: [{ startMinute: 540, bookRows: 3, tradeRows: 3, programRows: 0 }],
    minutes: [
      {
        minute: 540,
        open: 71_000,
        high: 71_200,
        low: 71_000,
        close: 71_200,
        volume: 300,
        cumVol: 0,
        cumVal: 0,
        cumBuyQty: 0,
        cumSellQty: 0,
        dayOpen: null,
        dayHigh: null,
        dayLow: null,
        totalAsk: 3_000,
        totalBid: 2_500,
        programNetQty: null,
        programNetAmtMillion: null,
        singlePrice: false,
      },
    ],
  };

  const spanBuf = encodeHogaSpan({
    date: 20261125,
    startMinute: 540,
    lengthMinutes: 5,
    symbol: "005930_AL",
    streams: [
      {
        kind: "book",
        columns: {
          recv_ms: [M540 + 100, M540 + 500, M540 + 12_000],
          t_s: [32_400, 32_400, 32_412],
          ask_px1: [71_100, 71_100, 71_200],
          ask_px2: [71_200, 71_200, 71_300],
          ask_px3: [71_300, 71_300, 71_400],
          ask_px4: [71_400, 71_400, 71_500],
          bid_px1: [71_000, 71_000, 71_100],
          bid_px2: [70_900, 70_900, 71_000],
          bid_px3: [70_800, 70_800, 70_900],
          bid_px4: [70_700, 70_700, 70_800],
          ask_qty1: [1_000, 850, 900],
          ask_qty2: [800, 800, 800],
          ask_qty3: [600, 600, 600],
          ask_qty4: [600, 600, 600],
          bid_qty1: [1_000, 1_100, 1_200],
          bid_qty2: [500, 500, 500],
          bid_qty3: [500, 500, 500],
          bid_qty4: [500, 500, 500],
          ask_total: [3_000, 2_850, 2_900],
          bid_total: [2_500, 2_600, 2_700],
        },
      },
      {
        kind: "trades",
        columns: {
          recv_ms: [M540 + 250, M540 + 600, M540 + 12_100],
          t_s: [32_400, 32_400, 32_412],
          price: [71_000, 71_100, 71_200],
          qty: [100, 150, -50],
          venue: [1, 1, 2],
        },
      },
    ],
  });

  return { session, meta, spanBuf };
}

describe("ReplayEngine", () => {
  it("시간 단위 모드에서 밀리초 이벤트와 진행 중 1분봉·공백 자동 스킵이 동작한다", async () => {
    const { session, meta, spanBuf } = makeFixture();
    let perf = 1_000;
    const engine = new ReplayEngine({
      code: "005930",
      session,
      meta,
      spanFetcher: async () => spanBuf.slice(0),
      nowPerf: () => perf,
    });
    await new Promise((r) => setTimeout(r, 0));

    engine.setMode({ kind: "time", speed: 1, skipIdleMs: 3_000 });
    engine.setPlaying(true);

    perf += 300;
    engine.stepFrameForTest(300);
    let f = engine.getFrame();
    expect(f.price).toBe(71_000);
    expect(f.formingBar).toEqual({ minute: 540, open: 71_000, high: 71_000, low: 71_000, close: 71_000, volume: 100 });
    expect(f.ladder.totalAsk).toBe(3_000);

    perf += 350;
    engine.stepFrameForTest(350);
    f = engine.getFrame();
    expect(f.price).toBe(71_100);
    expect(f.formingBar).toEqual({ minute: 540, open: 71_000, high: 71_100, low: 71_000, close: 71_100, volume: 250 });
    expect(f.ladder.totalAsk).toBe(2_850);
    expect(f.ladder.totalAskDelta).toBe(-150);

    perf += 100;
    engine.stepFrameForTest(100);
    f = engine.getFrame();
    expect(f.skipNotice).not.toBeNull();
    expect(f.cursorMs).toBeGreaterThanOrEqual(M540 + 11_750);

    engine.dispose();
  });

  it("틱 단위 모드에서 체결만 필터·1틱 전진/후진 시 호가 사다리가 함께 동기화된다", async () => {
    const { session, meta, spanBuf } = makeFixture();
    const engine = new ReplayEngine({
      code: "005930",
      session,
      meta,
      spanFetcher: async () => spanBuf.slice(0),
      nowPerf: () => 5_000,
    });
    await new Promise((r) => setTimeout(r, 0));

    engine.setMode({ kind: "tick", rateHz: 5, filter: "trade" });
    engine.stepTick(1);
    expect(engine.getFrame().cursorMs).toBe(M540 + 250);
    expect(engine.getFrame().price).toBe(71_000);
    expect(engine.getFrame().ladder.totalAsk).toBe(3_000);

    engine.stepTick(1);
    expect(engine.getFrame().cursorMs).toBe(M540 + 600);
    expect(engine.getFrame().price).toBe(71_100);
    expect(engine.getFrame().ladder.totalAsk).toBe(2_850);

    engine.stepTick(1);
    expect(engine.getFrame().cursorMs).toBe(M540 + 12_100);
    expect(engine.getFrame().price).toBe(71_200);
    expect(engine.getFrame().ladder.totalAsk).toBe(2_900);

    engine.stepTick(-1);
    expect(engine.getFrame().cursorMs).toBe(M540 + 600);
    expect(engine.getFrame().price).toBe(71_100);

    engine.dispose();
  });

  it("프로그램 체결 스트림에서 순매수 증감 행과 누적 추이를 계산한다", async () => {
    const { session, meta } = makeFixture();
    const programMeta: BookReplayMeta = {
      ...meta,
      spans: [{ startMinute: 540, bookRows: 1, tradeRows: 1, programRows: 2 }],
    };
    const spanBuf = encodeHogaSpan({
      date: 20261125,
      startMinute: 540,
      lengthMinutes: 5,
      symbol: "005930_AL",
      streams: [
        {
          kind: "book",
          columns: {
            recv_ms: [M540],
            t_s: [32_400],
            ask_px1: [71_100],
            bid_px1: [71_000],
            ask_qty1: [1_000],
            bid_qty1: [1_000],
            ask_total: [1_000],
            bid_total: [1_000],
          },
        },
        {
          kind: "trades",
          columns: {
            recv_ms: [M540 + 100],
            t_s: [32_400],
            price: [71_100],
            qty: [100],
            venue: [1],
          },
        },
        {
          kind: "program",
          columns: {
            recv_ms: [M540 + 200, M540 + 1_200],
            t_s: [32_400, 32_401],
            sell_qty: [300, 400],
            sell_amt: [21, 28],
            buy_qty: [1_500, 3_000],
            buy_amt: [106, 213],
          },
        },
      ],
    });
    const engine = new ReplayEngine({
      code: "005930",
      session,
      meta: programMeta,
      spanFetcher: async () => spanBuf.slice(0),
      nowPerf: () => 5_000,
    });
    await new Promise((r) => setTimeout(r, 0));

    engine.seekMs(M540 + 1_500);
    const frame = engine.getFrame();
    expect(frame.programBuyQty).toBe(3_000);
    expect(frame.programSellQty).toBe(400);
    expect(frame.programNetQty).toBe(2_600);
    expect(frame.programNetAmtMillion).toBe(185);
    expect(frame.programTrend).toEqual([1_200, 2_600]);
    expect(frame.recentProgramRows).toHaveLength(2);
    expect(frame.recentProgramRows[0]!.netQtyChange).toBe(1_400);
    expect(frame.recentProgramRows[1]!.netQtyChange).toBe(1_200);

    engine.dispose();
  });

  it("금액 필터 선택 시 미로드 과거 스팬을 역방향 백필해 소급 표시하고 미래 체결은 노출하지 않는다", async () => {
    const M545 = 545 * 60_000;
    const M555 = 555 * 60_000;
    const day: BookReplayDay = {
      symbol: "005930",
      date: DATE,
      coverage: "collected",
      previousClose: 70_000,
      covered: [[540, 559]],
      books: [],
      trades: [],
    };
    const session = buildReplaySession({
      day,
      bars1m: [],
      quoteTotals: [],
      programPoints: [],
      previousClose: 70_000,
      symbolKind: "common",
    });

    const span540 = encodeHogaSpan({
      date: 20261125,
      startMinute: 540,
      lengthMinutes: 5,
      symbol: "005930_AL",
      streams: [
        {
          kind: "trades",
          columns: {
            recv_ms: [M540 + 15_000, M540 + 25_000],
            t_s: [32_415, 32_425],
            price: [70_000, 70_000],
            qty: [2_000, 50],
            venue: [1, 1],
          },
        },
      ],
    });
    const span545 = encodeHogaSpan({
      date: 20261125,
      startMinute: 545,
      lengthMinutes: 5,
      symbol: "005930_AL",
      streams: [
        {
          kind: "trades",
          columns: {
            recv_ms: [M545 + 20_000],
            t_s: [32_720],
            price: [70_000],
            qty: [-600],
            venue: [1],
          },
        },
      ],
    });
    const smallCount = 80;
    const span555Recv = Array.from({ length: smallCount + 1 }, (_, i) =>
      i < smallCount ? M555 + (i + 1) * 200 : M555 + 90_000,
    );
    const span555Ts = span555Recv.map((ms) => Math.floor(ms / 1000));
    const span555Price = Array.from({ length: smallCount + 1 }, () => 71_000);
    const span555Qty = Array.from({ length: smallCount + 1 }, (_, i) => (i < smallCount ? 10 : 3_000));
    const span555Venue = Array.from({ length: smallCount + 1 }, () => 1);
    const span555 = encodeHogaSpan({
      date: 20261125,
      startMinute: 555,
      lengthMinutes: 5,
      symbol: "005930_AL",
      streams: [
        {
          kind: "trades",
          columns: {
            recv_ms: span555Recv,
            t_s: span555Ts,
            price: span555Price,
            qty: span555Qty,
            venue: span555Venue,
          },
        },
      ],
    });

    const meta: BookReplayMeta = {
      symbol: "005930",
      date: DATE,
      coverage: "collected",
      resolution: "tick",
      spanMinutes: 5,
      covered: [[540, 559]],
      gapsMs: [],
      spans: [
        { startMinute: 540, bookRows: 0, tradeRows: 2, programRows: 0 },
        { startMinute: 545, bookRows: 0, tradeRows: 1, programRows: 0 },
        { startMinute: 555, bookRows: 0, tradeRows: smallCount + 1, programRows: 0 },
      ],
      minutes: [
        {
          minute: 555,
          open: 71_000,
          high: 71_000,
          low: 71_000,
          close: 71_000,
          volume: 800,
          cumVol: 2_650,
          cumVal: 185_500_000,
          cumBuyQty: 2_050,
          cumSellQty: 600,
          dayOpen: 70_000,
          dayHigh: 71_000,
          dayLow: 70_000,
          totalAsk: 1_000,
          totalBid: 1_000,
          programNetQty: null,
          programNetAmtMillion: null,
          singlePrice: false,
        },
      ],
    };

    const fetchedMinutes: number[] = [];
    const buffers = new Map<number, ArrayBuffer>([
      [540, span540],
      [545, span545],
      [555, span555],
    ]);

    const engine = new ReplayEngine({
      code: "005930",
      session,
      meta,
      spanFetcher: async (url) => {
        const min = Number(new URL(url, "http://localhost").searchParams.get("startMinute"));
        fetchedMinutes.push(min);
        return buffers.get(min)!.slice(0);
      },
      nowPerf: () => 5_000,
    });
    await new Promise((r) => setTimeout(r, 0));

    engine.seekMs(M555 + 30_000);
    expect(fetchedMinutes).toEqual([555]);
    expect(engine.getFrame().recentTrades).toHaveLength(smallCount);

    engine.setTapeMinWon(30_000_000);
    expect(engine.getFrame().tradesBackfilling).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    const frame30m = engine.getFrame();
    expect(frame30m.tradesBackfilling).toBe(false);
    expect(frame30m.recentTrades.map((tr) => tr.recvMs)).toEqual([M545 + 20_000, M540 + 15_000]);
    expect(frame30m.recentTrades.every((tr) => tr.recvMs <= M555 + 30_000)).toBe(true);

    const fetchCountBefore100m = fetchedMinutes.length;
    engine.setTapeMinWon(100_000_000);
    expect(fetchedMinutes.length).toBe(fetchCountBefore100m);
    expect(engine.getFrame().recentTrades.map((tr) => tr.recvMs)).toEqual([M540 + 15_000]);

    engine.dispose();
  });

  it("필터 활성화 상태에서 소액 체결이 대량 유입돼도 기존 대량 체결이 밀려 사라지지 않는다", async () => {
    const day: BookReplayDay = {
      symbol: "005930",
      date: DATE,
      coverage: "collected",
      previousClose: 70_000,
      covered: [[540, 544]],
      books: [],
      trades: [],
    };
    const session = buildReplaySession({
      day,
      bars1m: [],
      quoteTotals: [],
      programPoints: [],
      previousClose: 70_000,
      symbolKind: "common",
    });

    const total = 100;
    const recvMs = Array.from({ length: total }, (_, i) => M540 + (i + 1) * 100);
    const ts = recvMs.map((ms) => Math.floor(ms / 1000));
    const prices = Array.from({ length: total }, () => 70_000);
    const qtys = Array.from({ length: total }, (_, i) => (i === 0 ? 600 : i === 90 ? 1_500 : 10));
    const venues = Array.from({ length: total }, () => 1);
    const spanBuf = encodeHogaSpan({
      date: 20261125,
      startMinute: 540,
      lengthMinutes: 5,
      symbol: "005930_AL",
      streams: [
        {
          kind: "trades",
          columns: { recv_ms: recvMs, t_s: ts, price: prices, qty: qtys, venue: venues },
        },
      ],
    });
    const meta: BookReplayMeta = {
      symbol: "005930",
      date: DATE,
      coverage: "collected",
      resolution: "tick",
      spanMinutes: 5,
      covered: [[540, 544]],
      gapsMs: [],
      spans: [{ startMinute: 540, bookRows: 0, tradeRows: total, programRows: 0 }],
      minutes: [
        {
          minute: 540,
          open: 70_000,
          high: 70_000,
          low: 70_000,
          close: 70_000,
          volume: 3_080,
          cumVol: 0,
          cumVal: 0,
          cumBuyQty: 0,
          cumSellQty: 0,
          dayOpen: null,
          dayHigh: null,
          dayLow: null,
          totalAsk: 1_000,
          totalBid: 1_000,
          programNetQty: null,
          programNetAmtMillion: null,
          singlePrice: false,
        },
      ],
    };

    const engine = new ReplayEngine({
      code: "005930",
      session,
      meta,
      spanFetcher: async () => spanBuf.slice(0),
      nowPerf: () => 5_000,
    });
    await new Promise((r) => setTimeout(r, 0));

    engine.seekMs(M540 + 150);
    engine.setTapeMinWon(30_000_000);
    expect(engine.getFrame().recentTrades).toHaveLength(1);
    expect(engine.getFrame().tradesAddedSeq).toBe(0);

    engine.setMode({ kind: "time", speed: 20, skipIdleMs: null });
    engine.setPlaying(true);
    for (let step = 0; step < 6; step++) {
      engine.stepFrameForTest(100);
    }
    const frame = engine.getFrame();
    expect(frame.recentTrades.map((tr) => tr.recvMs)).toEqual([M540 + 9_100, M540 + 100]);
    expect(frame.tradesAddedSeq).toBe(1);

    engine.dispose();
  });

  it("전체 체결은 초기 500건까지 표시하고 loadMoreTrades로 이전 체결을 추가 확장한다", async () => {
    const day: BookReplayDay = {
      symbol: "005930",
      date: DATE,
      coverage: "collected",
      previousClose: 70_000,
      covered: [[540, 544]],
      books: [],
      trades: [],
    };
    const session = buildReplaySession({
      day,
      bars1m: [],
      quoteTotals: [],
      programPoints: [],
      previousClose: 70_000,
      symbolKind: "common",
    });

    const total = 650;
    const recvMs = Array.from({ length: total }, (_, i) => M540 + (i + 1) * 100);
    const ts = recvMs.map((ms) => Math.floor(ms / 1000));
    const prices = Array.from({ length: total }, () => 71_000);
    const qtys = Array.from({ length: total }, () => 10);
    const venues = Array.from({ length: total }, () => 1);
    const spanBuf = encodeHogaSpan({
      date: 20261125,
      startMinute: 540,
      lengthMinutes: 5,
      symbol: "005930_AL",
      streams: [
        {
          kind: "trades",
          columns: { recv_ms: recvMs, t_s: ts, price: prices, qty: qtys, venue: venues },
        },
      ],
    });
    const meta: BookReplayMeta = {
      symbol: "005930",
      date: DATE,
      coverage: "collected",
      resolution: "tick",
      spanMinutes: 5,
      covered: [[540, 544]],
      gapsMs: [],
      spans: [{ startMinute: 540, bookRows: 0, tradeRows: total, programRows: 0 }],
      minutes: [
        {
          minute: 540,
          open: 71_000,
          high: 71_000,
          low: 71_000,
          close: 71_000,
          volume: 6_500,
          cumVol: 0,
          cumVal: 0,
          cumBuyQty: 0,
          cumSellQty: 0,
          dayOpen: null,
          dayHigh: null,
          dayLow: null,
          totalAsk: 1_000,
          totalBid: 1_000,
          programNetQty: null,
          programNetAmtMillion: null,
          singlePrice: false,
        },
      ],
    };

    const engine = new ReplayEngine({
      code: "005930",
      session,
      meta,
      spanFetcher: async () => spanBuf.slice(0),
      nowPerf: () => 5_000,
    });
    await new Promise((r) => setTimeout(r, 0));

    engine.seekMs(M540 + total * 100 + 500);
    expect(engine.getFrame().recentTrades).toHaveLength(500);
    expect(engine.getFrame().hasMoreTrades).toBe(true);

    engine.loadMoreTrades();
    expect(engine.getFrame().recentTrades).toHaveLength(650);
    expect(engine.getFrame().hasMoreTrades).toBe(false);

    engine.dispose();
  });
});
