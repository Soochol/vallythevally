import type { Market } from "../../api/generated/Market";
import type { MarketOverviewMaHistoryPoint } from "../../api/generated/MarketOverviewMaHistoryPoint";
import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import type { MarketOverviewViEvent } from "../../api/generated/MarketOverviewViEvent";

const oneDecimal = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const SCOPE_LABEL: Record<MarketOverviewScope, string> = {
  all: "전체",
  kospi: "코스피",
  kosdaq: "코스닥",
};

export const MARKET_LABEL: Record<Market, string> = {
  kospi: "코스피",
  kosdaq: "코스닥",
};

export const scopeLabel = (scope: MarketOverviewScope): string => SCOPE_LABEL[scope];

export const formatPercent = (value: number): string => `${oneDecimal.format(value)}%`;

export function bucketTone(label: string): "up" | "down" | "flat" {
  const trimmed = label.trim();
  if (trimmed.includes("-0.5~+0.5") || trimmed.includes("−0.5~+0.5")) return "flat";
  if (trimmed.startsWith("+") || trimmed.startsWith("≥+")) return "up";
  if (trimmed.startsWith("-") || trimmed.startsWith("≤-") || trimmed.startsWith("−")) return "down";
  return "flat";
}

export function formatViTime(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 6) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  return raw;
}

export function viKindLabel(event: Pick<MarketOverviewViEvent, "staticVi" | "dynamicVi">): string {
  if (event.staticVi && event.dynamicVi) return "정적·동적";
  if (event.staticVi) return "정적";
  if (event.dynamicVi) return "동적";
  return "VI";
}

export function attributionBarPercent(points: number, maxAbs: number): number {
  if (maxAbs <= 0) return 0;
  return Math.min(100, (Math.abs(points) / maxAbs) * 100);
}

export function thrustToneOf(percent: number): "up" | "down" | "flat" {
  if (percent >= 60) return "up";
  if (percent <= 40) return "down";
  return "flat";
}

export interface SparklinePoint {
  x: number;
  y: number;
}

export function maSparklinePoints(
  history: readonly MarketOverviewMaHistoryPoint[],
  width: number,
  height: number,
): SparklinePoint[] {
  if (history.length === 0) return [];
  const pad = 4;
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  if (history.length === 1) {
    const clamped = Math.min(100, Math.max(0, history[0]!.above20Pct));
    return [{ x: width / 2, y: pad + ((100 - clamped) / 100) * innerH }];
  }
  const step = innerW / (history.length - 1);
  return history.map((point, index) => {
    const clamped = Math.min(100, Math.max(0, point.above20Pct));
    return {
      x: pad + index * step,
      y: pad + ((100 - clamped) / 100) * innerH,
    };
  });
}

export function maSparklinePath(history: readonly MarketOverviewMaHistoryPoint[], width: number, height: number): string {
  const points = maSparklinePoints(history, width, height);
  if (points.length === 0) return "";
  if (points.length === 1) {
    const point = points[0]!;
    const halfTick = Math.min(4, Math.max(1, (width - 8) / 2));
    return `M${(point.x - halfTick).toFixed(1)},${point.y.toFixed(1)} L${(point.x + halfTick).toFixed(1)},${point.y.toFixed(1)}`;
  }
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
}
