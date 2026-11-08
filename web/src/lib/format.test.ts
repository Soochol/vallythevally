import { describe, expect, test } from "vitest";
import { direction, formatChange, formatPercent, formatPrice, formatVolume } from "./format";

describe("formatPrice", () => {
  test.each([
    [85400, false, "85,400"],
    [193500, false, "193,500"],
    [1963.3, true, "1,963.30"],
    [5059.69, true, "5,059.69"],
    [0, false, "0"],
  ])("%d (지수 %s) → %s", (p, isIndex, want) => {
    expect(formatPrice(p, isIndex)).toBe(want);
  });
});

describe("formatChange", () => {
  test.each([
    [1600, false, "+1,600"],
    [-500, false, "−500"],
    [0, false, "0"],
    [68.64, true, "+68.64"],
    [-12.3, true, "−12.30"],
    [-0.001, true, "0.00"],
  ])("%d (지수 %s) → %s", (chg, isIndex, want) => {
    expect(formatChange(chg, isIndex)).toBe(want);
  });
});

describe("formatPercent", () => {
  test.each([
    [1.8617, "+1.86%"],
    [-0.5807, "−0.58%"],
    [0, "0.00%"],
    [-0.001, "0.00%"],
  ])("%d → %s", (pct, want) => {
    expect(formatPercent(pct)).toBe(want);
  });
});

describe("formatVolume", () => {
  test.each([
    [4594, "4,594"],
    [330_000, "33만"],
    [15_234_567, "1,523만"],
    [2_564_000_000, "25.64억"],
  ])("%d → %s", (v, want) => {
    expect(formatVolume(v)).toBe(want);
  });
});

test("direction", () => {
  expect([direction(3), direction(-1), direction(0)]).toEqual(["up", "down", "flat"]);
});
