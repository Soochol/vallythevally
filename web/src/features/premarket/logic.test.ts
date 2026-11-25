import { describe, expect, test } from "vitest";
import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import type { PreMarketSnapshotRow } from "../../api/generated/PreMarketSnapshotRow";
import {
  buildChartGeometry,
  defaultSelectedDates,
  filterSnapshotRows,
  formatSecOfDay,
  formatShortDate,
  formatSignedPct,
  formatTurnover,
  nearestPointAt,
  PREMARKET_END_SEC,
  PREMARKET_START_SEC,
  signalMeta,
  toggleDateSelection,
} from "./logic";

describe("premarket logic", () => {
  test("formats time, date, pct, turnover, and signals", () => {
    expect(formatSecOfDay(PREMARKET_START_SEC)).toBe("08:30:00");
    expect(formatSecOfDay(PREMARKET_END_SEC, false)).toBe("09:00");
    expect(formatShortDate("20261123")).toBe("11/23");
    expect(formatSignedPct(3.5)).toBe("+3.50%");
    expect(formatSignedPct(-1.2)).toBe("-1.20%");
    expect(formatSignedPct(null)).toBe("—");
    expect(formatTurnover(250)).toBe("2.5억");
    expect(formatTurnover(42)).toBe("42백만");
    expect(signalMeta("genuineGap")).toEqual({ label: "진성 갭", tone: "up" });
    expect(signalMeta("spoofWarning")).toEqual({ label: "허수 주의", tone: "warn" });
    expect(signalMeta("flat")).toEqual({ label: "보합", tone: "flat" });
  });

  test("toggles 1 to 4 dates and defaults to the 3 most recent", () => {
    const days = ["20261119", "20261120", "20261121", "20261122", "20261123"];
    expect(defaultSelectedDates(days)).toEqual(["20261121", "20261122", "20261123"]);
    expect(toggleDateSelection(["20261123"], "20261123")).toEqual(["20261123"]);
    expect(toggleDateSelection(["20261121", "20261122", "20261123"], "20261120")).toEqual([
      "20261120",
      "20261121",
      "20261122",
      "20261123",
    ]);
    expect(
      toggleDateSelection(["20261120", "20261121", "20261122", "20261123"], "20261119"),
    ).toEqual(["20261120", "20261121", "20261122", "20261123"]);
  });

  test("filters snapshot rows by signal and pre-market extension", () => {
    const rows: PreMarketSnapshotRow[] = [
      {
        code: "005930",
        name: "삼성전자",
        expectedPriceWon: 71000,
        expectedReturnPct: 1.5,
        expectedTurnoverMillionWon: 1200,
        lateDropPct: -4.2,
        signal: "spoofWarning",
        preMarketExtended: false,
        actual0900Pct: 1.0,
        actual0910Pct: -0.5,
      },
      {
        code: "000660",
        name: "SK하이닉스",
        expectedPriceWon: 208000,
        expectedReturnPct: 4.0,
        expectedTurnoverMillionWon: 2500,
        lateDropPct: 0.2,
        signal: "genuineGap",
        preMarketExtended: true,
        actual0900Pct: 4.0,
        actual0910Pct: 5.5,
      },
      {
        code: "035420",
        name: "NAVER",
        expectedPriceWon: 200000,
        expectedReturnPct: 0.1,
        expectedTurnoverMillionWon: 400,
        lateDropPct: 0.0,
        signal: "flat",
        preMarketExtended: false,
        actual0900Pct: 0.0,
        actual0910Pct: 0.1,
      },
    ];
    expect(filterSnapshotRows(rows, "all")).toHaveLength(3);
    expect(filterSnapshotRows(rows, "spoofWarning").map((r) => r.code)).toEqual(["005930"]);
    expect(filterSnapshotRows(rows, "genuineGap").map((r) => r.code)).toEqual(["000660"]);
    expect(filterSnapshotRows(rows, "extended").map((r) => r.code)).toEqual(["000660"]);
  });

  test("builds chart geometry and resolves nearest point at hovered time", () => {
    const series: PreMarketDaySeries[] = [
      {
        date: "20261123",
        source: "store",
        points: [
          { secOfDay: 30600, expectedPriceWon: 70000, expectedReturnPct: 0.0, expectedQty: 1000, expectedTurnoverMillionWon: 70 },
          { secOfDay: 31800, expectedPriceWon: 73500, expectedReturnPct: 5.0, expectedQty: 5000, expectedTurnoverMillionWon: 367.5 },
          { secOfDay: 32400, expectedPriceWon: 71400, expectedReturnPct: 2.0, expectedQty: 3000, expectedTurnoverMillionWon: 214.2 },
        ],
        lateDropPct: -3.0,
        classification: "spoofWarning",
        openPriceWon: 71400,
        return0900Pct: 2.0,
        return0905Pct: 1.0,
        return0910Pct: -0.5,
      },
    ];
    const geom = buildChartGeometry(series);
    expect(geom.xOf(PREMARKET_START_SEC)).toBeCloseTo(geom.plotLeft, 3);
    expect(geom.xOf(PREMARKET_END_SEC)).toBeCloseTo(geom.plotRight, 3);
    expect(geom.secOfX(geom.plotLeft)).toBe(PREMARKET_START_SEC);
    expect(geom.secOfX(geom.plotRight)).toBe(PREMARKET_END_SEC);
    expect(nearestPointAt(series[0]!.points, 31750)?.secOfDay).toBe(31800);
    expect(nearestPointAt(series[0]!.points, 32390)?.secOfDay).toBe(32400);
  });
});
