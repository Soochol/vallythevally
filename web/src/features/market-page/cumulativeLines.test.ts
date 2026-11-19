import { describe, expect, it } from "vitest";
import type { MarketOverviewIntradayPoint } from "../../api/generated/MarketOverviewIntradayPoint";
import { cumulativeLines, linePath, zeroY } from "./cumulativeLines";

const point = (at: number, individual: number | null, foreign: number | null, institution: number | null, program: number | null) =>
  ({ at, individualEok: individual, foreignEok: foreign, institutionEok: institution, programEok: program }) as unknown as MarketOverviewIntradayPoint;

const POINTS = [point(120, 100, -50, null, 10), point(0, 0, 0, 0, 0), point(60, 40, -20, 30, null), point(180, 300, -200, 80, 40)];

describe("cumulativeLines", () => {
  it("표본이 없으면 선이 없다", () => {
    expect(cumulativeLines([])).toBeNull();
  });
  it("시각 순으로 정렬하고 네 주체가 한 축을 쓴다", () => {
    const lines = cumulativeLines(POINTS)!;
    expect([lines.from, lines.to, lines.min, lines.max]).toEqual([0, 180, -200, 300]);
    expect(lines.series.individual[0]!.map((p) => p.at)).toEqual([0, 60, 120, 180]);
  });
  it("그 분에 실패한 값은 선을 끊는다", () => {
    const lines = cumulativeLines(POINTS)!;
    expect(lines.series.institution.map((segment) => segment.map((p) => p.at))).toEqual([[0, 60], [180]]);
    expect(lines.series.program.map((segment) => segment.map((p) => p.at))).toEqual([[0], [120, 180]]);
  });
  it("경로는 틀 안에서 위쪽이 큰 값이다", () => {
    const lines = cumulativeLines(POINTS)!;
    const frame = { width: 180, height: 100 };
    expect(linePath(lines, "individual", frame)).toBe("M0.0 60.0 L60.0 52.0 L120.0 40.0 L180.0 0.0");
    expect(zeroY(lines, frame)).toBeCloseTo(60, 5);
  });
});
