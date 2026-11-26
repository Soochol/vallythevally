import { describe, expect, it } from "vitest";
import { ReplayPaperEngine } from "./replayPaperEngine";

describe("ReplayPaperEngine", () => {
  it("executes marketable buy/sell immediately at best quote and computes realized P&L", () => {
    const paper = new ReplayPaperEngine({ initialCash: 10_000_000, nowPerf: () => 1000 });
    const ctx = { cursorMs: 32_400_000, bestAsk: 71_100, bestBid: 71_000, lastPrice: 71_000 };

    expect(paper.placeOrder("buy", 71_200, 10, ctx)).toBe(true);
    const afterBuy = paper.getSummary(71_200);
    expect(afterBuy.quantity).toBe(10);
    expect(afterBuy.avgPrice).toBe(71_100);
    expect(afterBuy.cash).toBe(10_000_000 - 711_000);
    expect(afterBuy.unrealizedPnl).toBe(1_000);
    expect(afterBuy.openOrders).toHaveLength(0);
    expect(afterBuy.fills).toHaveLength(1);
    expect(afterBuy.fills[0]!.price).toBe(71_100);

    expect(
      paper.placeOrder("sell", 71_000, 4, { cursorMs: 32_410_000, bestAsk: 71_300, bestBid: 71_200, lastPrice: 71_200 }),
    ).toBe(true);
    const afterSell = paper.getSummary(71_200);
    expect(afterSell.quantity).toBe(6);
    expect(afterSell.realizedPnl).toBe(400);
    expect(afterSell.fills[0]!.realizedPnl).toBe(400);
  });

  it("reserves cash/sellable quantity on resting limit orders and auto-fills when market hits price", () => {
    const paper = new ReplayPaperEngine({ initialCash: 1_000_000, nowPerf: () => 1000 });
    const ctx = { cursorMs: 32_400_000, bestAsk: 71_100, bestBid: 71_000, lastPrice: 71_000 };

    expect(paper.placeOrder("buy", 70_900, 10, ctx)).toBe(true);
    expect(paper.getAvailableCash()).toBe(1_000_000 - 709_000);
    expect(paper.placeOrder("buy", 70_800, 5, ctx)).toBe(false);

    expect(paper.onMarketStep({ ms: 32_405_000, tradePrice: 71_000, bestAsk: 71_100, bestBid: 71_000 })).toBe(false);
    expect(paper.onMarketStep({ ms: 32_410_000, tradePrice: 70_900, bestAsk: 71_000, bestBid: 70_900 })).toBe(true);

    const afterFill = paper.getSummary(71_200);
    expect(afterFill.openOrders).toHaveLength(0);
    expect(afterFill.quantity).toBe(10);
    expect(afterFill.avgPrice).toBe(70_900);

    expect(
      paper.placeOrder("sell", 71_300, 10, { cursorMs: 32_415_000, bestAsk: 71_200, bestBid: 71_100, lastPrice: 71_200 }),
    ).toBe(true);
    expect(paper.getSellableQuantity()).toBe(0);
    expect(paper.onMarketStep({ ms: 32_420_000, tradePrice: 71_300, bestAsk: 71_400, bestBid: 71_300 })).toBe(true);
    expect(paper.getSummary(71_300).quantity).toBe(0);
    expect(paper.getSummary(71_300).realizedPnl).toBe(4_000);
  });

  it("supports modifying order price, immediate fill on crossing, cancel, and flatten", () => {
    const paper = new ReplayPaperEngine({ initialCash: 5_000_000, nowPerf: () => 1000 });
    const ctx = { cursorMs: 32_400_000, bestAsk: 71_100, bestBid: 71_000, lastPrice: 71_000 };

    paper.placeOrder("buy", 70_800, 10, ctx);
    expect(paper.modifyOrdersAtPrice("buy", 70_800, 70_900, ctx)).toBe(true);
    expect(paper.getOpenOrders()[0]!.price).toBe(70_900);

    expect(paper.modifyOrdersAtPrice("buy", 70_900, 71_100, ctx)).toBe(true);
    expect(paper.getOpenOrders()).toHaveLength(0);
    expect(paper.getHolding().quantity).toBe(10);

    paper.placeOrder("sell", 71_500, 5, ctx);
    expect(paper.flattenPosition({ cursorMs: 32_420_000, bestAsk: 71_300, bestBid: 71_200, lastPrice: 71_200 })).toBe(true);
    expect(paper.getHolding().quantity).toBe(0);
    expect(paper.getOpenOrders()).toHaveLength(0);
    expect(paper.getSummary(71_200).realizedPnl).toBe(1_000);
  });

  it("applies fee and sell tax when enabled", () => {
    const paper = new ReplayPaperEngine({ initialCash: 10_000_000, nowPerf: () => 1000 });
    paper.setFeeEnabled(true);
    paper.placeOrder("buy", 100_000, 10, { cursorMs: 1000, bestAsk: 100_000, bestBid: 99_900, lastPrice: 100_000 });
    const buyFee = Math.round(1_000_000 * 0.00015);
    expect(paper.getSummary(100_000).totalFees).toBe(buyFee);

    paper.placeOrder("sell", 100_000, 10, { cursorMs: 2000, bestAsk: 100_100, bestBid: 100_000, lastPrice: 100_000 });
    const sellFee = Math.round(1_000_000 * (0.00015 + 0.0015));
    expect(paper.getSummary(100_000).totalFees).toBe(buyFee + sellFee);
    expect(paper.getSummary(100_000).realizedPnl).toBe(-(buyFee + sellFee));
  });

  it("restores snapshot on timeline rewind with undo and restores loop anchor on A-B repeat", () => {
    const paper = new ReplayPaperEngine({ initialCash: 10_000_000, nowPerf: () => 1000 });
    paper.seedAnchor(32_400_000);
    paper.placeOrder("buy", 71_100, 10, { cursorMs: 32_410_000, bestAsk: 71_100, bestBid: 71_000, lastPrice: 71_100 });
    paper.setLoopAnchor();
    paper.placeOrder("buy", 71_200, 5, { cursorMs: 32_420_000, bestAsk: 71_200, bestBid: 71_100, lastPrice: 71_200 });
    expect(paper.getHolding().quantity).toBe(15);

    paper.onRewind(32_410_000, 32_425_000, true);
    expect(paper.getHolding().quantity).toBe(10);

    const undo = paper.onRewind(32_400_000, 32_410_000, false);
    expect(undo).not.toBeNull();
    expect(paper.getHolding().quantity).toBe(0);

    paper.undoRewind();
    expect(paper.getHolding().quantity).toBe(10);
  });
});
