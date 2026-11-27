import { describe, expect, it } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import { computeAnchoredVwap, resolveQuickAnchor } from "./anchoredVwap";

const mkBar = (t: number, o: number, h: number, l: number, c: number, v: number): Bar => ({ t, o, h, l, c, v });

describe("anchoredVwap", () => {
  it("computes cumulative VWAP and standard deviation bands from anchor time", () => {
    const bars: Bar[] = [
      mkBar(100, 100, 100, 100, 100, 10),
      mkBar(160, 100, 120, 100, 110, 20),
      mkBar(220, 110, 130, 110, 120, 20),
    ];
    const pts = computeAnchoredVwap(bars, 160, "close");
    expect(pts).toHaveLength(2);
    expect(pts[0]!.vwap).toBeCloseTo(110);
    expect(pts[0]!.upper1).toBeCloseTo(110);
    expect(pts[1]!.vwap).toBeCloseTo(115);
    expect(pts[1]!.upper1).toBeCloseTo(120);
    expect(pts[1]!.lower1).toBeCloseTo(110);
    expect(pts[1]!.upper2).toBeCloseTo(125);
    expect(pts[1]!.lower2).toBeCloseTo(105);
  });

  it("resolves open, low, high, and vi quick presets", () => {
    const bars: Bar[] = [
      mkBar(100, 100, 110, 95, 105, 10),
      mkBar(160, 105, 108, 80, 90, 20),
      mkBar(220, 90, 140, 88, 135, 30),
    ];
    expect(resolveQuickAnchor(bars, "open")).toBe(100);
    expect(resolveQuickAnchor(bars, "low")).toBe(160);
    expect(resolveQuickAnchor(bars, "high")).toBe(220);
    expect(resolveQuickAnchor(bars, "vi", [150])).toBe(160);
    expect(resolveQuickAnchor(bars, "vi", [])).toBeNull();
  });
});
