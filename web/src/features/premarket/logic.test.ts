import { describe, expect, test } from "vitest";
import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import { isKstPreMarketDaysPollWindow } from "../../api/premarket";
import {
  buildBreakoutSegments,
  buildChartGeometry,
  classifyBreakout,
  computeHistoricalBand,
  formatQty,
  formatSecOfDay,
  formatSignedPct,
  formatTurnover,
  formatVolumeValue,
  formatWon,
  nearestBandAt,
  nearestPointAt,
  pointVolumeValue,
  PREMARKET_END_SEC,
  PREMARKET_START_SEC,
  resolveChartStartSec,
  selectRangeDates,
  valueTone,
} from "./logic";

function makeDay(date: string, pts: readonly { sec: number; pct: number; qty: number; turnover: number }[]): PreMarketDaySeries {
  return {
    date,
    source: "store",
    points: pts.map((p) => ({
      secOfDay: p.sec,
      expectedPriceWon: 70000,
      expectedReturnPct: p.pct,
      expectedQty: p.qty,
      expectedTurnoverMillionWon: p.turnover,
    })),
    lateDropPct: 0,
    classification: "flat",
    openPriceWon: 70000,
    return0900Pct: 0,
    return0905Pct: 0,
    return0910Pct: 0,
  };
}

describe("premarket logic", () => {
  test("formats time, pct, won, qty, turnover, and tones", () => {
    expect(formatSecOfDay(PREMARKET_START_SEC)).toBe("08:50:00");
    expect(formatSecOfDay(PREMARKET_END_SEC, false)).toBe("09:00");
    expect(formatSignedPct(3.5)).toBe("+3.50%");
    expect(formatSignedPct(-1.2, 1)).toBe("-1.2%");
    expect(formatSignedPct(null)).toBe("—");
    expect(formatWon(73250)).toBe("73,250");
    expect(formatQty(25400)).toBe("2.5만주");
    expect(formatQty(25400, true)).toBe("2.5만");
    expect(formatQty(8500)).toBe("8,500주");
    expect(formatTurnover(250)).toBe("2.5억");
    expect(formatTurnover(42)).toBe("42백만");
    expect(formatVolumeValue(0, "turnover", true)).toBe("0");
    expect(valueTone(1.2)).toBe("up");
    expect(valueTone(-0.4)).toBe("down");
    expect(valueTone(0)).toBe("flat");
  });

  test("selects 5 or 10 most recent dates", () => {
    const days = [
      "20261113", "20261116", "20261117", "20261118", "20261119", "20261120",
      "20261123", "20261124", "20261125", "20261126", "20261127",
    ];
    expect(selectRangeDates(days, 5)).toEqual(["20261123", "20261124", "20261125", "20261126", "20261127"]);
    expect(selectRangeDates(days, 10)).toHaveLength(10);
    expect(selectRangeDates(days, 10)[0]).toBe("20261116");
  });

  test("computes min/p25/median/p75/max historical band for price and volume", () => {
    const d1 = makeDay("20261124", [
      { sec: 31800, pct: -1.0, qty: 10000, turnover: 700 },
      { sec: 32400, pct: 0.0, qty: 20000, turnover: 1400 },
    ]);
    const d2 = makeDay("20261125", [
      { sec: 31800, pct: 0.0, qty: 20000, turnover: 1400 },
      { sec: 32400, pct: 1.0, qty: 40000, turnover: 2800 },
    ]);
    const d3 = makeDay("20261126", [
      { sec: 31800, pct: 2.0, qty: 30000, turnover: 2100 },
      { sec: 32400, pct: 3.0, qty: 60000, turnover: 4200 },
    ]);

    const band = computeHistoricalBand([d1, d2, d3], "qty");
    expect(band.length).toBeGreaterThan(1);
    const start = nearestBandAt(band, PREMARKET_START_SEC)!;
    expect(start.minPct).toBeCloseTo(-1.0, 3);
    expect(start.p25Pct).toBeCloseTo(-0.5, 3);
    expect(start.medianPct).toBeCloseTo(0.0, 3);
    expect(start.p75Pct).toBeCloseTo(1.0, 3);
    expect(start.maxPct).toBeCloseTo(2.0, 3);
    expect(start.minVol).toBeCloseTo(10000, 3);
    expect(start.p25Vol).toBeCloseTo(15000, 3);
    expect(start.medianVol).toBeCloseTo(20000, 3);
    expect(start.p75Vol).toBeCloseTo(25000, 3);
    expect(start.maxVol).toBeCloseTo(30000, 3);
    expect(start.avgVol).toBeCloseTo(20000, 3);
  });

  test("classifies breakout states and builds excess fill polygons", () => {
    const pastA = makeDay("20261125", [
      { sec: 31800, pct: 0.0, qty: 10000, turnover: 700 },
      { sec: 32400, pct: 1.0, qty: 30000, turnover: 2100 },
    ]);
    const pastB = makeDay("20261126", [
      { sec: 31800, pct: 1.0, qty: 20000, turnover: 1400 },
      { sec: 32400, pct: 2.0, qty: 50000, turnover: 3500 },
    ]);
    const today = makeDay("20261127", [
      { sec: 31800, pct: 0.5, qty: 15000, turnover: 1050 },
      { sec: 32100, pct: 4.0, qty: 80000, turnover: 5600 },
      { sec: 32400, pct: -2.0, qty: 5000, turnover: 350 },
    ]);

    const band = computeHistoricalBand([pastA, pastB], "qty");
    const geom = buildChartGeometry([pastA, pastB, today], today, band, "qty");
    expect(geom.priceBottom).toBeLessThan(geom.volTop);
    expect(geom.xOf(PREMARKET_START_SEC)).toBeCloseTo(geom.plotLeft, 3);
    expect(geom.xOf(PREMARKET_END_SEC)).toBeCloseTo(geom.plotRight, 3);
    expect(geom.yOf(geom.minPct)).toBeCloseTo(geom.priceBottom, 3);
    expect(geom.yOf(geom.maxPct)).toBeCloseTo(geom.plotTop, 3);
    expect(geom.yVolOf(0)).toBeCloseTo(geom.plotBottom, 3);
    expect(geom.yVolOf(geom.maxVol)).toBeCloseTo(geom.volTop, 3);

    const priceSegs = buildBreakoutSegments(
      today.points,
      band,
      (pt) => pt.expectedReturnPct,
      (bp) => bp.minPct,
      (bp) => bp.maxPct,
      geom.xOf,
      geom.yOf,
    );
    expect(priceSegs).toHaveLength(2);
    expect(priceSegs[0]!.state).toBe("above");
    expect(priceSegs[0]!.excessPoly).not.toBeNull();
    expect(priceSegs[1]!.state).toBe("above");

    const volSegs = buildBreakoutSegments(
      today.points,
      band,
      (pt) => pointVolumeValue(pt, "qty"),
      (bp) => bp.minVol,
      (bp) => bp.maxVol,
      geom.xOf,
      geom.yVolOf,
    );
    expect(volSegs[0]!.state).toBe("above");
    expect(volSegs[0]!.excessPoly).not.toBeNull();

    const endBand = nearestBandAt(band, 32400);
    expect(classifyBreakout(4.0, endBand, (bp) => bp.minPct, (bp) => bp.maxPct)).toBe("above");
    expect(classifyBreakout(1.5, endBand, (bp) => bp.minPct, (bp) => bp.maxPct)).toBe("inside");
    expect(classifyBreakout(-2.0, endBand, (bp) => bp.minPct, (bp) => bp.maxPct)).toBe("below");
    expect(classifyBreakout(1.5, null, (bp) => bp.minPct, (bp) => bp.maxPct)).toBe("solo");

    const soloSegs = buildBreakoutSegments(
      today.points,
      [],
      (pt) => pt.expectedReturnPct,
      (bp) => bp.minPct,
      (bp) => bp.maxPct,
      geom.xOf,
      geom.yOf,
    );
    expect(soloSegs.every((seg) => seg.state === "solo" && seg.excessPoly === null)).toBe(true);
    expect(nearestPointAt(today.points, 32050)?.secOfDay).toBe(32100);

    const earlyDay = makeDay("20261124", [
      { sec: 31200, pct: 0.5, qty: 8000, turnover: 560 },
      { sec: 32400, pct: 1.0, qty: 20000, turnover: 1400 },
    ]);
    expect(resolveChartStartSec([earlyDay, today])).toBe(31200);
  });

  test("identifies KST weekday premarket boundary poll window", () => {
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-27T07:54:59+09:00"))).toBe(false);
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-27T07:55:00+09:00"))).toBe(true);
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-27T08:30:00+09:00"))).toBe(true);
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-27T09:04:59+09:00"))).toBe(true);
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-27T09:05:00+09:00"))).toBe(false);
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-28T08:15:00+09:00"))).toBe(false);
  });
});
