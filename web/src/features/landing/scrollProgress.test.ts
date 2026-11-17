import { describe, expect, it } from "vitest";
import { progressOf, stepOf } from "./scrollProgress";

describe("progressOf", () => {
  it("고정 구간 안의 위치를 0~1로 돌려준다", () => {
    expect(progressOf(0, 0, 3600, 900)).toBe(0);
    expect(progressOf(1350, 0, 3600, 900)).toBeCloseTo(0.5);
    expect(progressOf(2700, 0, 3600, 900)).toBe(1);
  });
  it("구간 밖은 0과 1로 자른다", () => {
    expect(progressOf(-10, 0, 3600, 900)).toBe(0);
    expect(progressOf(5000, 0, 3600, 900)).toBe(1);
  });
  it("구간이 뷰포트보다 짧으면 0이다", () => {
    expect(progressOf(100, 0, 800, 900)).toBe(0);
  });
});

describe("stepOf", () => {
  it("진행률 4등분마다 장 번호가 1에서 4까지 바뀐다", () => {
    expect([0, 0.2499, 0.25, 0.4999, 0.5, 0.7499, 0.75, 1].map(stepOf)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
});
