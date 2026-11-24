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
  const nFrom = toDay(need.from);
  const nTo = toDay(need.to);
  if (nFrom > nTo) return [];
  if (!have) return splitNewest(nFrom, nTo);
  const hFrom = toDay(have.from);
  const hTo = toDay(have.to);
  if (nTo < hFrom || nFrom > hTo) return splitNewest(nFrom, nTo);
  const out: DateRange[] = [];
  if (nTo > hTo) out.push(...splitNewest(hTo + 1, nTo));
  if (nFrom < hFrom) out.push(...splitNewest(nFrom, hFrom - 1));
  return out;
}
