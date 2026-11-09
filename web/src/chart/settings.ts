import type { SymbolCode } from "../api/generated/SymbolCode";

export type ChartStyle = "candle" | "bar" | "line" | "area";
export type PriceScale = "normal" | "log";

/** 칸의 차트 설정(frontend.md §5.5). 지표·패널은 #5에서 채운다. */
export interface ChartSettings {
  v: 1;
  style: ChartStyle;
  scale: PriceScale;
  indicators: never[];
  compare: SymbolCode[];
  panels: never[];
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  v: 1,
  style: "candle",
  scale: "normal",
  indicators: [],
  compare: [],
  panels: [],
};

export const CHART_STYLE_LABEL: Record<ChartStyle, string> = {
  candle: "캔들",
  bar: "바",
  line: "라인",
  area: "영역",
};

const CHART_STYLES = ["candle", "bar", "line", "area"] as const satisfies readonly ChartStyle[];
const PRICE_SCALES = ["normal", "log"] as const satisfies readonly PriceScale[];

const isOneOf = <T extends string>(xs: readonly T[], x: unknown): x is T => typeof x === "string" && (xs as readonly string[]).includes(x);
const isEmptyArray = (x: unknown): x is never[] => Array.isArray(x) && x.length === 0;

/**
 * 서버에서 받은 `Cell.chartSettings`를 한 번 검사한다(frontend.md §5.5). 모양이 틀리면 기본 설정을 돌려준다.
 * 지표와 패널은 #5 전이라 빈 배열만 받는다.
 */
export function parseChartSettings(raw: unknown): ChartSettings {
  const parsed = readChartSettings(raw);
  if (parsed) return parsed;
  console.warn("chartSettings 모양이 틀려 기본 설정으로 엽니다", raw);
  return DEFAULT_CHART_SETTINGS;
}

function readChartSettings(raw: unknown): ChartSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { v, style, scale, indicators, compare, panels } = raw as Record<string, unknown>;
  if (v !== 1 || !isOneOf(CHART_STYLES, style) || !isOneOf(PRICE_SCALES, scale)) return null;
  if (!isEmptyArray(indicators) || !isEmptyArray(panels)) return null;
  if (!Array.isArray(compare) || !compare.every((c): c is SymbolCode => typeof c === "string")) return null;
  return { v, style, scale, indicators, compare, panels };
}
