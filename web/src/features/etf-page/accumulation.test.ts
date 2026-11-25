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
  sellingEtfCount: 0,
  removedEtfCount: 0,
  decreasedEtfCount: 0,
  medianRealChange: 0.2,
  ma: { ma20: "above", ma60: "above", ma120: "above" },
  contributors: [],
  ...overrides,
});

describe("동시 매집 모델", () => {
  it("accumulation과 similar 탭 식별자를 인식한다", () => {
    expect(tabOf("accumulation")).toBe("accumulation");
    expect(tabOf("similar")).toBe("similar");
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
    expect(formatMedianRealChange(-0.2021)).toBe("-20.2%");
    expect(formatMedianRealChange(null)).toBe("-");
    expect(formatBuyingSummary(3, 1)).toBe("3개 (신규 1)");
    expect(formatBuyingSummary(2, 0)).toBe("2개");
  });

  it("매수 레이더 칩 필터와 요약 지표를 계산한다", () => {
    const rows: EtfAccumulationRow[] = [
      sampleRow({ code: "000660", name: "SK하이닉스", buyingEtfCount: 3, addedEtfCount: 1, ma: { ma20: "above", ma60: "above", ma120: "above" } }),
      sampleRow({ code: "402340", name: "SK스퀘어", buyingEtfCount: 1, addedEtfCount: 1, ma: { ma20: "above", ma60: "below", ma120: "below" } }),
      sampleRow({ code: "035420", name: "NAVER", buyingEtfCount: 2, addedEtfCount: 0, ma: { ma20: "above", ma60: "above", ma120: "above" } }),
    ];
    expect(filterAccumulationRows(rows, "all", "buy").map((r) => r.code)).toEqual(["000660", "402340", "035420"]);
    expect(filterAccumulationRows(rows, "added", "buy").map((r) => r.code)).toEqual(["000660", "402340"]);
    expect(filterAccumulationRows(rows, "aligned", "buy").map((r) => r.code)).toEqual(["000660", "035420"]);
    expect(filterAccumulationRows(rows, "multi", "buy").map((r) => r.code)).toEqual(["000660"]);
    expect(radarSummary(rows, "buy")).toEqual({
      total: 3,
      edgeStocks: 2,
      trendStocks: 2,
      topRow: rows[0],
    });
    expect(radarSummary([], "buy")).toEqual({ total: 0, edgeStocks: 0, trendStocks: 0, topRow: null });
  });

  it("매도 레이더 칩 필터와 요약 지표를 계산한다", () => {
    const rows: EtfAccumulationRow[] = [
      sampleRow({
        code: "086520",
        name: "에코프로",
        buyingEtfCount: 0,
        addedEtfCount: 0,
        increasedEtfCount: 0,
        sellingEtfCount: 3,
        removedEtfCount: 1,
        decreasedEtfCount: 2,
        medianRealChange: -0.24,
        ma: { ma20: "below", ma60: "below", ma120: "below" },
      }),
      sampleRow({
        code: "005930",
        name: "삼성전자",
        buyingEtfCount: 0,
        addedEtfCount: 0,
        increasedEtfCount: 0,
        sellingEtfCount: 2,
        removedEtfCount: 0,
        decreasedEtfCount: 2,
        medianRealChange: -0.18,
        ma: { ma20: "above", ma60: "below", ma120: "below" },
      }),
      sampleRow({
        code: "051910",
        name: "LG화학",
        buyingEtfCount: 0,
        addedEtfCount: 0,
        increasedEtfCount: 0,
        sellingEtfCount: 1,
        removedEtfCount: 1,
        decreasedEtfCount: 0,
        medianRealChange: null,
        ma: { ma20: "below", ma60: null, ma120: null },
      }),
    ];
    expect(filterAccumulationRows(rows, "all", "sell").map((r) => r.code)).toEqual(["086520", "005930", "051910"]);
    expect(filterAccumulationRows(rows, "added", "sell").map((r) => r.code)).toEqual(["086520", "051910"]);
    expect(filterAccumulationRows(rows, "aligned", "sell").map((r) => r.code)).toEqual(["086520"]);
    expect(filterAccumulationRows(rows, "multi", "sell").map((r) => r.code)).toEqual(["086520"]);
    expect(radarSummary(rows, "sell")).toEqual({
      total: 3,
      edgeStocks: 2,
      trendStocks: 1,
      topRow: rows[0],
    });
  });
});
