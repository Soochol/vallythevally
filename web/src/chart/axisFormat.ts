import type { PriceFormatCustom } from "lightweight-charts";
import type { FinancialMetric } from "../api/generated/FinancialMetric";
import { MINUS } from "../lib/format";

export type AxisUnit = "price" | "index" | "volume" | "KRW" | "%" | "원/주" | { currency: string };
export interface AxisGeometry {
  toCoordinate(value: number): number | null;
  lastCoordinates(): number[];
  fontSize?(): number;
  width?(): number;
  formatted?(): void;
  failed?(error: unknown): void;
}

const KOREAN = [[1e12, "조"], [1e8, "억"], [1e4, "만"]] as const;
const INTERNATIONAL = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const;
const VOLUME_SCALES = [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const;
const MAN = 1e4;
const groupedUnit = (unit: AxisUnit) => unit === "price" || unit === "index";
const volumeScale = (v: number) => VOLUME_SCALES.find(([scale]) => v >= scale);
const numberFormats = new Map<number, Intl.NumberFormat>();
function numberText(value: number, digits: number, grouped: boolean): string {
  const key = digits + (grouped ? 100 : 0);
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat("en-US", { useGrouping: grouped, maximumFractionDigits: digits });
    numberFormats.set(key, format);
  }
  return format.format(value);
}
const decimal = (v: number, digits: number) => numberText(v, digits, false);
const PRECISIONS = [undefined, ...Array.from({ length: 13 }, (_, i) => i)];
const suffix = (unit: AxisUnit) => typeof unit === "object" ? unit.currency : unit === "%" || unit === "원/주" ? unit : "";
const signed = (value: number, text: string) => `${value < 0 ? MINUS : ""}${text}`;
const scientific = (value: number, digits: number) => signed(value, Math.abs(value).toExponential(digits).replace("e+", "e"));

export function financialAxisUnit(metric: FinancialMetric, currency: string | null): AxisUnit {
  if (metric === "owner_roe" || metric === "debt_ratio") return "%";
  if (metric === "dps") return "원/주";
  return currency === "KRW" ? "KRW" : { currency: currency ?? "?" };
}

export function formatAxisValue(value: number, unit: AxisUnit, precision?: number): string {
  if (!Number.isFinite(value)) return "—";
  const v = Math.abs(value);
  if (groupedUnit(unit)) return signed(value, numberText(v, precision ?? (unit === "price" ? 0 : 2), true));
  if (unit === "volume") return volumeLabel(value, volumeScale(v), precision ?? (v >= 1e3 ? 2 : 0));
  const compact = (unit === "KRW" ? KOREAN : INTERNATIONAL).find(([scale]) => v >= scale);
  if (compact) {
    const [scale, label] = compact;
    const digits = precision ?? (label === "조" ? 1 : label === "만" ? 0 : 2);
    return signed(value, `${decimal(v / scale, digits)}${label}${suffix(unit)}`);
  }
  return signed(value, numberText(v, precision ?? 2, true) + suffix(unit));
}

function volumeLabel(value: number, scale: (typeof VOLUME_SCALES)[number] | undefined, digits: number): string {
  if (!Number.isFinite(value)) return "—";
  const v = Math.abs(value);
  if (v === 0) return "0";
  return signed(value, scale ? `${decimal(v / scale[0], digits)}${scale[1]}` : numberText(v, digits, true));
}

function commonVolumeTicks(values: number[], fits: (text: string) => boolean): string[] | null {
  const scale = volumeScale(Math.max(0, ...values.filter(Number.isFinite).map(Math.abs)));
  for (let digits = 0; digits <= 6; digits++) {
    const labels = values.map((value) => volumeLabel(value, scale, digits));
    if (labels.every(fits) && new Set(labels).size === values.length) return labels;
  }
  return null;
}

type TickNotation = "compact" | "man" | "international" | "plain" | "scientific";
function tickValue(value: number, unit: AxisUnit, precision: number | undefined, notation: TickNotation): string {
  if (!Number.isFinite(value)) return "—";
  if (notation === "compact") return formatAxisValue(value, unit, precision);
  if (notation === "man") return Math.abs(value) < MAN ? formatAxisValue(value, unit, precision) : signed(value, `${numberText(Math.abs(value) / MAN, precision ?? 0, true)}만${suffix(unit)}`);
  if (notation === "plain") return signed(value, decimal(Math.abs(value), precision ?? 2) + suffix(unit));
  if (notation === "scientific") return scientific(value, precision ?? 2) + suffix(unit);
  const compact = INTERNATIONAL.find(([scale]) => Math.abs(value) >= scale);
  return compact ? signed(value, `${decimal(Math.abs(value) / compact[0], precision ?? 2)}${compact[1]}${suffix(unit)}`) : tickValue(value, unit, precision, "plain");
}

const candidateNotations = (unit: AxisUnit): TickNotation[] =>
  groupedUnit(unit) ? ["compact", "man", "plain", "scientific"] : unit === "volume" ? ["compact", "plain", "scientific"] : ["compact", "plain", "international", "scientific"];
const distinctNotations = (unit: AxisUnit): TickNotation[] =>
  groupedUnit(unit) ? ["compact", "man", "plain", "scientific"] : unit === "volume" ? ["compact", "plain", "scientific"] : ["compact", "international", "plain", "scientific"];

function* axisCandidates(value: number, unit: AxisUnit): Generator<string> {
  yield formatAxisValue(value, unit);
  for (const notation of candidateNotations(unit)) {
    for (let precision = 2; precision >= 0; precision--) yield tickValue(value, unit, precision, notation);
  }
  if (unit === "원/주" && Math.abs(value) >= 100 && Math.abs(value) < 1000) {
    yield signed(value, `${decimal(Math.abs(value) / 100, 0)}백원/주`);
  }
}

export function fitAxisValue(value: number, unit: AxisUnit, fits: (text: string) => boolean): string {
  for (const candidate of axisCandidates(value, unit)) if (fits(candidate)) return candidate;
  return scientific(value, 0);
}

export function distinctAxisTicks(values: number[], unit: AxisUnit, fits: (text: string) => boolean): string[] {
  if (unit === "volume") {
    const common = commonVolumeTicks(values, fits);
    if (common) return common;
  }
  const defaults = values.map((value) => formatAxisValue(value, unit));
  let best = defaults.every(fits) ? defaults : null;
  let distinct = best ? new Set(best).size : 0;
  if (distinct === values.length) return defaults;
  for (const notation of distinctNotations(unit)) {
    for (const precision of PRECISIONS) {
      if (notation === "compact" && precision === undefined) continue;
      const labels = values.map((value) => tickValue(value, unit, precision, notation));
      if (!labels.every(fits)) continue;
      const count = new Set(labels).size;
      if (count === values.length) return labels;
      if (count > distinct) { best = labels; distinct = count; }
    }
  }
  const fallback = values.map((value) => fitAxisValue(value, unit, fits));
  if (!best || new Set(fallback).size > distinct) best = fallback;
  const seen = new Set<string>();
  return best.map((label) => { if (seen.has(label)) return ""; seen.add(label); return label; });
}

export function formatAxisTicks(values: number[], labels: string[], geometry: AxisGeometry | undefined, fontSize: number): string[] {
  if (!geometry) return labels;
  const last = geometry.lastCoordinates().filter(Number.isFinite);
  if (last.length === 0) return labels;
  const distances = values.map((value) => {
    const y = geometry.toCoordinate(value);
    return y === null ? Infinity : Math.min(...last.map((coordinate) => Math.abs(y - coordinate)));
  });
  const clearance = fontSize * (1 + 5 / 24) + 2;
  const result = labels.map((label, i) => distances[i]! < clearance ? "" : label);
  if (result.some(Boolean)) return result;
  const farthest = labels.reduce((best, label, i) => label && (best < 0 || distances[i]! > distances[best]!) ? i : best, -1);
  if (farthest >= 0) result[farthest] = labels[farthest]!;
  return result;
}

export const AXIS_WIDTH_STEPS = [72, 80, 88] as const;
export const AXIS_WIDTH = AXIS_WIDTH_STEPS[0];
const axisBudget = (fontSize: number, width: number) => width - (11 + fontSize * 5 / 6);

let measureContext: CanvasRenderingContext2D | null | undefined;
let measureFont = "";
let styleKey: string | null = null;
let cachedFamily = "sans-serif";
let cachedBaseSize = 11;
const measuredWidths = new Map<string, number>();

export function invalidateAxisMeasureCache(): void {
  measureFont = "";
  styleKey = null;
  measuredWidths.clear();
}

export function resetAxisMeasureCache(): void {
  measureContext = undefined;
  invalidateAxisMeasureCache();
}

function attachedMeasureContext(): CanvasRenderingContext2D | null {
  if (measureContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.hidden = true;
    canvas.setAttribute("aria-hidden", "true");
    document.body.append(canvas);
    measureContext = canvas.getContext("2d");
  }
  return measureContext;
}

function refreshAxisStyle(): void {
  const root = document.documentElement;
  const key = `${root.dataset.theme ?? ""}:${root.dataset.density ?? ""}`;
  if (key === styleKey) return;
  styleKey = key;
  const styles = getComputedStyle(root);
  const nextFamily = styles.getPropertyValue("--font-sans") || "sans-serif";
  const nextBaseSize = Number.parseFloat(styles.getPropertyValue("--fs-xs")) || 11;
  if (nextFamily !== cachedFamily || nextBaseSize !== cachedBaseSize) {
    cachedFamily = nextFamily;
    cachedBaseSize = nextBaseSize;
    measureFont = "";
    measuredWidths.clear();
  }
}

function axisMeasurer(): { baseSize(): number; widthAt(text: string, fontSize: number): number } | null {
  if (typeof document === "undefined" || !attachedMeasureContext()) return null;
  return {
    baseSize() {
      refreshAxisStyle();
      return cachedBaseSize;
    },
    widthAt(text, fontSize) {
      const context = attachedMeasureContext();
      if (!context) return 0;
      refreshAxisStyle();
      const normalized = text.replace(/[1-9]/g, "0");
      const key = `${fontSize}\0${normalized}`;
      const hit = measuredWidths.get(key);
      if (hit !== undefined) return hit;
      const font = `${fontSize}px ${cachedFamily}`;
      if (measureFont !== font) {
        context.font = font;
        measureFont = font;
      }
      const width = context.measureText(normalized).width;
      if (measuredWidths.size >= 512) measuredWidths.clear();
      measuredWidths.set(key, width);
      return width;
    },
  };
}

export function priceAxisWidth(maxPrice: number, fontSize: number): number {
  const measurer = axisMeasurer();
  if (!measurer || !Number.isFinite(maxPrice)) return AXIS_WIDTH;
  const widest = numberText(Math.ceil(Math.abs(maxPrice)), 0, true);
  const textWidth = measurer.widthAt(widest, fontSize);
  return AXIS_WIDTH_STEPS.find((width) => textWidth <= axisBudget(fontSize, width)) ?? AXIS_WIDTH_STEPS[AXIS_WIDTH_STEPS.length - 1]!;
}

export function axisPriceFormat(unit: AxisUnit, minMove: number, geometry?: AxisGeometry) {
  const measurer = axisMeasurer();
  const fontSize = () => geometry?.fontSize?.() ?? measurer?.baseSize() ?? 11;
  const fits = (text: string) => {
    const size = fontSize();
    return !measurer || measurer.widthAt(text, size) <= axisBudget(size, geometry?.width?.() ?? AXIS_WIDTH);
  };
  return {
    type: "custom", minMove,
    formatter: (value: number) => fitAxisValue(value, unit, fits),
    tickmarksFormatter: (values: number[]) => {
      let labels = distinctAxisTicks(values, unit, fits);
      try {
        labels = formatAxisTicks(values, labels, geometry, fontSize());
      } catch (error) {
        if (geometry?.failed) geometry.failed(error);
        else console.error("Axis label collision check failed", error);
      }
      geometry?.formatted?.();
      return labels;
    },
  } satisfies PriceFormatCustom;
}
