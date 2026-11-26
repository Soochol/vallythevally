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
});
