import { describe, expect, it } from "vitest";
import { ClientMicroDetector, formatMicroCueTitle } from "./microDetector";

const book = (ask0: number, bid0: number) => ({
  asks: [
    { priceWon: 70_100, qty: ask0 },
    { priceWon: 70_200, qty: 1_000 },
    { priceWon: 70_300, qty: 1_000 },
    { priceWon: 70_400, qty: 1_000 },
    { priceWon: 70_500, qty: 1_000 },
  ],
  bids: [
    { priceWon: 70_000, qty: bid0 },
    { priceWon: 69_900, qty: 1_000 },
    { priceWon: 69_800, qty: 1_000 },
    { priceWon: 69_700, qty: 1_000 },
    { priceWon: 69_600, qty: 1_000 },
  ],
});

describe("ClientMicroDetector", () => {
  it("detects unmatched drop as spoof_cancel and formats cancel rate", () => {
    const detector = new ClientMicroDetector();
    const first = book(5_000, 2_000);
    expect(detector.onBook(1_000, first.asks, first.bids).events).toEqual([]);

    const second = book(200, 2_000);
    const { events, ofi } = detector.onBook(2_000, second.asks, second.bids);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("spoof_cancel");
    expect(events[0]!.ratioBps).toBe(10_000);
    expect(formatMicroCueTitle(events[0]!)).toContain("취소율 100%");
    expect(ofi.buyPressurePct).toBe(100);
    expect(ofi.ofiQty).toBe(4_800);
  });

  it("suppresses spoof_cancel when matched trade volume explains the drop", () => {
    const detector = new ClientMicroDetector();
    const first = book(5_000, 2_000);
    detector.onBook(1_000, first.asks, first.bids);
    detector.onTrade(1_500, 70_100, 4_800);
    const second = book(200, 2_000);
    expect(detector.onBook(2_000, second.asks, second.bids).events).toEqual([]);
  });

  it("skips single-price books with <= 3 levels per side", () => {
    const detector = new ClientMicroDetector();
    const first = book(5_000, 5_000);
    detector.onBook(1_000, first.asks, first.bids);
    const viAsks = first.asks.slice(0, 3).map((l) => ({ ...l, qty: 100 }));
    const viBids = first.bids.slice(0, 3).map((l) => ({ ...l, qty: 100 }));
    expect(detector.onBook(2_000, viAsks, viBids).events).toEqual([]);
  });
});
