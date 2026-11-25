import type { IndicatorSpec as TechnicalSpec } from "../../api/generated/IndicatorSpec";
import type { FinancialMetric } from "../../api/generated/FinancialMetric";
import type { LineId } from "../../api/generated/LineId";
import type { QuoteDepthSource } from "../../api/generated/QuoteDepthSource";
import type { SpecValidation } from "../../wasm/indicators/indicators.js";
import { isHexColor, PRESET_COLORS, type HexColor } from "../../lib/colors";

export type QuoteDepthSpec = {
  kind: "quoteDepth";
  source: QuoteDepthSource;
  topLevels: number | null;
  maxOpacity: number;
  aboveBars: boolean;
  askColor: HexColor | null;
  bidColor: HexColor | null;
};
export type QuoteSpec = { kind: "quoteTotals" } | QuoteDepthSpec;
export type TickCvdSpec = {
  kind: "tickCvd";
  showWhale: boolean;
  showLarge: boolean;
  showMid: boolean;
  showRetail: boolean;
};
export type ProgramFlowSpec = {
  kind: "programFlow";
  showShare: boolean;
};
export type MicroSpec = TickCvdSpec | ProgramFlowSpec;
export type IndicatorSpec = TechnicalSpec | { [K in FinancialMetric]: { kind: K } }[FinancialMetric] | QuoteSpec | MicroSpec;
export type FinancialSpec = Extract<IndicatorSpec, { kind: FinancialMetric }>;
export const FINANCIAL_LABEL: Record<FinancialMetric, string> = { revenue: "매출액", operating_income: "영업이익", owner_roe: "지배주주 ROE", investing_cash_flow: "투자활동 현금흐름", dps: "DPS", debt_ratio: "부채비율" };
export const isFinancial = (spec: IndicatorSpec): spec is FinancialSpec => spec.kind in FINANCIAL_LABEL;
export const isQuoteTotals = (spec: IndicatorSpec): spec is { kind: "quoteTotals" } => spec.kind === "quoteTotals";
export const isQuoteDepth = (spec: IndicatorSpec): spec is QuoteDepthSpec => spec.kind === "quoteDepth";
export const isQuote = (spec: IndicatorSpec): spec is QuoteSpec => isQuoteTotals(spec) || isQuoteDepth(spec);
export const isTickCvd = (spec: IndicatorSpec): spec is TickCvdSpec => spec.kind === "tickCvd";
export const isProgramFlow = (spec: IndicatorSpec): spec is ProgramFlowSpec => spec.kind === "programFlow";
export const isMicro = (spec: IndicatorSpec): spec is MicroSpec => isTickCvd(spec) || isProgramFlow(spec);
export const isTechnical = (spec: IndicatorSpec): spec is TechnicalSpec => !isFinancial(spec) && !isQuote(spec) && !isMicro(spec);
export const isFinancialBar = (kind: FinancialMetric) => kind !== "owner_roe" && kind !== "debt_ratio";
export type PlotLineId =
  | LineId
  | "financial"
  | "quoteAsk"
  | "quoteBid"
  | "cvdWhale"
  | "cvdLarge"
  | "cvdMid"
  | "cvdRetail"
  | "programNet"
  | "programShare";

export type IndicatorKind = IndicatorSpec["kind"];
export type SpecOf<K extends IndicatorKind> = Extract<IndicatorSpec, { kind: K }>;
export type Placement = "price" | "panel";
export type Validate = (spec: IndicatorSpec) => SpecValidation;

export const INDICATOR_COLORS = ["ind-1", "ind-2", "ind-3", "ind-4", "ind-5"] as const;
export type IndicatorToken = (typeof INDICATOR_COLORS)[number];
export type IndicatorColor = IndicatorToken | HexColor;
export const isIndicatorColor = (value: unknown): value is IndicatorColor => isHexColor(value) || INDICATOR_COLORS.some((c) => c === value);
export const indicatorCssColor = (color: IndicatorColor): string => isHexColor(color) ? color : `var(--${color})`;

export type SpecField =
  | { key: string; label: string; type: "int"; unit?: string }
  | { key: string; label: string; type: "float" }
  | { key: string; label: string; type: "optionalInt"; unit?: string; toggle: string; start: number; max?: number }
  | { key: string; label: string; type: "method" }
  | { key: string; label: string; type: "choice"; options: readonly (readonly [value: string, label: string])[] }
  | { key: string; label: string; type: "flag" }
  | { key: string; label: string; type: "percent"; min: number; max: number; step: number }
  | { key: string; label: string; type: "color"; token: "up" | "down" };

interface KindInfo<K extends IndicatorKind> {
  label: string;
  place: Placement;
  overPrice?: true;
  defaults: SpecOf<K>;
  fields: SpecField[];
  name(spec: SpecOf<K>): string;
  lines(spec: SpecOf<K>): PlotLineId[];
}

type Registry = { [K in IndicatorKind]: KindInfo<K> };

const int = (key: string, label: string, unit?: string): SpecField => ({ key, label, type: "int", unit });

const financialKind = <K extends FinancialMetric>(kind: K, defaults: SpecOf<K>): KindInfo<K> => ({ label: FINANCIAL_LABEL[kind], place: "panel", defaults, fields: [], name: () => FINANCIAL_LABEL[kind], lines: () => ["financial"] });

export const KINDS: Registry = {
  revenue: financialKind("revenue", { kind: "revenue" }),
  operating_income: financialKind("operating_income", { kind: "operating_income" }),
  owner_roe: financialKind("owner_roe", { kind: "owner_roe" }),
  investing_cash_flow: financialKind("investing_cash_flow", { kind: "investing_cash_flow" }),
  dps: financialKind("dps", { kind: "dps" }),
  debt_ratio: financialKind("debt_ratio", { kind: "debt_ratio" }),
  ma: {
    label: "이동평균",
    place: "price",
    defaults: { kind: "ma", method: "sma", period: 20 },
    fields: [{ key: "method", label: "계산 방식", type: "method" }, int("period", "기간", "봉")],
    name: (s) => `이동평균 ${s.method === "sma" ? "단순" : "지수"} ${s.period}`,
    lines: () => ["ma"],
  },
  bollinger: {
    label: "볼린저 밴드",
    place: "price",
    defaults: { kind: "bollinger", period: 20, k: 2 },
    fields: [int("period", "기간", "봉"), { key: "k", label: "표준편차 배수", type: "float" }],
    name: (s) => `볼린저 밴드 ${s.period} ${s.k}`,
    lines: () => ["upper", "middle", "lower"],
  },
  ichimoku: {
    label: "일목균형표",
    place: "price",
    defaults: { kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 },
    fields: [int("conversion", "전환선", "봉"), int("base", "기준선", "봉"), int("spanB", "선행스팬 B", "봉"), int("displacement", "이동", "봉")],
    name: (s) => `일목균형표 ${s.conversion} ${s.base} ${s.spanB} ${s.displacement}`,
    lines: () => ["conversion", "base", "spanA", "spanB", "lagging"],
  },
  volume: {
    label: "거래량",
    place: "panel",
    overPrice: true,
    defaults: { kind: "volume", maPeriod: 20 },
    fields: [{ key: "maPeriod", label: "이동평균", type: "optionalInt", unit: "봉", toggle: "이동평균 함께 그리기", start: 20 }],
    name: () => "거래량",
    lines: (s) => (s.maPeriod === null ? ["volume"] : ["volume", "ma"]),
  },
  rsi: {
    label: "RSI",
    place: "panel",
    defaults: { kind: "rsi", period: 14, signal: null },
    fields: [int("period", "기간", "봉"), { key: "signal", label: "시그널", type: "optionalInt", unit: "봉", toggle: "시그널 함께 그리기", start: 9 }],
    name: (s) => (s.signal === null ? `RSI ${s.period}` : `RSI ${s.period} ${s.signal}`),
    lines: (s) => (s.signal === null ? ["rsi"] : ["rsi", "signal"]),
  },
  macd: {
    label: "MACD",
    place: "panel",
    defaults: { kind: "macd", fast: 12, slow: 26, signal: 9 },
    fields: [int("fast", "빠른 기간", "봉"), int("slow", "느린 기간", "봉"), int("signal", "시그널", "봉")],
    name: (s) => `MACD ${s.fast} ${s.slow} ${s.signal}`,
    lines: () => ["macd", "signal", "histogram"],
  },
  stochSlow: {
    label: "스토캐스틱 슬로우",
    place: "panel",
    defaults: { kind: "stochSlow", k: 5, d: 3, smooth: 3 },
    fields: [int("k", "%K 기간", "봉"), int("d", "%D 기간", "봉"), int("smooth", "평활", "봉")],
    name: (s) => `스토캐스틱 슬로우 ${s.k} ${s.d} ${s.smooth}`,
    lines: () => ["k", "d"],
  },
  tickCvd: {
    label: "계층별 CVD",
    place: "panel",
    defaults: { kind: "tickCvd", showWhale: true, showLarge: false, showMid: false, showRetail: true },
    fields: [
      { key: "showWhale", label: "초대형(1억+)", type: "flag" },
      { key: "showLarge", label: "대형(3천만~1억)", type: "flag" },
      { key: "showMid", label: "중형(5백만~3천만)", type: "flag" },
      { key: "showRetail", label: "소형(5백만 미만)", type: "flag" },
    ],
    name: () => "계층별 CVD",
    lines: (s) => {
      const out: PlotLineId[] = [];
      if (s.showWhale) out.push("cvdWhale");
      if (s.showLarge) out.push("cvdLarge");
      if (s.showMid) out.push("cvdMid");
      if (s.showRetail) out.push("cvdRetail");
      return out;
    },
  },
  programFlow: {
    label: "프로그램 수급",
    place: "panel",
    defaults: { kind: "programFlow", showShare: false },
    fields: [{ key: "showShare", label: "프로그램 비중(%) 표시", type: "flag" }],
    name: () => "프로그램 수급",
    lines: (s) => (s.showShare ? ["programNet", "programShare"] : ["programNet"]),
  },
  quoteTotals: {
    label: "총잔량",
    place: "panel",
    defaults: { kind: "quoteTotals" },
    fields: [],
    name: () => "총잔량",
    lines: () => ["quoteAsk", "quoteBid"],
  },
  quoteDepth: {
    label: "호가 잔량 히트맵",
    place: "price",
    defaults: { kind: "quoteDepth", source: "priceMax", topLevels: null, maxOpacity: 0.7, aboveBars: false, askColor: null, bidColor: null },
    fields: [
      { key: "source", label: "잔량 기준", type: "choice", options: [["priceMax", "가격대마다 최댓값"], ["peak", "총잔량 최대 순간"], ["close", "종가 호가"]] },
      { key: "topLevels", label: "가격대 수", type: "optionalInt", unit: "개", toggle: "최대 잔량 가격대만", start: 1, max: 5 },
      { key: "maxOpacity", label: "최대 불투명도", type: "percent", min: 20, max: 100, step: 5 },
      { key: "aboveBars", label: "봉 앞에 그리기", type: "flag" },
      { key: "askColor", label: "매도 색", type: "color", token: "down" },
      { key: "bidColor", label: "매수 색", type: "color", token: "up" },
    ],
    name: () => "호가 잔량 히트맵",
    lines: () => [],
  },
};

export const KIND_ORDER: IndicatorKind[] = ["ma", "bollinger", "ichimoku", "volume", "rsi", "macd", "stochSlow", "tickCvd", "programFlow", "quoteTotals", "quoteDepth", "revenue", "operating_income", "owner_roe", "investing_cash_flow", "dps", "debt_ratio"];

const kindInfo = <K extends IndicatorKind>(kind: K): KindInfo<K> => KINDS[kind];

export function specName(spec: IndicatorSpec): string {
  return (kindInfo(spec.kind).name as (s: IndicatorSpec) => string)(spec);
}

export function specLines(spec: IndicatorSpec): PlotLineId[] {
  return (kindInfo(spec.kind).lines as (s: IndicatorSpec) => PlotLineId[])(spec);
}

export function placementOf(spec: IndicatorSpec): Placement {
  return KINDS[spec.kind].place;
}

export const placementsOf = (kind: IndicatorKind): readonly Placement[] => KINDS[kind].overPrice ? ["panel", "price"] : [KINDS[kind].place];

export const isBarLine = (line: PlotLineId): boolean => line === "volume" || line === "histogram";

export const LINE_LABEL: Record<PlotLineId, string> = {
  financial: "재무지표",
  ma: "이동평균",
  upper: "상단",
  middle: "중심",
  lower: "하단",
  conversion: "전환선",
  base: "기준선",
  spanA: "선행스팬 A",
  spanB: "선행스팬 B",
  lagging: "후행스팬",
  volume: "거래량",
  rsi: "RSI",
  signal: "시그널",
  macd: "MACD",
  histogram: "히스토그램",
  k: "%K",
  d: "%D",
  quoteAsk: "매도총잔량",
  quoteBid: "매수총잔량",
  cvdWhale: "초대형",
  cvdLarge: "대형",
  cvdMid: "중형",
  cvdRetail: "소형",
  programNet: "순매수",
  programShare: "비중",
};

export function colorLine(spec: IndicatorSpec): number | null {
  if (isQuote(spec)) return null;
  if (isFinancial(spec) && isFinancialBar(spec.kind)) return null;
  const i = specLines(spec).findIndex((l) => !isBarLine(l));
  return i < 0 ? null : i;
}

const wrap = (i: number) => INDICATOR_COLORS[((i % INDICATOR_COLORS.length) + INDICATOR_COLORS.length) % INDICATOR_COLORS.length]!;

export function colorsFrom(spec: IndicatorSpec, base: IndicatorColor): IndicatorColor[] {
  const p = colorLine(spec) ?? 0;
  if (isHexColor(base)) {
    const b = PRESET_COLORS.indexOf(base);
    return specLines(spec).map((_, i) => i === p ? base : PRESET_COLORS[((Math.max(0, b) + i - p) % PRESET_COLORS.length + PRESET_COLORS.length) % PRESET_COLORS.length] ?? base);
  }
  const b = INDICATOR_COLORS.indexOf(base);
  return specLines(spec).map((_, i) => wrap(b + i - p));
}

export function firstUnusedColor(used: readonly IndicatorColor[]): IndicatorColor {
  return INDICATOR_COLORS.find((c) => !used.includes(c)) ?? PRESET_COLORS.find((c) => !used.includes(c)) ?? INDICATOR_COLORS[0];
}

export function shownColor(spec: IndicatorSpec, colors: readonly IndicatorColor[]): IndicatorColor {
  return lineColor(spec, colors, colorLine(spec) ?? 0);
}

export function lineColor(spec: IndicatorSpec, colors: readonly IndicatorColor[], i: number): IndicatorColor {
  const own = colors[i];
  if (own) return own;
  const p = colorLine(spec) ?? 0;
  const base = colors[p] ?? colors[0] ?? INDICATOR_COLORS[0];
  if (isHexColor(base)) return colorsFrom(spec, base)[i] ?? base;
  return wrap(INDICATOR_COLORS.indexOf(base) + i - p);
}
