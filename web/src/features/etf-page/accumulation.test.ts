import { describe, expect, it } from "vitest";
import { tabOf } from "./EtfDetail";
import { formatAccumulationPeriod, formatBuyingSummary, formatMedianRealChange } from "./etfModel";

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
});
