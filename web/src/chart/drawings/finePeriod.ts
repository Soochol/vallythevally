import type { Period } from "../../api/generated/Period";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";

export type FinePeriod = "1m" | "3m" | "5m" | "10m" | "15m" | "30m" | "60m";

export type NoFineReason = "oneMinuteChart" | "pastYear" | "overLimit";

export type FineChoice = { kind: "period"; period: FinePeriod } | { kind: "none"; reason: NoFineReason };

export const MAX_FINE_BARS = 10_000;
export const LONGEST_SESSION_MINUTES = 720;

const DAY = 86_400;
const KST_OFFSET = 9 * 3600;
const MAX_FINE_AGE = 365 * DAY;

const FINE_MINUTES: Record<FinePeriod, number> = { "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "60m": 60 };
const SHORTEST_FIRST: readonly FinePeriod[] = ["1m", "3m", "5m", "10m", "15m", "30m", "60m"];

const isFinePeriod = (p: Period): p is FinePeriod => p in FINE_MINUTES;

const kstDay = (t: UnixSeconds) => Math.floor((t + KST_OFFSET) / DAY);

const isWeekday = (day: number) => {
  const weekday = (((day + 4) % 7) + 7) % 7;
  return weekday !== 0 && weekday !== 6;
};

export function weekdaysBetween(from: UnixSeconds, to: UnixSeconds): number {
  const first = kstDay(from);
  const last = kstDay(to);
  if (last < first) return 0;
  const weeks = Math.floor((last - first + 1) / 7);
  let count = weeks * 5;
  for (let day = first + weeks * 7; day <= last; day++) if (isWeekday(day)) count++;
  return count;
}

const fitsChart = (fine: FinePeriod, chart: Period) =>
  !isFinePeriod(chart) || (FINE_MINUTES[fine] < FINE_MINUTES[chart] && FINE_MINUTES[chart] % FINE_MINUTES[fine] === 0);

export function chooseFinePeriod(chart: Period, start: UnixSeconds, now: UnixSeconds): FineChoice {
  if (chart === "1m") return { kind: "none", reason: "oneMinuteChart" };
  if (now - start > MAX_FINE_AGE) return { kind: "none", reason: "pastYear" };
  const weekdays = weekdaysBetween(start, now);
  const period = SHORTEST_FIRST.find((fine) => fitsChart(fine, chart) && (weekdays * LONGEST_SESSION_MINUTES) / FINE_MINUTES[fine] <= MAX_FINE_BARS);
  return period === undefined ? { kind: "none", reason: "overLimit" } : { kind: "period", period };
}
