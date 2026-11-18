import type { Bar } from "../api/generated/Bar";
import type { KstDate } from "../api/generated/KstDate";
import type { Period } from "../api/generated/Period";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import type { WindowId } from "../layout/kinds";
import { PERIOD_LABEL } from "../lib/symbol";
import { type BarInterval, barInterval, PERIOD_ORDER } from "./crosshairSync";
import { formatBarTime, isIntraday } from "./time";

export interface JumpChart {
  id: WindowId;
  symbol: SymbolCode;
  period: Period;
}

export function jumpTargets(charts: readonly JumpChart[], sourceId: WindowId, sourcePeriod: Period): WindowId[] {
  const source = charts.find((chart) => chart.id === sourceId);
  if (!source) return [];
  return charts
    .filter((chart) => chart.id !== sourceId && chart.symbol === source.symbol && PERIOD_ORDER[chart.period] < PERIOD_ORDER[sourcePeriod])
    .map((chart) => chart.id);
}

export function barAtRightEdge(bars: readonly Bar[], edge: UnixSeconds | null): Bar | null {
  const last = bars.at(-1);
  if (!last) return null;
  if (edge === null || edge >= last.t) return last;
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t <= edge) lo = mid + 1;
    else hi = mid;
  }
  return bars[lo - 1] ?? null;
}

export interface JumpAnchor {
  period: Period;
  interval: BarInterval;
  date: KstDate;
  label: string;
}

export const kstDateOf = (t: UnixSeconds): KstDate => formatBarTime(t, "D");

export function jumpAnchor(bar: Bar | null, period: Period): JumpAnchor | null {
  if (!bar) return null;
  const interval = barInterval(bar.t, period);
  const date = kstDateOf(interval.end - 1);
  return { period, interval, date, label: `바로가기 · ${isIntraday(period) ? formatBarTime(bar.t, period) : date}` };
}

export type JumpRoute = "view" | "mode" | "extend";

export function jumpRoute(input: { period: Period; date: KstDate; today: KstDate; held: boolean }): JumpRoute {
  if (input.held || input.date >= input.today) return "view";
  return isIntraday(input.period) ? "mode" : "extend";
}

export function jumpHeld(input: { bars: readonly Bar[]; interval: BarInterval; date: KstDate; modeDate: KstDate | null }): boolean {
  if (input.modeDate !== null) return input.date === input.modeDate;
  return lastBarBefore(input.bars, input.interval) !== null;
}

export interface IntervalEnd {
  index: number;
  inInterval: boolean;
}

export function lastBarBefore(bars: readonly Bar[], interval: BarInterval): IntervalEnd | null {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t < interval.end) lo = mid + 1;
    else hi = mid;
  }
  const bar = bars[lo - 1];
  return bar ? { index: lo - 1, inInterval: bar.t >= interval.start } : null;
}

export type JumpOutcome = "moved" | "previous" | "empty" | "failed" | "cancelled";

export interface JumpResult {
  period: Period;
  outcome: JumpOutcome;
}

const barKind = (period: Period): string => (isIntraday(period) ? "분봉" : period === "D" ? "일봉" : period === "W" ? "주봉" : period === "M" ? "월봉" : period === "Q" ? "분기봉" : "연봉");

const labels = (results: readonly JumpResult[]): string => results.map((r) => PERIOD_LABEL[r.period]).join("·");

export function jumpNotice(results: readonly JumpResult[], date: KstDate): string | null {
  const parts: string[] = [];
  const moved = results.filter((r) => r.outcome === "moved");
  if (moved.length > 0) parts.push(`${labels(moved)} 차트를 ${date} 기준으로 옮겼습니다`);
  for (const r of results.filter((r) => r.outcome === "previous")) parts.push(`${PERIOD_LABEL[r.period]} 차트는 그 날 ${barKind(r.period)}이 없어 직전 봉까지 보입니다`);
  for (const r of results.filter((r) => r.outcome === "empty")) {
    parts.push(isIntraday(r.period) ? `${date} 분봉을 키움이 주지 않습니다 · 분봉은 대개 최근 1년까지입니다` : `${date} ${barKind(r.period)}을 받을 수 없습니다`);
  }
  for (const r of results.filter((r) => r.outcome === "failed")) parts.push(`${barKind(r.period)}을 받지 못했습니다`);
  return parts.length === 0 ? null : [...new Set(parts)].join(" ");
}
