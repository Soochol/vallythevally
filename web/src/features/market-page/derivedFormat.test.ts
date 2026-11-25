import { describe, expect, it } from "vitest";
import type { MarketOverviewIndexCard } from "../../api/generated/MarketOverviewIndexCard";
import { attributionBarPercent, bucketTone, formatPercent, formatViTime, maSparklinePath, maSparklinePoints, scopeLabel, thrustToneOf, viKindLabel } from "./derivedFormat";
import { activeMarketOf, resolveFreshness, scopeOf } from "./MarketPage";

describe("derivedFormat", () => {
  it("범위 이름과 URL 해석을 처리한다", () => {
    expect(scopeLabel("all")).toBe("전체");
    expect(scopeLabel("kospi")).toBe("코스피");
    expect(scopeLabel("kosdaq")).toBe("코스닥");
    expect(scopeOf("kosdaq", "kospi")).toBe("kosdaq");
    expect(scopeOf(null, "kosdaq")).toBe("kosdaq");
    expect(scopeOf(null, null)).toBe("all");
    expect(activeMarketOf("all")).toBe("kospi");
    expect(activeMarketOf("kosdaq")).toBe("kosdaq");
  });

  it("히스토그램 구간 라벨의 방향을 가른다", () => {
    expect(bucketTone("≤-10%")).toBe("down");
    expect(bucketTone("-5~-2%")).toBe("down");
    expect(bucketTone("-0.5~+0.5%")).toBe("flat");
    expect(bucketTone("+0.5~+2%")).toBe("up");
    expect(bucketTone("≥+10%")).toBe("up");
  });

  it("VI 시각과 유형, 백분율을 서식화한다", () => {
    expect(formatViTime("101532")).toBe("10:15:32");
    expect(formatViTime("10:15:32")).toBe("10:15:32");
    expect(formatViTime("0930")).toBe("09:30");
    expect(viKindLabel({ staticVi: true, dynamicVi: true })).toBe("정적·동적");
    expect(viKindLabel({ staticVi: true, dynamicVi: false })).toBe("정적");
    expect(viKindLabel({ staticVi: false, dynamicVi: true })).toBe("동적");
    expect(viKindLabel({ staticVi: false, dynamicVi: false })).toBe("VI");
    expect(formatPercent(54.26)).toBe("54.3%");
  });

  it("기여도 막대 비율, 추세 톤, MA 스파크라인 경로를 계산한다", () => {
    expect(attributionBarPercent(6, 12)).toBe(50);
    expect(attributionBarPercent(-12, 12)).toBe(100);
    expect(attributionBarPercent(5, 0)).toBe(0);
    expect(thrustToneOf(65)).toBe("up");
    expect(thrustToneOf(35)).toBe("down");
    expect(thrustToneOf(50)).toBe("flat");
    expect(maSparklinePath([], 280, 68)).toBe("");
    expect(maSparklinePoints([], 280, 68)).toEqual([]);
    const singlePoints = maSparklinePoints([{ date: "2026-11-09", above20Pct: 50 }], 280, 68);
    expect(singlePoints).toEqual([{ x: 140, y: 34 }]);
    const singlePath = maSparklinePath([{ date: "2026-11-09", above20Pct: 50 }], 280, 68);
    expect(singlePath).toBe("M136.0,34.0 L144.0,34.0");
    const path = maSparklinePath(
      [
        { date: "2026-11-05", above20Pct: 40 },
        { date: "2026-11-06", above20Pct: 55 },
        { date: "2026-11-09", above20Pct: 62 },
      ],
      280,
      68,
    );
    expect(path.startsWith("M")).toBe(true);
    expect(path.split("L")).toHaveLength(3);
  });

  it("전체 범위 신선도는 코스피·코스닥 중 하나라도 성공하면 실패로 표시하지 않는다", () => {
    const makeCard = (market: "kospi" | "kosdaq", phase: MarketOverviewIndexCard["context"]["phase"], receivedAt: number): MarketOverviewIndexCard => ({
      context: { market, phase, receivedAt, source: "kiwoom" },
      index: {
        status: "ok",
        value: {
          code: market === "kospi" ? "001" : "101",
          name: market === "kospi" ? "코스피" : "코스닥",
          level: 1000,
          changeRate: 0,
          breadth: { rising: 10, flat: 5, falling: 5, upperLimit: 0, lowerLimit: 0 },
          tradeValueEok: 1000,
          volatility: null,
        },
      },
    });
    const kospi = makeCard("kospi", "regular", 1000);
    const kosdaq = makeCard("kosdaq", "afterMarket", 2000);

    expect(resolveFreshness("all", { data: undefined, isError: true }, { data: kosdaq, isError: false })).toEqual({
      phase: kosdaq.context.phase,
      receivedAt: 2000,
      failed: false,
    });
    expect(resolveFreshness("all", { data: kospi, isError: false }, { data: kosdaq, isError: false })).toEqual({
      phase: kosdaq.context.phase,
      receivedAt: 2000,
      failed: false,
    });
    expect(resolveFreshness("all", { data: undefined, isError: true }, { data: undefined, isError: false })).toEqual({
      phase: null,
      receivedAt: null,
      failed: false,
    });
    expect(resolveFreshness("all", { data: undefined, isError: true }, { data: undefined, isError: true })).toEqual({
      phase: null,
      receivedAt: null,
      failed: true,
    });
    expect(resolveFreshness("kosdaq", { data: kospi, isError: false }, { data: undefined, isError: true })).toEqual({
      phase: null,
      receivedAt: null,
      failed: true,
    });
  });
});
