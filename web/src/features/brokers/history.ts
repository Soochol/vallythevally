import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { BoardAxis } from "./board";

const KST_OFFSET_MS = 9 * 3600 * 1000;
const KST_OFFSET_SECONDS = 9 * 3600;
const OPEN_SECONDS = 9 * 3600;
const DAY_SECONDS = 24 * 3600;

export interface DayNav {
  readonly date: string;
  readonly isToday: boolean;
  readonly previous: string | null;
  readonly next: string | null;
}

export interface AxisGapRange {
  readonly left: number;
  readonly width: number;
}

export function dayNav(days: readonly string[], today: string, shown: string): DayNav {
  const all = [...new Set([...days, today])].sort();
  const index = all.indexOf(shown);
  const resolvedIndex = index === -1 ? all.indexOf(today) : index;
  const date = all[resolvedIndex]!;
  return {
    date,
    isToday: date === today,
    previous: resolvedIndex > 0 ? all[resolvedIndex - 1]! : null,
    next: resolvedIndex < all.length - 1 ? all[resolvedIndex + 1]! : null,
  };
}

export function priceAt(bars: readonly Bar[], t: UnixSeconds): number | null {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? null : bars[found]!.c;
}

export function kstDateOf(unixMs: number): string {
  const date = new Date(unixMs + KST_OFFSET_MS);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function formatMonthDay(date: string): string {
  return `${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

export function kstDayBounds(date: string): { readonly open: UnixSeconds; readonly end: UnixSeconds } {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const dayStart = Math.floor(Date.UTC(year, month - 1, day) / 1000) - KST_OFFSET_SECONDS;
  return { open: dayStart + OPEN_SECONDS, end: dayStart + DAY_SECONDS };
}

export function axisGapRanges(gaps: readonly (readonly [UnixSeconds, UnixSeconds])[], axis: BoardAxis): readonly AxisGapRange[] {
  const span = axis.to - axis.from;
  if (span <= 0 || gaps.length === 0) return [];
  const ranges: AxisGapRange[] = [];
  for (const [rawFrom, rawTo] of gaps) {
    const from = Math.max(rawFrom, axis.from);
    const to = Math.min(rawTo, axis.to);
    if (to <= from) continue;
    ranges.push({
      left: ((from - axis.from) / span) * 100,
      width: ((to - from) / span) * 100,
    });
  }
  return ranges;
}
