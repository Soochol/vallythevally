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
