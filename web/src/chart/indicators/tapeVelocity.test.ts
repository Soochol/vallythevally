import { describe, expect, it } from "vitest";
import type { TapeVelocityPoint } from "../../api/generated/TapeVelocityPoint";
import { applyLiveTradeToTape, type LiveTapeBucket, tapeMetricValue } from "./tapeVelocity";

describe("tapeVelocity", () => {
  it("accumulates live trades into 1m TPS, turnover, buy ratio, and strength", () => {
    const buckets = new Map<number, LiveTapeBucket>();
    const points = new Map<number, TapeVelocityPoint>();
    const baseT = Math.floor(Date.parse("2026-11-27T09:05:10+09:00") / 1000);

    applyLiveTradeToTape(buckets, points, { t: baseT, price: 10000, qty: 100, venue: null, strength: 112.5 }, "1m");
    const pt = applyLiveTradeToTape(buckets, points, { t: baseT + 5, price: 10000, qty: -50, venue: null, strength: 108.0 }, "1m");

    expect(pt).not.toBeNull();
    expect(pt!.tps).toBeCloseTo(2 / 60);
    expect(pt!.turnoverMillionWon).toBeCloseTo(1.5);
    expect(pt!.buyRatioPct).toBeCloseTo((100 / 150) * 100);
    expect(pt!.strength).toBe(108.0);
    expect(tapeMetricValue(pt!, "tps")).toBeCloseTo(2 / 60);
    expect(tapeMetricValue(pt!, "turnover")).toBeCloseTo(1.5);
    expect(tapeMetricValue(pt!, "buyRatio")).toBeCloseTo((100 / 150) * 100);
  });
});
