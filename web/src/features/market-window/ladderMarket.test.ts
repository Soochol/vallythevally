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
});
