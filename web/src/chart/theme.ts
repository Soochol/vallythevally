/** 차트가 쓰는 토큰 값. CSS 변수에서 읽는다(테마를 바꾸면 다시 읽어 setTheme). */
export interface ThemeTokens {
  chartBg: string;
  text2: string;
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
}

export function readThemeTokens(root: HTMLElement = document.documentElement): ThemeTokens {
  const s = getComputedStyle(root);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    chartBg: v("--chart-bg"),
    text2: v("--text-2"),
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
  };
}
