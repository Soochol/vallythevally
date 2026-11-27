import { describe, expect, it } from "vitest";
import type { ThemeTokens } from "../theme";
import { IchimokuCloudView, ichimokuPalette } from "./ichimokuCloud";

const DARK_TOKENS: ThemeTokens = {
  chartBg: "#0B0B0B",
  text: "#F3F1EC",
  text2: "#B6B3AB",
  text3: "#8E8B84",
  line: "rgba(255,255,255,0.11)",
  grid: "rgba(255,255,255,0.04)",
  gridH: "rgba(255,255,255,0.06)",
  raised: "#242424",
  onData: "#0B0B0B",
  accent: "#F3F1EC",
  crosshair: "#85827A",
  up: "#FF7272",
  down: "#6FABFF",
  upVol: "rgba(255,114,114,0.3)",
  downVol: "rgba(111,171,255,0.3)",
  seriesLine: "#F3F1EC",
  seriesFill: "rgba(243,241,236,0.08)",
  fontFamily: "sans-serif",
  fontSize: 11,
  ind: {
    "ind-1": "#E3BE76",
    "ind-2": "#B9A6FF",
    "ind-3": "#73D0BD",
    "ind-4": "#F49C73",
    "ind-5": "#A8B693",
  },
  cmp: { 1: "#F2B866", 2: "#EE9DD0", 3: "#6EC7D8" },
};

describe("ichimokuPalette", () => {
  it("양운(spanA)은 한국장 상승색(--up), 음운(spanB)은 하락색(--down)을 쓴다", () => {
    const palette = ichimokuPalette(DARK_TOKENS);
    expect(palette.spanA).toBe("#FF7272");
    expect(palette.spanB).toBe("#6FABFF");
    expect(palette.conversion).toBe("#73D0BD");
    expect(palette.base).toBe("#E3BE76");
    expect(palette.lagging).toBe("#B9A6FF");
  });

  it("기본 구름 옵션도 한국장 빨강·파랑을 사용한다", () => {
    const opts = new IchimokuCloudView().defaultOptions();
    expect(opts.bullColor).toBe("#FF7272");
    expect(opts.bearColor).toBe("#6FABFF");
  });
});
