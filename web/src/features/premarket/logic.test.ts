import { describe, expect, test } from "vitest";
import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import { isKstPreMarketDaysPollWindow } from "../../api/premarket";
import {
  buildChartGeometry,
  computeHistoricalBand,
  computePointDeltas,
  formatKoreanWeekday,
  formatQty,
  formatSecOfDay,
  formatShortDate,
  formatSignedPct,
  formatSignedQty,
  formatSignedTurnover,
  formatTurnover,
  groupDatesByWeek,
  kstTodayYyyymmdd,
  nearestBandAt,
  nearestPointAt,
  PREMARKET_END_SEC,
  PREMARKET_START_SEC,
  resolveChartStartSec,
  selectRangeDates,
  signalMeta,
  togglePinnedDate,
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
  test("formats time, date, weekday, pct, qty, turnover, and signals", () => {
    expect(formatSecOfDay(PREMARKET_START_SEC)).toBe("08:50:00");
    expect(formatSecOfDay(PREMARKET_END_SEC, false)).toBe("09:00");
    expect(formatShortDate("20261127")).toBe("11/27");
    expect(formatKoreanWeekday("20261127")).toBe("금");
    expect(formatKoreanWeekday("20261123")).toBe("월");
    expect(formatSignedPct(3.5)).toBe("+3.50%");
    expect(formatSignedPct(-1.2, 1)).toBe("-1.2%");
    expect(formatSignedPct(null)).toBe("—");
    expect(formatQty(25400)).toBe("2.5만주");
    expect(formatQty(8500)).toBe("8,500주");
    expect(formatSignedQty(-12000)).toBe("-1.2만주");
    expect(formatSignedQty(500)).toBe("+500주");
    expect(formatTurnover(250)).toBe("2.5억");
    expect(formatTurnover(42)).toBe("42백만");
    expect(formatSignedTurnover(-150)).toBe("-1.5억");
    expect(signalMeta("genuineGap")).toEqual({ label: "진성 갭", tone: "up" });
    expect(signalMeta("spoofWarning")).toEqual({ label: "허수 주의", tone: "warn" });
    expect(signalMeta("flat")).toEqual({ label: "보합", tone: "flat" });
  });

  test("selects 5 or 10 most recent dates and manages up to 2 pinned dates", () => {
    const days = [
      "20261113", "20261116", "20261117", "20261118", "20261119", "20261120",
      "20261123", "20261124", "20261125", "20261126", "20261127",
    ];
    expect(selectRangeDates(days, 5)).toEqual(["20261123", "20261124", "20261125", "20261126", "20261127"]);
    expect(selectRangeDates(days, 10)).toHaveLength(10);
    expect(selectRangeDates(days, 10)[0]).toBe("20261116");

    expect(togglePinnedDate([], "20261127", "20261127")).toEqual([]);
    expect(togglePinnedDate([], "20261125", "20261127")).toEqual(["20261125"]);
    expect(togglePinnedDate(["20261125"], "20261124", "20261127")).toEqual(["20261125", "20261124"]);
    expect(togglePinnedDate(["20261125", "20261124"], "20261120", "20261127")).toEqual(["20261124", "20261120"]);
    expect(togglePinnedDate(["20261124", "20261120"], "20261124", "20261127")).toEqual(["20261120"]);
  });

  test("groups descending dates into Korean week labels", () => {
    const desc = ["20261127", "20261126", "20261123", "20261120", "20261116"];
    const groups = groupDatesByWeek(desc);
    expect(groups.map((g) => ({ label: g.label, dates: g.dates }))).toEqual([
      { label: "이번주", dates: ["20261127", "20261126", "20261123"] },
      { label: "지난주", dates: ["20261120", "20261116"] },
    ]);
  });

  test("computes volume deltas, historical band, dual-axis geometry, and nearest lookup", () => {
    const d1 = makeDay("20261125", [
      { sec: 31800, pct: 0.0, qty: 10000, turnover: 700 },
      { sec: 32400, pct: 2.0, qty: 30000, turnover: 2100 },
    ]);
    const d2 = makeDay("20261126", [
      { sec: 31800, pct: 1.0, qty: 20000, turnover: 1400 },
      { sec: 32400, pct: 4.0, qty: 50000, turnover: 3500 },
    ]);
    const focus = makeDay("20261127", [
      { sec: 31800, pct: 1.5, qty: 15000, turnover: 1050 },
      { sec: 32100, pct: 5.0, qty: 45000, turnover: 3150 },
      { sec: 32400, pct: 1.0, qty: 20000, turnover: 1400 },
    ]);

    expect(computePointDeltas(focus.points, "qty")).toEqual([0, 30000, -25000]);
    const band = computeHistoricalBand([d1, d2], "qty");
    expect(band.length).toBeGreaterThan(1);
    const startBand = nearestBandAt(band, PREMARKET_START_SEC);
    expect(startBand?.median).toBeCloseTo(0.5, 3);
    expect(startBand?.avgVolume).toBeCloseTo(15000, 3);

    const geom = buildChartGeometry([d1, d2, focus], focus, band, null, "qty", [d2]);
    expect(geom.startSec).toBe(PREMARKET_START_SEC);
    expect(geom.xTicks).toEqual([31800, 31920, 32040, 32160, 32280, 32400]);
    expect(geom.xOf(PREMARKET_START_SEC)).toBeCloseTo(geom.plotLeft, 3);
    expect(geom.xOf(PREMARKET_END_SEC)).toBeCloseTo(geom.plotRight, 3);
    expect(geom.secOfX(geom.plotLeft)).toBe(PREMARKET_START_SEC);
    expect(geom.secOfX(geom.plotRight)).toBe(PREMARKET_END_SEC);
    expect(geom.priceBottom).toBeLessThan(geom.volTop);
    expect(geom.yOf(geom.minPct)).toBeCloseTo(geom.priceBottom, 3);
    expect(geom.yOf(geom.maxPct)).toBeCloseTo(geom.plotTop, 3);
    expect(geom.yVolOf(0)).toBeCloseTo(geom.plotBottom, 3);
    expect(geom.yVolOf(geom.maxVol)).toBeCloseTo(geom.volTop, 3);
    expect(geom.maxVol).toBeGreaterThanOrEqual(50000);
    expect(nearestPointAt(focus.points, 32050)?.secOfDay).toBe(32100);
    expect(nearestPointAt(focus.points, 32390)?.secOfDay).toBe(32400);

    const earlyDay = makeDay("20261124", [
      { sec: 31200, pct: 0.5, qty: 8000, turnover: 560 },
      { sec: 32400, pct: 1.0, qty: 20000, turnover: 1400 },
    ]);
    expect(resolveChartStartSec([earlyDay, focus])).toBe(31200);
    const expandedGeom = buildChartGeometry([earlyDay, focus], focus, [], null, "qty");
    expect(expandedGeom.startSec).toBe(31200);
    expect(expandedGeom.xOf(31200)).toBeCloseTo(expandedGeom.plotLeft, 3);
  });

  test("identifies KST weekday premarket boundary poll window and date string", () => {
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-27T07:54:59+09:00"))).toBe(false);
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-27T07:55:00+09:00"))).toBe(true);
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-27T08:30:00+09:00"))).toBe(true);
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-27T09:04:59+09:00"))).toBe(true);
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-27T09:05:00+09:00"))).toBe(false);
    expect(isKstPreMarketDaysPollWindow(Date.parse("2026-11-28T08:15:00+09:00"))).toBe(false);
    expect(kstTodayYyyymmdd(Date.parse("2026-11-27T00:10:00+09:00"))).toBe("20261127");
  });
});
