import type { FlowAggregation, FlowDisplayMode, FlowUnit, IndicatorKind, IndicatorSpec } from "./indicators/kinds";
import type { QuoteDepthSource } from "../api/generated/QuoteDepthSource";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { isHexColor, type HexColor } from "../lib/colors";
import { isIndicatorColor, type IndicatorColor, KINDS, type MicroLabelMode, type Placement, placementOf, placementsOf } from "./indicators/kinds";

export type ChartStyle = "candle" | "bar" | "line" | "area";
export type PriceScale = "normal" | "log" | "percent";
export type LineWidth = 1 | 2 | 3 | 4 | 5;
export type ExtremeBasis = "last" | "extreme";
export type IndicatorAxis = "auto" | "right" | "left" | "overlay";

export const MAX_INDICATORS_PER_PANEL = 4;
export const MERGED_PANEL_MIN_STRETCH = 0.34;

export interface IchimokuStyle {
  showCloud: boolean;
  showConversion: boolean;
  showBase: boolean;
  showSpanA: boolean;
  showSpanB: boolean;
  showLagging: boolean;
  cloudOpacity: number;
}

export const ICHIMOKU_CLOUD_OPACITY_MIN = 0.08;
export const ICHIMOKU_CLOUD_OPACITY_MAX = 0.35;
export const DEFAULT_ICHIMOKU_STYLE: IchimokuStyle = {
  showCloud: true,
  showConversion: true,
  showBase: true,
  showSpanA: true,
  showSpanB: true,
  showLagging: true,
  cloudOpacity: 0.18,
};

export interface IndicatorConfig {
  id: string;
  spec: IndicatorSpec;
  panel: "price" | Panel["id"];
  visible: boolean;
  style: { colors: IndicatorColor[]; width: LineWidth; barOpacity?: number; ichimoku?: IchimokuStyle };
  axis?: IndicatorAxis;
}

export const DEFAULT_BAR_OPACITY = 0.38;
export const DEFAULT_FLOW_BAR_OPACITY = 0.72;
export const BAR_OPACITY_MIN = 0.1;
export const BAR_OPACITY_MAX = 1;

export const defaultBarOpacity = (kind?: IndicatorKind): number =>
  kind === "foreignFlow" || kind === "institutionFlow" || kind === "programFlow"
    ? DEFAULT_FLOW_BAR_OPACITY
    : DEFAULT_BAR_OPACITY;

export const barOpacityOf = (style: IndicatorConfig["style"], kind?: IndicatorKind): number =>
  style.barOpacity ?? defaultBarOpacity(kind);
export const ichimokuStyleOf = (style: IndicatorConfig["style"]): IchimokuStyle => style.ichimoku ?? DEFAULT_ICHIMOKU_STYLE;
export function sameIchimokuStyle(a: IchimokuStyle, b: IchimokuStyle): boolean {
  return a === b || (
    a.showCloud === b.showCloud
    && a.showConversion === b.showConversion
    && a.showBase === b.showBase
    && a.showSpanA === b.showSpanA
    && a.showSpanB === b.showSpanB
    && a.showLagging === b.showLagging
    && a.cloudOpacity === b.cloudOpacity
  );
}
const isBarOpacity = (x: unknown): x is number => isNum(x) && x >= BAR_OPACITY_MIN && x <= BAR_OPACITY_MAX;
const isIchimokuCloudOpacity = (x: unknown): x is number => isNum(x) && x >= ICHIMOKU_CLOUD_OPACITY_MIN && x <= ICHIMOKU_CLOUD_OPACITY_MAX;

function readIchimokuStyle(raw: unknown): IchimokuStyle | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.showCloud !== "boolean"
    || typeof raw.showConversion !== "boolean"
    || typeof raw.showBase !== "boolean"
    || typeof raw.showSpanA !== "boolean"
    || typeof raw.showSpanB !== "boolean"
    || typeof raw.showLagging !== "boolean"
    || !isIchimokuCloudOpacity(raw.cloudOpacity)
  ) return null;
  return {
    showCloud: raw.showCloud,
    showConversion: raw.showConversion,
    showBase: raw.showBase,
    showSpanA: raw.showSpanA,
    showSpanB: raw.showSpanB,
    showLagging: raw.showLagging,
    cloudOpacity: raw.cloudOpacity,
  };
}

export const placementOfConfig = (config: Pick<IndicatorConfig, "panel">): Placement => config.panel === "price" ? "price" : "panel";

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
  visibleBars: number | null;
  showExtremes: boolean;
  showLegend: boolean;
  showOhlcChange: boolean;
  extremeBasis: ExtremeBasis;
  showDaySeparators: boolean;
  showHorzGrid: boolean;
  showVertGrid: boolean;
  regularHoursOnly: boolean;
  candlesOnTop: boolean;
  scalePriceOnly: boolean;
}

export const VISIBLE_BARS_MIN = 10;
export const VISIBLE_BARS_MAX = 2000;

const isVisibleBars = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= VISIBLE_BARS_MIN && x <= VISIBLE_BARS_MAX;

export function clampVisibleBars(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  return Math.min(VISIBLE_BARS_MAX, Math.max(VISIBLE_BARS_MIN, Math.round(n)));
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
  visibleBars: null,
  showExtremes: false,
  showLegend: true,
  showOhlcChange: false,
  extremeBasis: "last",
  showDaySeparators: false,
  showHorzGrid: true,
  showVertGrid: true,
  regularHoursOnly: false,
  candlesOnTop: false,
  scalePriceOnly: false,
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
const EXTREME_BASES = ["last", "extreme"] as const satisfies readonly ExtremeBasis[];
const INDICATOR_AXES = ["auto", "right", "left", "overlay"] as const satisfies readonly IndicatorAxis[];

const isOneOf = <T extends string | number>(xs: readonly T[], x: unknown): x is T => (xs as readonly unknown[]).includes(x);
const isEmptyArray = (x: unknown): x is never[] => Array.isArray(x) && x.length === 0;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isNumOrNull = (x: unknown): x is number | null => x === null || isNum(x);
const QUOTE_DEPTH_SOURCES = ["priceMax", "peak", "close"] as const satisfies readonly QuoteDepthSource[];
const MICRO_LABEL_MODES = ["clean", "verbose"] as const satisfies readonly MicroLabelMode[];
const FLOW_DISPLAY_MODES = ["histogram", "line", "both"] as const satisfies readonly FlowDisplayMode[];
const FLOW_AGGREGATIONS = ["bar", "cumulative"] as const satisfies readonly FlowAggregation[];
const FLOW_UNITS = ["eok", "shares"] as const satisfies readonly FlowUnit[];
const isOptionalBool = (x: unknown): x is boolean | undefined => x === undefined || typeof x === "boolean";
const isOptionalMicroMode = (x: unknown): x is MicroLabelMode | undefined => x === undefined || isOneOf(MICRO_LABEL_MODES, x);
const isTopLevels = (x: unknown): x is number | null => x === null || (typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= 5);
const isDepthOpacity = (x: unknown): x is number => isNum(x) && x >= 0.2 && x <= 1;
const isHexOrNull = (x: unknown): x is HexColor | null => x === null || isHexColor(x);

export function parseChartSettings(raw: unknown): ChartSettings {
  const parsed = readChartSettings(raw);
  if (parsed) return parsed;
  console.warn("chartSettings 모양이 틀려 기본 설정으로 엽니다", raw);
  return DEFAULT_CHART_SETTINGS;
}

function readChartSettings(raw: unknown): ChartSettings | null {
  if (!isRecord(raw)) return null;
  const {
    v, style, scale, indicators, compare, panels,
    visibleBars = DEFAULT_CHART_SETTINGS.visibleBars,
    showExtremes = DEFAULT_CHART_SETTINGS.showExtremes,
    showLegend = DEFAULT_CHART_SETTINGS.showLegend,
    showOhlcChange = DEFAULT_CHART_SETTINGS.showOhlcChange,
    extremeBasis = DEFAULT_CHART_SETTINGS.extremeBasis,
    showDaySeparators = DEFAULT_CHART_SETTINGS.showDaySeparators,
    showHorzGrid = DEFAULT_CHART_SETTINGS.showHorzGrid,
    showVertGrid = DEFAULT_CHART_SETTINGS.showVertGrid,
    regularHoursOnly = DEFAULT_CHART_SETTINGS.regularHoursOnly,
    candlesOnTop = DEFAULT_CHART_SETTINGS.candlesOnTop,
    scalePriceOnly = DEFAULT_CHART_SETTINGS.scalePriceOnly,
  } = raw;
  if (!isOneOf(CHART_STYLES, style) || !isOneOf(PRICE_SCALES, scale)) return null;
  if (!isCompareList(compare)) return null;
  if (!(visibleBars === null || isVisibleBars(visibleBars)) || typeof showExtremes !== "boolean") return null;
  if (typeof showLegend !== "boolean" || typeof showOhlcChange !== "boolean" || !isOneOf(EXTREME_BASES, extremeBasis)) return null;
  if (typeof showDaySeparators !== "boolean" || typeof showHorzGrid !== "boolean" || typeof showVertGrid !== "boolean" || typeof regularHoursOnly !== "boolean") return null;
  if (typeof candlesOnTop !== "boolean" || typeof scalePriceOnly !== "boolean") return null;
  const display = { showExtremes, showLegend, showOhlcChange, extremeBasis, showDaySeparators, showHorzGrid, showVertGrid, regularHoursOnly, candlesOnTop, scalePriceOnly };
  if (v === 1) return migrateV1({ style, scale, compare, visibleBars, ...display, indicators, panels });
  if (v !== 2 || !Array.isArray(indicators) || !Array.isArray(panels)) return null;
  const readPanels = panels.map(readPanel);
  const readIndicators = indicators.map(readIndicator);
  if (readPanels.includes(null) || readIndicators.includes(null)) return null;
  const settings: ChartSettings = { v: 2, style, scale, compare, panels: readPanels as Panel[], indicators: readIndicators as IndicatorConfig[], visibleBars, ...display };
  return panelsMatch(settings) ? settings : null;
}

type V1Kept = Pick<ChartSettings, "style" | "scale" | "compare" | "visibleBars" | "showExtremes" | "showLegend" | "showOhlcChange" | "extremeBasis" | "showDaySeparators" | "showHorzGrid" | "showVertGrid" | "regularHoursOnly" | "candlesOnTop" | "scalePriceOnly">;

function migrateV1({ indicators, panels, ...kept }: V1Kept & { indicators: unknown; panels: unknown }): ChartSettings | null {
  if (!isEmptyArray(indicators) || !isEmptyArray(panels)) return null;
  return { ...DEFAULT_CHART_SETTINGS, ...kept };
}

function readPanel(raw: unknown): Panel | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !isNum(raw.stretch)) return null;
  if (raw.collapsed !== undefined && typeof raw.collapsed !== "boolean") return null;
  return { id: raw.id, stretch: raw.stretch > 0 ? raw.stretch : DEFAULT_PANEL_STRETCH, ...(raw.collapsed === undefined ? {} : { collapsed: raw.collapsed }) };
}

function readIndicator(raw: unknown): IndicatorConfig | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.panel !== "string" || typeof raw.visible !== "boolean") return null;
  const spec = readSpecShape(raw.spec);
  const style = raw.style;
  if (!spec || !isRecord(style) || !isOneOf(WIDTHS, style.width)) return null;
  const colors = style.colors;
  if (!Array.isArray(colors) || !colors.every(isIndicatorColor)) return null;
  const barOpacity = style.barOpacity;
  if (barOpacity !== undefined && !isBarOpacity(barOpacity)) return null;
  const ichimoku = style.ichimoku === undefined ? undefined : readIchimokuStyle(style.ichimoku);
  if (style.ichimoku !== undefined && ichimoku === null) return null;
  const axis = raw.axis;
  if (axis !== undefined && !isOneOf(INDICATOR_AXES, axis)) return null;
  return {
    id: raw.id,
    spec,
    panel: raw.panel,
    visible: raw.visible,
    style: {
      colors,
      width: style.width,
      ...(barOpacity === undefined ? {} : { barOpacity }),
      ...(ichimoku === undefined || ichimoku === null ? {} : { ichimoku }),
    },
    ...(axis === undefined || axis === "auto" ? {} : { axis }),
  };
}

export function readSpecShape(raw: unknown): IndicatorSpec | null {
  if (!isRecord(raw) || typeof raw.kind !== "string" || !(raw.kind in KINDS)) return null;
  const r = raw;
  switch (raw.kind) {
    case "quoteTotals":
    case "revenue":
    case "operating_income":
    case "owner_roe":
    case "investing_cash_flow":
    case "dps":
    case "debt_ratio":
      return { kind: raw.kind };
    case "quoteDepth":
      return isOneOf(QUOTE_DEPTH_SOURCES, r.source)
        && isTopLevels(r.topLevels)
        && isDepthOpacity(r.maxOpacity)
        && typeof r.aboveBars === "boolean"
        && isHexOrNull(r.askColor)
        && isHexOrNull(r.bidColor)
        && isOptionalBool(r.showSpoof)
        && isOptionalBool(r.showIceberg)
        && isOptionalMicroMode(r.microLabelMode)
        && isOptionalBool(r.dynamicContrast)
        ? {
            kind: "quoteDepth",
            source: r.source,
            topLevels: r.topLevels,
            maxOpacity: r.maxOpacity,
            aboveBars: r.aboveBars,
            askColor: r.askColor,
            bidColor: r.bidColor,
            ...(r.showSpoof !== undefined ? { showSpoof: r.showSpoof } : {}),
            ...(r.showIceberg !== undefined ? { showIceberg: r.showIceberg } : {}),
            ...(r.microLabelMode !== undefined ? { microLabelMode: r.microLabelMode } : {}),
            ...(r.dynamicContrast !== undefined ? { dynamicContrast: r.dynamicContrast } : {}),
          }
        : null;
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
    case "tickCvd":
      return typeof r.showWhale === "boolean"
        && typeof r.showLarge === "boolean"
        && typeof r.showMid === "boolean"
        && typeof r.showRetail === "boolean"
        ? { kind: "tickCvd", showWhale: r.showWhale, showLarge: r.showLarge, showMid: r.showMid, showRetail: r.showRetail }
        : null;
    case "anchoredVwap":
      return (r.priceSource === "hlc3" || r.priceSource === "close")
        && typeof r.showBands === "boolean"
        && (r.anchorPreset === "open" || r.anchorPreset === "low" || r.anchorPreset === "high" || r.anchorPreset === "vi" || r.anchorPreset === "custom")
        && (r.anchorTime === null || isNum(r.anchorTime))
        ? { kind: "anchoredVwap", priceSource: r.priceSource, showBands: r.showBands, anchorPreset: r.anchorPreset, anchorTime: r.anchorTime }
        : null;
    case "volumeProfile":
      return (r.mode === "vrvp" || r.mode === "session")
        && isNum(r.bins)
        && typeof r.showDelta === "boolean"
        && isNum(r.valueAreaPct)
        ? { kind: "volumeProfile", mode: r.mode, bins: r.bins, showDelta: r.showDelta, valueAreaPct: r.valueAreaPct }
        : null;
    case "tapeVelocity":
      return (r.metric === "tps" || r.metric === "turnover" || r.metric === "buyRatio")
        && typeof r.showStrength === "boolean"
        ? { kind: "tapeVelocity", metric: r.metric, showStrength: r.showStrength }
        : null;
    case "foreignBrokerFlow":
      return (r.source === "auto" || r.source === "fid261" || r.source === "top5")
        && isOneOf(FLOW_DISPLAY_MODES, r.displayMode)
        ? { kind: "foreignBrokerFlow", source: r.source, displayMode: r.displayMode }
        : null;
    case "foreignFlow":
    case "institutionFlow":
      return isOneOf(FLOW_DISPLAY_MODES, r.displayMode)
        && isOneOf(FLOW_AGGREGATIONS, r.aggregation)
        && isOneOf(FLOW_UNITS, r.unit)
        ? { kind: raw.kind, displayMode: r.displayMode, aggregation: r.aggregation, unit: r.unit }
        : null;
    case "programFlow":
      if (typeof r.showShare !== "boolean") return null;
      if (r.displayMode === undefined && r.aggregation === undefined && r.unit === undefined) {
        return { kind: "programFlow", displayMode: "line", aggregation: "cumulative", unit: "eok", showShare: r.showShare };
      }
      return isOneOf(FLOW_DISPLAY_MODES, r.displayMode)
        && isOneOf(FLOW_AGGREGATIONS, r.aggregation)
        && isOneOf(FLOW_UNITS, r.unit)
        ? { kind: "programFlow", displayMode: r.displayMode, aggregation: r.aggregation, unit: r.unit, showShare: r.showShare }
        : null;
    default:
      return null;
  }
}

const allDistinct = (xs: readonly string[]) => new Set(xs).size === xs.length;

const isCompareList = (x: unknown): x is SymbolCode[] =>
  Array.isArray(x) && x.length <= MAX_COMPARE && x.every((c) => typeof c === "string") && allDistinct(x);

function panelsMatch(s: Pick<ChartSettings, "indicators" | "panels">): boolean {
  const panelIds = s.panels.map((p) => p.id);
  const panelSet = new Set(panelIds);
  const panelOwners = s.indicators.filter((i) => placementOfConfig(i) === "panel").map((i) => i.panel);
  const ownerSet = new Set(panelOwners);
  const eachOnItsPane = s.indicators.every((i) => placementsOf(i.spec.kind).includes(placementOfConfig(i)));
  const atLeastOnePerPanel = panelOwners.every((id) => panelSet.has(id)) && panelIds.every((id) => ownerSet.has(id));
  return allDistinct(panelIds) && allDistinct(s.indicators.map((i) => i.id)) && eachOnItsPane && atLeastOnePerPanel;
}

const newId = () => crypto.randomUUID();

export function addIndicator(
  s: ChartSettings,
  spec: IndicatorSpec,
  style: IndicatorConfig["style"],
  makeId: () => string = newId,
  placement: Placement = placementOf(spec),
): { settings: ChartSettings; id: string } {
  const id = makeId();
  if ((placementsOf(spec.kind).includes(placement) ? placement : placementOf(spec)) === "price") {
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

function withoutAxis(config: IndicatorConfig): IndicatorConfig {
  if (config.axis === undefined) return config;
  const { axis: _removed, ...rest } = config;
  return rest;
}

function prunePanels(panels: readonly Panel[], indicators: readonly IndicatorConfig[]): Panel[] {
  return panels.filter((p) => indicators.some((i) => i.panel === p.id));
}

export function setIndicatorPlacement(s: ChartSettings, id: string, placement: Placement, panel: Panel = { id: newId(), stretch: DEFAULT_PANEL_STRETCH }, at = 0): ChartSettings {
  const config = s.indicators.find((i) => i.id === id);
  if (!config || placementOfConfig(config) === placement || !placementsOf(config.spec.kind).includes(placement)) return s;
  const indicators = s.indicators.map((i) => (i === config ? withoutAxis({ ...i, panel: placement === "price" ? "price" : panel.id }) : i));
  const panels = placement === "price"
    ? prunePanels(s.panels, indicators)
    : s.panels.some((p) => p.id === panel.id)
      ? s.panels
      : [...s.panels.slice(0, at), panel, ...s.panels.slice(at)];
  return { ...s, indicators, panels };
}

export function removeIndicator(s: ChartSettings, id: string): ChartSettings {
  const gone = s.indicators.find((i) => i.id === id);
  if (!gone) return s;
  const indicators = s.indicators.filter((i) => i !== gone);
  return { ...s, indicators, panels: prunePanels(s.panels, indicators) };
}

export function movePanel(s: ChartSettings, panelId: string, step: -1 | 1): ChartSettings {
  const from = s.panels.findIndex((p) => p.id === panelId);
  const to = from + step;
  if (from < 0 || to < 0 || to >= s.panels.length) return s;
  const panels = [...s.panels];
  [panels[from], panels[to]] = [panels[to]!, panels[from]!];
  return { ...s, panels };
}

export function reorderPanel(s: ChartSettings, panelId: string, insertAt: number): ChartSettings {
  const from = s.panels.findIndex((p) => p.id === panelId);
  if (from < 0) return s;
  const clamped = Math.max(0, Math.min(s.panels.length, insertAt));
  if (clamped === from || clamped === from + 1) return s;
  const panels = [...s.panels];
  const [moved] = panels.splice(from, 1);
  const to = clamped > from ? clamped - 1 : clamped;
  panels.splice(to, 0, moved!);
  return { ...s, panels };
}

export function mergeIndicatorIntoPanel(s: ChartSettings, indicatorId: string, targetPanelId: "price" | Panel["id"]): ChartSettings {
  const config = s.indicators.find((i) => i.id === indicatorId);
  if (!config || config.panel === targetPanelId) return s;
  if (targetPanelId === "price") return setIndicatorPlacement(s, indicatorId, "price");
  if (!placementsOf(config.spec.kind).includes("panel")) return s;
  if (!s.panels.some((p) => p.id === targetPanelId)) return s;
  const targetMembers = s.indicators.filter((i) => i.panel === targetPanelId);
  if (targetMembers.length >= MAX_INDICATORS_PER_PANEL) return s;
  const moved = withoutAxis({ ...config, panel: targetPanelId });
  const withoutMoved = s.indicators.filter((i) => i !== config);
  let lastTargetIndex = -1;
  for (let i = 0; i < withoutMoved.length; i++) {
    if (withoutMoved[i]!.panel === targetPanelId) lastTargetIndex = i;
  }
  const indicators = lastTargetIndex < 0
    ? [...withoutMoved, moved]
    : [...withoutMoved.slice(0, lastTargetIndex + 1), moved, ...withoutMoved.slice(lastTargetIndex + 1)];
  const panels = prunePanels(s.panels, indicators).map((p) => {
    if (p.id !== targetPanelId) return p;
    const stretch = p.stretch < MERGED_PANEL_MIN_STRETCH ? MERGED_PANEL_MIN_STRETCH : p.stretch;
    const next: Panel = { id: p.id, stretch };
    return next;
  });
  return { ...s, indicators, panels };
}

export function splitIndicatorToNewPanel(
  s: ChartSettings,
  indicatorId: string,
  insertAt: number,
  makeId: () => string = newId,
): ChartSettings {
  const config = s.indicators.find((i) => i.id === indicatorId);
  if (!config || !placementsOf(config.spec.kind).includes("panel")) return s;
  if (config.panel !== "price") {
    const siblings = s.indicators.filter((i) => i.panel === config.panel);
    if (siblings.length === 1) return reorderPanel(s, config.panel, insertAt);
  }
  const panelId = makeId();
  const clamped = Math.max(0, Math.min(s.panels.length, insertAt));
  const indicators = s.indicators.map((i) => (i === config ? withoutAxis({ ...i, panel: panelId }) : i));
  const panels = [...s.panels.slice(0, clamped), { id: panelId, stretch: DEFAULT_PANEL_STRETCH }, ...s.panels.slice(clamped)];
  return { ...s, indicators, panels };
}

export function setIndicatorAxis(s: ChartSettings, indicatorId: string, axis: IndicatorAxis): ChartSettings {
  const config = s.indicators.find((i) => i.id === indicatorId);
  if (!config || config.panel === "price") return s;
  const nextAxis = axis === "auto" ? undefined : axis;
  if (config.axis === nextAxis) return s;
  const indicators = s.indicators.map((i) => {
    if (i !== config) return i;
    return nextAxis === undefined ? withoutAxis(i) : { ...i, axis: nextAxis };
  });
  return { ...s, indicators };
}

export function togglePanel(s: ChartSettings, panelId: string): ChartSettings {
  return { ...s, panels: s.panels.map((p) => p.id === panelId ? { ...p, collapsed: !p.collapsed } : p) };
}

export function setPanelStretches(s: ChartSettings, stretches: readonly Panel["stretch"][]): ChartSettings {
  if (stretches.length !== s.panels.length || stretches.some((x) => !(Number.isFinite(x) && x > 0))) return s;
  if (stretches.every((x, i) => Math.abs(x - s.panels[i]!.stretch) < 1e-3)) return s;
  return { ...s, panels: s.panels.map((p, i) => ({ ...p, stretch: stretches[i]! })) };
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
