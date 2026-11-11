import { type IndicatorColor, type IndicatorToken } from "./indicators/kinds";
import { isHexColor } from "../lib/colors";

/** 차트가 쓰는 토큰 값. CSS 변수에서 읽는다(테마를 바꾸면 다시 읽어 setTheme). */
export interface ThemeTokens {
  chartBg: string;
  text: string;
  text2: string;
  text3: string;
  line: string;
  grid: string;
  raised: string;
  crosshair: string;
  up: string;
  down: string;
  upVol: string;
  downVol: string;
  seriesLine: string;
  seriesFill: string;
  fontFamily: string;
  fontSize: number;
  ind: Record<IndicatorToken, string>;
  cmp: Record<1 | 2 | 3, string>;
}

export function readThemeTokens(root: HTMLElement = document.documentElement): ThemeTokens {
  const s = getComputedStyle(root);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    chartBg: v("--chart-bg"),
    text: v("--text"),
    text2: v("--text-2"),
    text3: v("--text-3"),
    line: v("--line"),
    grid: v("--grid"),
    raised: v("--raised"),
    crosshair: v("--crosshair"),
    up: v("--up"),
    down: v("--down"),
    upVol: v("--up-vol"),
    downVol: v("--down-vol"),
    seriesLine: v("--series-line"),
    seriesFill: v("--series-fill"),
    fontFamily: v("--font-sans"),
    fontSize: Number.parseFloat(v("--fs-s")) || 12,
    ind: { "ind-1": v("--ind-1"), "ind-2": v("--ind-2"), "ind-3": v("--ind-3"), "ind-4": v("--ind-4"), "ind-5": v("--ind-5") },
    cmp: { 1: v("--cmp-1"), 2: v("--cmp-2"), 3: v("--cmp-3") },
  };
}

export const indicatorColorValue = (tokens: ThemeTokens, color: IndicatorColor): string => isHexColor(color) ? color : tokens.ind[color];
