import { describe, expect, it } from "vitest";
import type { BookState, BookView } from "../book/bookModel";
import type { ReplayView } from "../book-replay/replay";
import { resolveLadderMarket } from "./ladderMarket";

const LIVE_VIEW: BookView = {
  asks: [{ price: 70_100, quantity: 100, change: 0 }],
  bids: [{ price: 70_000, quantity: 200, change: 0 }],
  totalAsk: 1_000,
  totalBid: 2_000,
  expected: { price: 70_050, qty: 50 },
  t: 1_764_030_000,
};

const PAST_VIEW: BookView = {
  asks: [{ price: 69_100, quantity: 30, change: 0 }],
  bids: [{ price: 69_000, quantity: 40, change: 0 }],
  totalAsk: 300,
  totalBid: 400,
  expected: null,
  t: 1_763_943_600,
};

const LIVE_BOOK: BookState = { phase: "live", view: LIVE_VIEW };

describe("resolveLadderMarket", () => {
  it("resolves live book, regular totals, and header prices when replay is live", () => {
    const resolved = resolveLadderMarket({
      book: LIVE_BOOK,
      afterHours: null,
      lastPrice: 70_000,
      previousClose: 69_500,
      fundamentals: { lowerLimit: 48_650, upperLimit: 90_350 } as never,
      symbolKind: "common",
      replay: { kind: "live" },
      vi: null,
      nowSeconds: 1_764_032_400,
      serverNowSeconds: 1_764_032_400,
      skipSpreadGap: false,
    });

    expect(resolved.replayLocked).toBe(false);
    expect(resolved.view).toBe(LIVE_VIEW);
    expect(resolved.headPrice).toBe(70_000);
    expect(resolved.headPreviousClose).toBe(69_500);
    expect(resolved.totals).toEqual({ ask: 1_000, bid: 2_000, source: "regular", description: null });
    expect(resolved.pastRows).toHaveLength(0);
  });

  it("clears previousClose and bounds for a prior-day replay and builds pastRows", () => {
    const pastReplay: ReplayView = {
      kind: "past",
      at: 1_763_943_600,
      book: PAST_VIEW,
      lastPrice: 69_000,
      trades: [],
    };
    const resolved = resolveLadderMarket({
      book: LIVE_BOOK,
      afterHours: null,
      lastPrice: 70_000,
      previousClose: 69_500,
      fundamentals: { lowerLimit: 48_650, upperLimit: 90_350 } as never,
      symbolKind: "common",
      replay: pastReplay,
      vi: null,
      nowSeconds: 1_764_032_400,
      serverNowSeconds: 1_764_032_400,
      skipSpreadGap: false,
    });

    expect(resolved.replayLocked).toBe(true);
    expect(resolved.view).toBe(PAST_VIEW);
    expect(resolved.headPrice).toBe(69_000);
    expect(resolved.headPreviousClose).toBeNull();
    expect(resolved.expected).toBeNull();
    expect(resolved.totals).toEqual({ ask: 300, bid: 400, source: "regular", description: null });
    expect(resolved.pastRows.length).toBeGreaterThan(0);
  });

  it("returns empty view and null totals when replay has no coverage", () => {
    const resolved = resolveLadderMarket({
      book: LIVE_BOOK,
      afterHours: null,
      lastPrice: 70_000,
      previousClose: 69_500,
      fundamentals: undefined,
      symbolKind: "common",
      replay: { kind: "none", reason: "수집하지 않은 날입니다" },
      vi: null,
      nowSeconds: 1_764_032_400,
      serverNowSeconds: 1_764_032_400,
      skipSpreadGap: false,
    });

    expect(resolved.replayLocked).toBe(true);
    expect(resolved.view).toBeNull();
    expect(resolved.headPrice).toBeNull();
    expect(resolved.headPreviousClose).toBeNull();
    expect(resolved.totals).toEqual({ ask: null, bid: null, source: "regular", description: null });
  });

  it("15:30~15:40 NXT·통합 동시호가에서는 10호가를 6호가로 잘라 예상체결을 표시하고 KRX·NXT 불가 종목은 10호가를 유지한다", () => {
    const at1535 = Date.parse("2026-11-18T15:35:00+09:00") / 1000;
    const tenLevelView: BookView = {
      asks: Array.from({ length: 10 }, (_, i) => ({ price: 70_100 + 100 * i, quantity: 10 + i, change: 0 })),
      bids: Array.from({ length: 10 }, (_, i) => ({ price: 70_000 - 100 * i, quantity: 20 + i, change: 0 })),
      totalAsk: 1_000,
      totalBid: 2_000,
      expected: { price: 70_000, qty: 300 },
      t: at1535,
    };
    const base = {
      book: { phase: "live", view: tenLevelView } as BookState,
      afterHours: { source: "live" as const, totals: { t: at1535, askQty: 500, bidQty: 0 } },
      lastPrice: 70_000,
      previousClose: 69_500,
      fundamentals: { lowerLimit: 48_650, upperLimit: 90_350 } as never,
      symbolKind: "common" as const,
      replay: { kind: "live" as const },
      vi: null,
      nxtVi: null,
      nowSeconds: at1535,
      serverNowSeconds: at1535,
      skipSpreadGap: false,
    };

    const nxt = resolveLadderMarket({ ...base, venue: "nxt", nxtEnabled: true });
    expect(nxt.liveQuotes!.asks.map((l) => l.price)).toEqual([70_100, 70_200, 70_300]);
    expect(nxt.liveQuotes!.bids.map((l) => l.price)).toEqual([70_000, 69_900, 69_800]);
    expect(nxt.expected).toEqual({ price: 70_000, qty: 300 });
    expect(nxt.totals.source).toBe("regular");

    const combined = resolveLadderMarket({ ...base, venue: "combined", nxtEnabled: true });
    expect(combined.liveQuotes!.asks).toHaveLength(3);
    expect(combined.liveQuotes!.bids).toHaveLength(3);
    expect(combined.expected).toEqual({ price: 70_000, qty: 300 });

    const krx = resolveLadderMarket({ ...base, venue: "krx", nxtEnabled: true });
    expect(krx.liveQuotes!.asks).toHaveLength(10);
    expect(krx.liveQuotes!.bids).toHaveLength(10);
    expect(krx.expected).toBeNull();

    const nonNxt = resolveLadderMarket({ ...base, venue: "combined", nxtEnabled: false });
    expect(nonNxt.liveQuotes!.asks).toHaveLength(10);
    expect(nonNxt.liveQuotes!.bids).toHaveLength(10);
    expect(nonNxt.expected).toBeNull();
  });

  it("NXT VI 발동 중이면 nxt·combined에서 예상체결을 표시한다", () => {
    const at1000 = Date.parse("2026-11-18T10:00:00+09:00") / 1000;
    const view: BookView = { ...LIVE_VIEW, t: at1000 };
    const nxtVi = { symbol: "005930", market: "nxt" as const, active: true, direction: "up" as const, triggerPrice: 70_000, base: 69_500, triggeredAt: at1000, releasedAt: null };
    const base = {
      book: { phase: "live", view } as BookState,
      afterHours: null,
      lastPrice: 70_000,
      previousClose: 69_500,
      fundamentals: { lowerLimit: 48_650, upperLimit: 90_350 } as never,
      symbolKind: "common" as const,
      replay: { kind: "live" as const },
      vi: null,
      nxtVi,
      nowSeconds: at1000,
      serverNowSeconds: at1000,
      skipSpreadGap: false,
      nxtEnabled: true,
    };

    expect(resolveLadderMarket({ ...base, venue: "nxt" }).expected).toEqual(LIVE_VIEW.expected);
    expect(resolveLadderMarket({ ...base, venue: "combined" }).expected).toEqual(LIVE_VIEW.expected);
    expect(resolveLadderMarket({ ...base, venue: "krx" }).expected).toBeNull();
  });
});
