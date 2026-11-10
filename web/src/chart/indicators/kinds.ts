import type { IndicatorSpec } from "../../api/generated/IndicatorSpec";
import type { LineId } from "../../api/generated/LineId";

export type IndicatorKind = IndicatorSpec["kind"];
export type SpecOf<K extends IndicatorKind> = Extract<IndicatorSpec, { kind: K }>;
export type Placement = "price" | "panel";

export const INDICATOR_COLORS = ["ind-1", "ind-2", "ind-3", "ind-4", "ind-5"] as const;
export type IndicatorColor = (typeof INDICATOR_COLORS)[number];

export type SpecField =
  | { key: string; label: string; type: "int"; unit?: string }
  | { key: string; label: string; type: "float" }
  | { key: string; label: string; type: "optionalInt"; unit?: string; toggle: string }
  | { key: string; label: string; type: "method" };

interface KindInfo<K extends IndicatorKind> {
  label: string;
  place: Placement;
  defaults: SpecOf<K>;
  fields: SpecField[];
  name(spec: SpecOf<K>): string;
  lines(spec: SpecOf<K>): LineId[];
}

type Registry = { [K in IndicatorKind]: KindInfo<K> };

const int = (key: string, label: string, unit?: string): SpecField => ({ key, label, type: "int", unit });

/** 지표 종류 일곱 가지(frontend.md §3.3). 기본값은 backend.md §9.5, 선 순서는 `indicators::Spec::lines`와 같다. */
export const KINDS: Registry = {
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
    defaults: { kind: "volume", maPeriod: 20 },
    fields: [{ key: "maPeriod", label: "이동평균", type: "optionalInt", unit: "봉", toggle: "이동평균 함께 그리기" }],
    name: () => "거래량",
    lines: (s) => (s.maPeriod === null ? ["volume"] : ["volume", "ma"]),
  },
  rsi: {
    label: "RSI",
    place: "panel",
    defaults: { kind: "rsi", period: 14, signal: null },
    fields: [int("period", "기간", "봉"), { key: "signal", label: "시그널", type: "optionalInt", unit: "봉", toggle: "시그널 함께 그리기" }],
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
};

export const KIND_ORDER: IndicatorKind[] = ["ma", "bollinger", "ichimoku", "volume", "rsi", "macd", "stochSlow"];

const kindInfo = <K extends IndicatorKind>(kind: K): KindInfo<K> => KINDS[kind];

export function specName(spec: IndicatorSpec): string {
  return (kindInfo(spec.kind).name as (s: IndicatorSpec) => string)(spec);
}

export function specLines(spec: IndicatorSpec): LineId[] {
  return (kindInfo(spec.kind).lines as (s: IndicatorSpec) => LineId[])(spec);
}

export function placementOf(spec: IndicatorSpec): Placement {
  return KINDS[spec.kind].place;
}

/** 막대로 그리는 선. 색은 설정이 아니라 등락(거래량)이나 부호(MACD 히스토그램)로 정한다. */
export const isBarLine = (line: LineId): boolean => line === "volume" || line === "histogram";

export const LINE_LABEL: Record<LineId, string> = {
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
};

/** 색을 고를 선: 막대가 아닌 첫 선. 없으면(이동평균 없는 거래량) 고를 색이 없다. */
export function primaryLine(spec: IndicatorSpec): number | null {
  const i = specLines(spec).findIndex((l) => !isBarLine(l));
  return i < 0 ? null : i;
}

/** 칸에서 아직 쓰지 않은 첫 견본부터 선마다 차례로 색을 준다(frontend.md §3.3). */
export function pickColors(spec: IndicatorSpec, used: readonly IndicatorColor[]): IndicatorColor[] {
  const first = Math.max(0, INDICATOR_COLORS.findIndex((c) => !used.includes(c)));
  return specLines(spec).map((_, i) => INDICATOR_COLORS[(first + i) % INDICATOR_COLORS.length]!);
}

/** 선 i의 색. 저장된 색이 모자라면(선이 늘어난 설정) 그 종류의 기본 순서로 채운다. */
export function lineColor(colors: readonly IndicatorColor[], i: number): IndicatorColor {
  return colors[i] ?? INDICATOR_COLORS[((INDICATOR_COLORS.indexOf(colors[0] ?? "ind-1") + i) % INDICATOR_COLORS.length)]!;
}
