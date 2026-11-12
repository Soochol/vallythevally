import type { IndicatorSpec } from "./indicators/kinds";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { isIndicatorColor, type IndicatorColor, KINDS, placementOf } from "./indicators/kinds";

export type ChartStyle = "candle" | "bar" | "line" | "area";
export type PriceScale = "normal" | "log" | "percent";
export type LineWidth = 1 | 2 | 3 | 4 | 5;

export interface IndicatorConfig {
  id: string;
  spec: IndicatorSpec;
  panel: "price" | Panel["id"];
  visible: boolean;
  style: { colors: IndicatorColor[]; width: LineWidth };
}

export interface Panel {
  id: string;
  /** 가격 패널(1) 대비 높이 비율. */
  stretch: number;
  collapsed?: boolean;
}

/** 칸의 차트 설정(frontend.md §5.5). */
export interface ChartSettings {
  v: 2;
  style: ChartStyle;
  scale: PriceScale;
  indicators: IndicatorConfig[];
  compare: SymbolCode[];
  panels: Panel[];
}

export const DEFAULT_PANEL_STRETCH = 0.25;
export const MAX_COMPARE = 3;

const DEFAULT_VOLUME_ID = "01900000-0000-7000-8000-00000000a001";
const DEFAULT_VOLUME_PANEL = "01900000-0000-7000-8000-00000000b001";

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  v: 2,
  style: "candle",
  scale: "normal",
  indicators: [
    {
      id: DEFAULT_VOLUME_ID,
      spec: { kind: "volume", maPeriod: null },
      panel: DEFAULT_VOLUME_PANEL,
      visible: true,
      style: { colors: ["ind-1"], width: 1 },
    },
  ],
  compare: [],
  panels: [{ id: DEFAULT_VOLUME_PANEL, stretch: DEFAULT_PANEL_STRETCH }],
};

export const CHART_STYLE_LABEL: Record<ChartStyle, string> = {
  candle: "캔들",
  bar: "바",
  line: "라인",
  area: "영역",
};

const CHART_STYLES = ["candle", "bar", "line", "area"] as const satisfies readonly ChartStyle[];
const PRICE_SCALES = ["normal", "log", "percent"] as const satisfies readonly PriceScale[];
const WIDTHS = [1, 2, 3, 4, 5] as const satisfies readonly LineWidth[];

const isOneOf = <T extends string | number>(xs: readonly T[], x: unknown): x is T => (xs as readonly unknown[]).includes(x);
const isEmptyArray = (x: unknown): x is never[] => Array.isArray(x) && x.length === 0;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isNumOrNull = (x: unknown): x is number | null => x === null || isNum(x);

export function parseChartSettings(raw: unknown): ChartSettings {
  const parsed = readChartSettings(raw);
  if (parsed) return parsed;
  console.warn("chartSettings 모양이 틀려 기본 설정으로 엽니다", raw);
  return DEFAULT_CHART_SETTINGS;
}

function readChartSettings(raw: unknown): ChartSettings | null {
  if (!isRecord(raw)) return null;
  const { v, style, scale, indicators, compare, panels } = raw;
  if (!isOneOf(CHART_STYLES, style) || !isOneOf(PRICE_SCALES, scale)) return null;
  if (!isCompareList(compare)) return null;
  if (v === 1) return migrateV1({ style, scale, compare, indicators, panels });
  if (v !== 2 || !Array.isArray(indicators) || !Array.isArray(panels)) return null;
  const readPanels = panels.map(readPanel);
  const readIndicators = indicators.map(readIndicator);
  if (readPanels.includes(null) || readIndicators.includes(null)) return null;
  const settings: ChartSettings = { v: 2, style, scale, compare, panels: readPanels as Panel[], indicators: readIndicators as IndicatorConfig[] };
  return panelsMatch(settings) ? settings : null;
}

function migrateV1(v1: Pick<ChartSettings, "style" | "scale" | "compare"> & { indicators: unknown; panels: unknown }): ChartSettings | null {
  if (!isEmptyArray(v1.indicators) || !isEmptyArray(v1.panels)) return null;
  return { ...DEFAULT_CHART_SETTINGS, style: v1.style, scale: v1.scale, compare: v1.compare };
}

function readPanel(raw: unknown): Panel | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !isNum(raw.stretch) || raw.stretch <= 0) return null;
  if (raw.collapsed !== undefined && typeof raw.collapsed !== "boolean") return null;
  return { id: raw.id, stretch: raw.stretch, ...(raw.collapsed === undefined ? {} : { collapsed: raw.collapsed }) };
}

function readIndicator(raw: unknown): IndicatorConfig | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.panel !== "string" || typeof raw.visible !== "boolean") return null;
  const spec = readSpecShape(raw.spec);
  const style = raw.style;
  if (!spec || !isRecord(style) || !isOneOf(WIDTHS, style.width)) return null;
  const colors = style.colors;
  if (!Array.isArray(colors) || !colors.every(isIndicatorColor)) return null;
  return { id: raw.id, spec, panel: raw.panel, visible: raw.visible, style: { colors, width: style.width } };
}

export function readSpecShape(raw: unknown): IndicatorSpec | null {
  if (!isRecord(raw) || typeof raw.kind !== "string" || !(raw.kind in KINDS)) return null;
  const r = raw;
  switch (raw.kind) {
    case "revenue":
    case "operating_income":
    case "owner_roe":
    case "investing_cash_flow":
    case "dps":
    case "debt_ratio":
      return { kind: raw.kind };
    case "ma":
      return (r.method === "sma" || r.method === "ema") && isNum(r.period) ? { kind: "ma", method: r.method, period: r.period } : null;
    case "bollinger":
      return isNum(r.period) && isNum(r.k) ? { kind: "bollinger", period: r.period, k: r.k } : null;
    case "ichimoku":
      return isNum(r.conversion) && isNum(r.base) && isNum(r.spanB) && isNum(r.displacement)
        ? { kind: "ichimoku", conversion: r.conversion, base: r.base, spanB: r.spanB, displacement: r.displacement }
        : null;
    case "volume":
      return isNumOrNull(r.maPeriod) ? { kind: "volume", maPeriod: r.maPeriod } : null;
    case "rsi":
      return isNum(r.period) && isNumOrNull(r.signal) ? { kind: "rsi", period: r.period, signal: r.signal } : null;
    case "macd":
      return isNum(r.fast) && isNum(r.slow) && isNum(r.signal) ? { kind: "macd", fast: r.fast, slow: r.slow, signal: r.signal } : null;
    case "stochSlow":
      return isNum(r.k) && isNum(r.d) && isNum(r.smooth) ? { kind: "stochSlow", k: r.k, d: r.d, smooth: r.smooth } : null;
    default:
      return null;
  }
}

const allDistinct = (xs: readonly string[]) => new Set(xs).size === xs.length;

const isCompareList = (x: unknown): x is SymbolCode[] =>
  Array.isArray(x) && x.length <= MAX_COMPARE && x.every((c) => typeof c === "string") && allDistinct(x);

function panelsMatch(s: Pick<ChartSettings, "indicators" | "panels">): boolean {
  const panelIds = s.panels.map((p) => p.id);
  const panelOwners = s.indicators.filter((i) => placementOf(i.spec) === "panel").map((i) => i.panel);
  const eachOnItsPane = s.indicators.every((i) => (placementOf(i.spec) === "price") === (i.panel === "price"));
  const onePerPanel = panelOwners.length === panelIds.length && allDistinct(panelOwners) && panelOwners.every((id) => panelIds.includes(id));
  return allDistinct(panelIds) && allDistinct(s.indicators.map((i) => i.id)) && eachOnItsPane && onePerPanel;
}

const newId = () => crypto.randomUUID();

export function addIndicator(
  s: ChartSettings,
  spec: IndicatorSpec,
  style: IndicatorConfig["style"],
  makeId: () => string = newId,
): { settings: ChartSettings; id: string } {
  const id = makeId();
  if (placementOf(spec) === "price") {
    return { id, settings: { ...s, indicators: [...s.indicators, { id, spec, panel: "price", visible: true, style }] } };
  }
  const panel = makeId();
  return {
    id,
    settings: {
      ...s,
      indicators: [...s.indicators, { id, spec, panel, visible: true, style }],
      panels: [...s.panels, { id: panel, stretch: DEFAULT_PANEL_STRETCH }],
    },
  };
}

/** 같은 종류 안에서만 바꾼다. 놓인 패널은 그대로다. */
export function updateIndicator(s: ChartSettings, id: string, patch: Partial<Pick<IndicatorConfig, "spec" | "style" | "visible">>): ChartSettings {
  const indicators = s.indicators.map((i) => (i.id === id && (!patch.spec || patch.spec.kind === i.spec.kind) ? { ...i, ...patch } : i));
  return indicators.every((i, n) => i === s.indicators[n]) ? s : { ...s, indicators };
}

export function removeIndicator(s: ChartSettings, id: string): ChartSettings {
  const gone = s.indicators.find((i) => i.id === id);
  if (!gone) return s;
  return { ...s, indicators: s.indicators.filter((i) => i !== gone), panels: s.panels.filter((p) => p.id !== gone.panel) };
}

export function movePanel(s: ChartSettings, panelId: string, step: -1 | 1): ChartSettings {
  const from = s.panels.findIndex((p) => p.id === panelId);
  const to = from + step;
  if (from < 0 || to < 0 || to >= s.panels.length) return s;
  const panels = [...s.panels];
  [panels[from], panels[to]] = [panels[to]!, panels[from]!];
  return { ...s, panels };
}

export function togglePanel(s: ChartSettings, panelId: string): ChartSettings {
  return { ...s, panels: s.panels.map((p) => p.id === panelId ? { ...p, collapsed: !p.collapsed } : p) };
}

export function setPanelStretches(s: ChartSettings, stretches: readonly Panel["stretch"][]): ChartSettings {
  if (stretches.length !== s.panels.length || stretches.some((x) => !(Number.isFinite(x) && x > 0))) return s;
  if (stretches.every((x, i) => Math.abs(x - s.panels[i]!.stretch) < 1e-3)) return s;
  return { ...s, panels: s.panels.map((p, i) => ({ ...p, stretch: Math.round(stretches[i]! * 1000) / 1000 })) };
}

export function shownScale(s: Pick<ChartSettings, "scale" | "compare">): PriceScale {
  return s.compare.length > 0 ? "percent" : s.scale;
}

export type CompareRefusal = "full" | "dup" | "main";

export function compareRefusal(s: Pick<ChartSettings, "compare">, code: SymbolCode, main: SymbolCode): CompareRefusal | null {
  if (code === main) return "main";
  if (s.compare.includes(code)) return "dup";
  if (s.compare.length >= MAX_COMPARE) return "full";
  return null;
}

export function addCompare(s: ChartSettings, code: SymbolCode, main: SymbolCode): ChartSettings {
  return compareRefusal(s, code, main) ? s : { ...s, compare: [...s.compare, code] };
}

export function removeCompare(s: ChartSettings, code: SymbolCode): ChartSettings {
  return s.compare.includes(code) ? { ...s, compare: s.compare.filter((c) => c !== code) } : s;
}
