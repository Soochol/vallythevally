import { describe, expect, it } from "vitest";
import type { EtfAccumulationRow } from "../../api/generated/EtfAccumulationRow";
import { tabOf } from "./EtfDetail";
import {
  filterAccumulationRows,
  formatAccumulationPeriod,
  formatBuyingSummary,
  formatMedianRealChange,
  radarSummary,
} from "./etfModel";

const sampleRow = (overrides: Partial<EtfAccumulationRow>): EtfAccumulationRow => ({
  code: "000660",
  name: "SK하이닉스",
  buyingEtfCount: 2,
  addedEtfCount: 0,
  increasedEtfCount: 2,
  medianRealChange: 0.2,
  ma: { ma20: "above", ma60: "above", ma120: "above" },
  contributors: [],
  ...overrides,
});

describe("동시 매집 모델", () => {
  it("accumulation 탭 식별자를 인식한다", () => {
    expect(tabOf("accumulation")).toBe("accumulation");
    expect(tabOf("unknown")).toBe("holdings");
    expect(tabOf(null)).toBe("holdings");
  });

  it("기간 배너는 시작일과 종료일이 모두 있을 때만 만든다", () => {
    expect(formatAccumulationPeriod("2026-11-11", "2026-11-18", 6)).toBe("2026-11-11 ~ 2026-11-18 · 수집일 6일");
    expect(formatAccumulationPeriod(null, null, 0)).toBeNull();
    expect(formatAccumulationPeriod("2026-11-18", null, 1)).toBeNull();
  });

  it("중앙 실질 증감률과 매수 ETF 요약 문구를 형식화한다", () => {
    expect(formatMedianRealChange(0.2766)).toBe("+27.7%");
    expect(formatMedianRealChange(null)).toBe("-");
    expect(formatBuyingSummary(3, 1)).toBe("3개 (신규 1)");
    expect(formatBuyingSummary(2, 0)).toBe("2개");
  });

  it("레이더 칩 필터와 요약 지표를 계산한다", () => {
    const rows: EtfAccumulationRow[] = [
      sampleRow({ code: "000660", name: "SK하이닉스", buyingEtfCount: 3, addedEtfCount: 1, ma: { ma20: "above", ma60: "above", ma120: "above" } }),
      sampleRow({ code: "402340", name: "SK스퀘어", buyingEtfCount: 1, addedEtfCount: 1, ma: { ma20: "above", ma60: "below", ma120: "below" } }),
      sampleRow({ code: "035420", name: "NAVER", buyingEtfCount: 2, addedEtfCount: 0, ma: { ma20: "above", ma60: "above", ma120: "above" } }),
    ];
    expect(filterAccumulationRows(rows, "all").map((r) => r.code)).toEqual(["000660", "402340", "035420"]);
    expect(filterAccumulationRows(rows, "added").map((r) => r.code)).toEqual(["000660", "402340"]);
    expect(filterAccumulationRows(rows, "aligned").map((r) => r.code)).toEqual(["000660", "035420"]);
    expect(filterAccumulationRows(rows, "multi").map((r) => r.code)).toEqual(["000660"]);
    expect(radarSummary(rows)).toEqual({
      total: 3,
      addedStocks: 2,
      alignedStocks: 2,
      topRow: rows[0],
    });
    expect(radarSummary([])).toEqual({ total: 0, addedStocks: 0, alignedStocks: 0, topRow: null });
  });
});
