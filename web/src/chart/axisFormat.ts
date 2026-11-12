import type { PriceFormatCustom } from "lightweight-charts";
import type { FinancialMetric } from "../api/generated/FinancialMetric";
import { MINUS } from "../lib/format";

export type AxisUnit = "price" | "index" | "volume" | "KRW" | "%" | "원/주" | { currency: string };
export interface AxisGeometry {
  toCoordinate(value: number): number | null;
  lastCoordinates(): number[];
  formatted?(): void;
  failed?(error: unknown): void;
}

const KOREAN = [[1e12, "조"], [1e8, "억"], [1e4, "만"]] as const;
const INTERNATIONAL = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const;
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
  const korean = unit === "KRW" || unit === "volume";
  const compact = (korean ? KOREAN : INTERNATIONAL).find(([scale]) => v >= scale && (unit !== "price" && unit !== "index" || scale >= 1e6));
  if (compact) {
    const [scale, label] = compact;
    const digits = precision ?? (label === "조" ? 1 : label === "만" ? 0 : 2);
    const number = unit === "price" ? (v / scale).toFixed(digits) : decimal(v / scale, digits);
    return signed(value, `${number}${label}${suffix(unit)}`);
  }
  const digits = precision ?? (unit === "price" || unit === "volume" ? 0 : 2);
  return signed(value, numberText(v, digits, true) + suffix(unit));
}

type TickNotation = "compact" | "international" | "plain" | "scientific";
function tickValue(value: number, unit: AxisUnit, precision: number | undefined, notation: TickNotation): string {
  if (!Number.isFinite(value)) return "—";
  if (notation === "compact") return formatAxisValue(value, unit, precision);
  if (notation === "plain") return signed(value, decimal(Math.abs(value), precision ?? 2) + suffix(unit));
  if (notation === "scientific") return scientific(value, precision ?? 2) + suffix(unit);
  const compact = INTERNATIONAL.find(([scale]) => Math.abs(value) >= scale);
  return compact ? signed(value, `${decimal(Math.abs(value) / compact[0], precision ?? 2)}${compact[1]}${suffix(unit)}`) : tickValue(value, unit, precision, "plain");
}

function* axisCandidates(value: number, unit: AxisUnit): Generator<string> {
  yield formatAxisValue(value, unit);
  for (const notation of ["compact", "plain", "international", "scientific"] as const) {
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
  const defaults = values.map((value) => formatAxisValue(value, unit));
  let best = defaults.every(fits) ? defaults : null;
  let distinct = best ? new Set(best).size : 0;
  if (distinct === values.length) return defaults;
  for (const notation of ["compact", "international", "plain", "scientific"] as const) {
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

export function axisPriceFormat(unit: AxisUnit, minMove: number, geometry?: AxisGeometry) {
  const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const styles = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  const fontSize = Number.parseFloat(styles?.getPropertyValue("--fs-xs") ?? "") || 11;
  if (context) context.font = `${fontSize}px ${styles?.getPropertyValue("--font-sans") ?? "sans-serif"}`;
  const budget = 72 - (11 + fontSize * 5 / 6);
  const fits = (text: string) => !context || context.measureText(text.replace(/[1-9]/g, "0")).width <= budget;
  return {
    type: "custom", minMove,
    formatter: (value: number) => fitAxisValue(value, unit, fits),
    tickmarksFormatter: (values: number[]) => {
      let labels = distinctAxisTicks(values, unit, fits);
      try {
        labels = formatAxisTicks(values, labels, geometry, fontSize);
      } catch (error) {
        if (geometry?.failed) geometry.failed(error);
        else console.error("Axis label collision check failed", error);
      }
      geometry?.formatted?.();
      return labels;
    },
  } satisfies PriceFormatCustom;
}
