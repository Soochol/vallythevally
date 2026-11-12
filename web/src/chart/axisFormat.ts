import type { PriceFormatCustom } from "lightweight-charts";
import type { FinancialMetric } from "../api/generated/FinancialMetric";
import { MINUS } from "../lib/format";

export type AxisUnit = "price" | "index" | "volume" | "KRW" | "%" | "원/주" | { currency: string };

const KOREAN = [[1e12, "조"], [1e8, "억"], [1e4, "만"]] as const;
const INTERNATIONAL = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const;
const decimal = (v: number, digits: number) => v.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: digits });

export function financialAxisUnit(metric: FinancialMetric, currency: string | null): AxisUnit {
  if (metric === "owner_roe" || metric === "debt_ratio") return "%";
  if (metric === "dps") return "원/주";
  return currency === "KRW" ? "KRW" : { currency: currency ?? "?" };
}

export function formatAxisValue(value: number, unit: AxisUnit, precision = 2): string {
  const v = Math.abs(value);
  const sign = value < 0 ? MINUS : "";
  const korean = unit === "KRW" || unit === "volume";
  const units = korean ? KOREAN : INTERNATIONAL;
  const compact = units.find(([scale]) => v >= scale && (unit !== "price" && unit !== "index" || scale >= 1e6));
  const suffix = typeof unit === "object" ? unit.currency : unit === "%" || unit === "원/주" ? unit : "";
  if (compact) {
    const [scale, label] = compact;
    const digits = label === "조" ? Math.min(precision, 1) : label === "만" ? 0 : precision;
    const number = !korean && unit === "price" ? (v / scale).toFixed(precision) : decimal(v / scale, digits);
    return `${sign}${number}${label}${suffix}`;
  }
  const digits = unit === "price" || unit === "volume" ? 0 : precision;
  const number = v.toLocaleString("en-US", { maximumFractionDigits: digits });
  return `${sign}${number}${suffix}`;
}

export function formatAxisTicks(values: number[], formatter: (value: number) => string, lastValues: number[]): string[] {
  if (values.length < 2) return values.map((v) => lastValues.length ? "" : formatter(v));
  const spacing = Math.min(...values.slice(1).map((v, i) => Math.abs(v - values[i]!)));
  return values.map((value) => lastValues.some((last) => Math.abs(last - value) < spacing * 0.6) ? "" : formatter(value));
}

export function fitAxisValue(value: number, unit: AxisUnit, fits: (text: string) => boolean, maxPrecision = 2): string {
  let text = formatAxisValue(value, unit);
  for (let precision = maxPrecision; precision >= 0; precision--) {
    text = formatAxisValue(value, unit, precision);
    if (fits(text)) return text;
  }
  const ungrouped = text.replaceAll(",", "");
  if (fits(ungrouped)) return ungrouped;
  const suffix = typeof unit === "object" ? unit.currency : unit === "%" || unit === "원/주" ? unit : unit === "KRW" ? "원" : "";
  const compact = INTERNATIONAL.find(([scale]) => Math.abs(value) >= scale);
  if (compact) {
    const shorter = `${value < 0 ? MINUS : ""}${decimal(Math.abs(value) / compact[0], 0)}${compact[1]}${suffix}`;
    if (fits(shorter)) return shorter;
  }
  if (unit === "원/주" && Math.abs(value) >= 100 && Math.abs(value) < 1000) {
    const hundreds = `${value < 0 ? MINUS : ""}${decimal(Math.abs(value) / 100, 0)}백원/주`;
    if (fits(hundreds)) return hundreds;
  }
  const exponential = `${value < 0 ? MINUS : ""}${Math.abs(value).toExponential(0).replace("e+", "e")}${suffix}`;
  return fits(exponential) ? exponential : text;
}

export function axisPriceFormat(unit: AxisUnit, minMove: number, lastValues: () => number[] = () => []): PriceFormatCustom {
  const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const styles = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  const fontSize = Number.parseFloat(styles?.getPropertyValue("--fs-xs") ?? "") || 11;
  if (context) context.font = `${fontSize}px ${styles?.getPropertyValue("--font-sans") ?? "sans-serif"}`;
  const formatter = (value: number, precision = 2) => {
    if (!context) return formatAxisValue(value, unit, precision);
    const budget = 72 - (11 + fontSize * 5 / 6);
    return fitAxisValue(value, unit, (text) => context.measureText(text.replace(/[1-9]/g, "0")).width <= budget, precision);
  };
  return { type: "custom", minMove, formatter, tickmarksFormatter: (values) => {
    let precision = 2;
    if (unit === "price") {
      while (precision < 5 && new Set(values.map((v) => formatter(v, precision))).size < values.length) precision++;
    }
    return formatAxisTicks(values, (v) => formatter(v, precision), lastValues());
  } };
}
