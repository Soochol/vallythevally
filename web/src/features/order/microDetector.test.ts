import { describe, expect, it } from "vitest";
import { ClientMicroDetector } from "./microDetector";

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
  it("computes OFI buy pressure and net quantity from top-of-book changes", () => {
    const detector = new ClientMicroDetector();
    const first = book(5_000, 2_000);
    expect(detector.onBook(1_000, first.asks, first.bids).ofiQty).toBe(0);

    const second = book(200, 2_000);
    const ofi = detector.onBook(2_000, second.asks, second.bids);
    expect(ofi.buyPressurePct).toBe(100);
    expect(ofi.ofiQty).toBe(4_800);
  });

  it("skips single-price books with <= 3 levels per side", () => {
    const detector = new ClientMicroDetector();
    const first = book(5_000, 5_000);
    detector.onBook(1_000, first.asks, first.bids);
    const viAsks = first.asks.slice(0, 3).map((l) => ({ ...l, qty: 100 }));
    const viBids = first.bids.slice(0, 3).map((l) => ({ ...l, qty: 100 }));
    expect(detector.onBook(2_000, viAsks, viBids).ofiQty).toBe(0);
  });

  it("ignores zero-qty placeholder levels in the single-price auction guard", () => {
    const detector = new ClientMicroDetector();
    const first = book(5_000, 5_000);
    detector.onBook(1_000, first.asks, first.bids);
    const placeholderAsks = [
      { priceWon: 70_100, qty: 100 },
      { priceWon: 70_200, qty: 100 },
      { priceWon: 70_300, qty: 100 },
      { priceWon: 70_400, qty: 0 },
      { priceWon: 70_500, qty: 0 },
    ];
    const placeholderBids = [
      { priceWon: 70_000, qty: 100 },
      { priceWon: 69_900, qty: 100 },
      { priceWon: 69_800, qty: 100 },
      { priceWon: 69_700, qty: 0 },
      { priceWon: 69_600, qty: 0 },
    ];
    expect(detector.onBook(2_000, placeholderAsks, placeholderBids).ofiQty).toBe(0);
    const restored = book(100, 100);
    expect(detector.onBook(3_000, restored.asks, restored.bids).ofiQty).toBe(0);
  });
});
