import { describe, expect, it } from "vitest";
import { attributionBarPercent, bucketTone, formatPercent, formatViTime, maSparklinePath, scopeLabel, thrustToneOf, viKindLabel } from "./derivedFormat";
import { activeMarketOf, scopeOf } from "./MarketPage";

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
});
