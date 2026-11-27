export interface DateRange {
  from: string;
  to: string;
}

export const MAX_RANGE_DAYS = 31;

const DAY_MS = 86_400_000;

const toDay = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

const fromDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

function splitNewest(fromDayNum: number, toDayNum: number): DateRange[] {
  const out: DateRange[] = [];
  for (let end = toDayNum; end >= fromDayNum; ) {
    const start = Math.max(fromDayNum, end - (MAX_RANGE_DAYS - 1));
    out.push({ from: fromDay(start), to: fromDay(end) });
    end = start - 1;
  }
  return out;
}

export function missingRanges(need: DateRange, have: DateRange | null): DateRange[] {
  return missingFromRanges(need, have ? [have] : []);
}

export function mergeRanges(ranges: readonly DateRange[], added: DateRange): DateRange[] {
  const all = [...ranges, added]
    .map((r) => ({ from: toDay(r.from), to: toDay(r.to) }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: { from: number; to: number }[] = [];
  for (const cur of all) {
    const prev = merged[merged.length - 1];
    if (prev && cur.from <= prev.to + 1) {
      if (cur.to > prev.to) prev.to = cur.to;
    } else {
      merged.push({ from: cur.from, to: cur.to });
    }
  }
  return merged.map((r) => ({ from: fromDay(r.from), to: fromDay(r.to) }));
}

export function missingFromRanges(need: DateRange, haves: readonly DateRange[]): DateRange[] {
  const nFrom = toDay(need.from);
  const nTo = toDay(need.to);
  if (nFrom > nTo) return [];
  if (haves.length === 0) return splitNewest(nFrom, nTo);
  const gaps: { from: number; to: number }[] = [];
  let cursor = nFrom;
  for (const h of haves) {
    const hFrom = toDay(h.from);
    const hTo = toDay(h.to);
    if (hTo < cursor) continue;
    if (hFrom > nTo) break;
    if (hFrom > cursor) gaps.push({ from: cursor, to: Math.min(nTo, hFrom - 1) });
    cursor = Math.max(cursor, hTo + 1);
    if (cursor > nTo) break;
  }
  if (cursor <= nTo) gaps.push({ from: cursor, to: nTo });
  const out: DateRange[] = [];
  for (let i = gaps.length - 1; i >= 0; i--) {
    out.push(...splitNewest(gaps[i]!.from, gaps[i]!.to));
  }
  return out;
}

export function missingUnchunked(need: DateRange, haves: readonly DateRange[]): DateRange[] {
  const nFrom = toDay(need.from);
  const nTo = toDay(need.to);
  if (nFrom > nTo) return [];
  if (haves.length === 0) return [need];
  const gaps: DateRange[] = [];
  let cursor = nFrom;
  for (const h of haves) {
    const hFrom = toDay(h.from);
    const hTo = toDay(h.to);
    if (hTo < cursor) continue;
    if (hFrom > nTo) break;
    if (hFrom > cursor) gaps.push({ from: fromDay(cursor), to: fromDay(Math.min(nTo, hFrom - 1)) });
    cursor = Math.max(cursor, hTo + 1);
    if (cursor > nTo) break;
  }
  if (cursor <= nTo) gaps.push({ from: fromDay(cursor), to: fromDay(nTo) });
  return gaps.reverse();
}

export function rangesContain(haves: readonly DateRange[], date: string): boolean {
  return haves.some((r) => date >= r.from && date <= r.to);
}
