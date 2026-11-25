import { describe, expect, it } from "vitest";
import type { MarketOverviewDisclosureItem } from "../../api/generated/MarketOverviewDisclosureItem";
import type { MarketOverviewRrgSeries } from "../../api/generated/MarketOverviewRrgSeries";
import type { MarketOverviewSessionWindow } from "../../api/generated/MarketOverviewSessionWindow";
import {
  computeRrgBounds,
  disclosureCategoryLabel,
  disclosureCountFor,
  filterDisclosures,
  formatReceiptDate,
  formatRrgIndex,
  formatShares,
  orderbookPressureOf,
  projectRrgPoint,
  rrgArrowPolygon,
  rrgQuadrantCaption,
  rrgQuadrantLabel,
  rrgTrailPath,
  sessionBarPercent,
  sessionMaxAbsEok,
  signedShares,
  venueSplitOf,
} from "./proFormat";

const sampleSeries: MarketOverviewRrgSeries[] = [
  {
    code: "301",
    name: "HBM·AI반도체",
    quadrant: "leading",
    changeRate: 3.45,
    memberCount: 24,
    points: [
      { date: "2026-11-05", rsRatio: 99.2, rsMomentum: 100.4 },
      { date: "2026-11-09", rsRatio: 102.5, rsMomentum: 101.8 },
    ],
  },
];

const sampleWindows: MarketOverviewSessionWindow[] = [
  { id: "nxtPre", label: "NXT 프리", timeRange: "08:00–08:50", foreignDeltaEok: 40, institutionDeltaEok: -20, individualDeltaEok: -10, programDeltaEok: 5, sampleCount: 8 },
  { id: "krxOpen", label: "장초반", timeRange: "09:00–09:30", foreignDeltaEok: 320, institutionDeltaEok: -180, individualDeltaEok: -140, programDeltaEok: 110, sampleCount: 30 },
];

const sampleDisclosures: MarketOverviewDisclosureItem[] = [
  { code: "005930", name: "삼성전자", market: "kospi", category: "shareholder", reportName: "자기주식 취득 결정", receiptNo: "202611090001", receiptDate: "20261109", filer: "삼성전자", remarks: "", changeRate: 2.4 },
  { code: "000660", name: "SK하이닉스", market: "kospi", category: "contract", reportName: "단일판매·공급계약체결", receiptNo: "202611090002", receiptDate: "20261109", filer: "SK하이닉스", remarks: "", changeRate: 4.1 },
  { code: "196170", name: "알테오젠", market: "kosdaq", category: "earnings", reportName: "영업(잠정)실적", receiptNo: "202611080001", receiptDate: "20261108", filer: "알테오젠", remarks: "", changeRate: null },
];

describe("proFormat", () => {
  it("RRG 경계와 좌표 투영, 궤적 경로와 화살표를 계산한다", () => {
    const bounds = computeRrgBounds(sampleSeries);
    expect(bounds.minX).toBeLessThan(97.5);
    expect(bounds.maxX).toBeGreaterThan(102.5);
    expect(bounds.minX + bounds.maxX).toBeCloseTo(200, 6);
    expect(bounds.minY + bounds.maxY).toBeCloseTo(200, 6);

    const center = projectRrgPoint({ rsRatio: 100, rsMomentum: 100 }, bounds, 500, 300, 20);
    expect(center.x).toBeCloseTo(250, 4);
    expect(center.y).toBeCloseTo(150, 4);

    const leading = projectRrgPoint({ rsRatio: 102.5, rsMomentum: 101.8 }, bounds, 500, 300, 20);
    expect(leading.x).toBeGreaterThan(center.x);
    expect(leading.y).toBeLessThan(center.y);

    expect(rrgTrailPath([center])).toBe("");
    expect(rrgTrailPath([center, leading])).toMatch(/^M.+L.+$/);
    expect(rrgArrowPolygon([center])).toBe("");
    expect(rrgArrowPolygon([center, leading]).split(" ")).toHaveLength(3);

    expect(rrgQuadrantLabel("leading")).toBe("주도");
    expect(rrgQuadrantCaption("improving")).toBe("개선 (Improving)");
    expect(formatRrgIndex(101.456)).toBe("101.46");
  });

  it("세션 DNA 막대 스케일과 거래소 비중을 계산한다", () => {
    expect(sessionMaxAbsEok([])).toBe(1);
    expect(sessionMaxAbsEok(sampleWindows)).toBe(320);
    expect(sessionBarPercent(0, 320)).toBe(0);
    expect(sessionBarPercent(160, 320)).toBe(50);
    expect(sessionBarPercent(-320, 320)).toBe(100);
    expect(sessionBarPercent(1, 1000)).toBe(4);

    expect(venueSplitOf(80_000, 20_000)).toEqual({ krxPct: 80, nxtPct: 20, totalEok: 100_000 });
    expect(venueSplitOf(0, 0)).toEqual({ krxPct: 0, nxtPct: 0, totalEok: 0 });
  });

  it("호가 잔량 주수와 공시 분류·필터·날짜를 서식화한다", () => {
    expect(formatShares(4_200)).toBe("4,200주");
    expect(formatShares(125_000)).toBe("12.5만주");
    expect(signedShares(150_000)).toBe("+15.0만주");
    expect(signedShares(-25_000)).toBe("−2.5만주");
    expect(orderbookPressureOf({ totalBidRemaining: 0, totalAskRemaining: 0, buyPressurePct: 0 })).toEqual({ buyPct: 0, sellPct: 0 });
    expect(orderbookPressureOf({ totalBidRemaining: 300, totalAskRemaining: 200, buyPressurePct: 60 })).toEqual({ buyPct: 60, sellPct: 40 });

    expect(disclosureCategoryLabel("contract")).toBe("수주·계약");
    expect(disclosureCategoryLabel("capital")).toBe("증자·CB");
    expect(disclosureCountFor(sampleDisclosures, "all")).toBe(3);
    expect(disclosureCountFor(sampleDisclosures, "contract")).toBe(1);
    expect(disclosureCountFor(sampleDisclosures, "capital")).toBe(0);
    expect(filterDisclosures(sampleDisclosures, "all")).toHaveLength(3);
    expect(filterDisclosures(sampleDisclosures, "shareholder").map((row) => row.code)).toEqual(["005930"]);
    expect(formatReceiptDate("20261109")).toBe("2026.11.09");
    expect(formatReceiptDate("2026-11-09")).toBe("2026.11.09");
  });
});
