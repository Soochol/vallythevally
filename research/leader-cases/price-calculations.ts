import type { Day, DailyBar, MarketDay, NullValue, PriceSeries, SectorSeries, SectorWeek, TechnicalWeek, WeeklyBar } from "./bundle-types.ts";
import type { SectorMap } from "./sector-map.ts";
import { weekStart } from "./source-utils.ts";

export const NO_TURNOVER: NullValue = { value: null, reason: "bars_api_has_no_traded_value" };
const NO_MARKET_SHARE: NullValue = { value: null, reason: "historical_market_traded_value_unavailable" };
const NO_CAP_RANK: NullValue = { value: null, reason: "historical_marketwide_shares_and_prices_unavailable" };

export function aggregateWeeks(daily: DailyBar[]): WeeklyBar[] {
  const weeks: WeeklyBar[] = [];
  for (const b of daily) {
    const start = weekStart(b.day);
    const last = weeks.at(-1);
    if (last?.weekStart === start) {
      last.observedOn = b.day;
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else weeks.push({ weekStart: start, observedOn: b.day, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, turnoverWon: NO_TURNOVER });
  }
  return weeks;
}
export function sma(values: Array<number | null>, n: number): Array<number | null> {
  return values.map((_, i) => {
    const window = values.slice(Math.max(0, i - n + 1), i + 1);
    return window.length === n && window.every((x) => x !== null) ? window.reduce<number>((sum, x) => sum + (x ?? 0), 0) / n : null;
  });
}
function ema(values: Array<number | null>, n: number): Array<number | null> {
  let prior: number | null = null;
  const seed: number[] = [];
  return values.map((value) => {
    if (value === null) { prior = null; seed.length = 0; return null; }
    if (prior === null) {
      seed.push(value);
      if (seed.length < n) return null;
      prior = seed.reduce((a, b) => a + b, 0) / n;
    } else prior += 2 / (n + 1) * (value - prior);
    return prior;
  });
}
export function newHigh(values: Array<number | null>, n = 52): Array<boolean | null> {
  return values.map((value, i) => {
    const window = values.slice(Math.max(0, i - n + 1), i + 1);
    return value !== null && window.length === n && window.every((x) => x !== null) ? window.every((x) => x !== null && value >= x) : null;
  });
}
function rsi(values: Array<number | null>, n = 14): Array<number | null> {
  let gain = 0, loss = 0, count = 0;
  let previous: number | null = null;
  return values.map((value) => {
    if (value === null) { gain = 0; loss = 0; count = 0; previous = null; return null; }
    if (previous === null) { previous = value; return null; }
    const delta = value - previous;
    previous = value;
    count++;
    if (count <= n) { gain += Math.max(delta, 0) / n; loss += Math.max(-delta, 0) / n; }
    else { gain = (gain * (n - 1) + Math.max(delta, 0)) / n; loss = (loss * (n - 1) + Math.max(-delta, 0)) / n; }
    return count < n ? null : loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  });
}
function ratio(a: number | null | undefined, b: number | null | undefined): number | null {
  return a != null && b != null && b > 0 ? a / b : null;
}
export function marketRegimes(daily: DailyBar[]): MarketDay[] {
  const averages = sma(daily.map((b) => b.c), 200);
  let peak = 0;
  return daily.map((b, i) => {
    peak = Math.max(peak, b.c);
    const average = averages[i] ?? null;
    const prior = averages[i - 1] ?? null;
    const change = average !== null && prior !== null ? average - prior : null;
    const drawdown = peak > 0 ? (b.c / peak - 1) * 100 : 0;
    const regime = b.c <= peak * 0.8 ? "bear" : change === null || average === null ? null : b.c < average && change < 0 ? "bear" : b.c > average && change > 0 ? "bull" : "sideways";
    return { day: b.day, close: b.c, sma200: average, sma200Change: change, drawdownPct: drawdown, regime, reason: regime === null ? "need_201_daily_observations" : null };
  });
}
export function buildSectors(map: SectorMap, prices: PriceSeries[], calendar: Day[]): SectorSeries[] {
  const byCode = new Map(prices.map((p) => [p.symbol, p]));
  const byDay = new Map(prices.map((p) => [p.symbol, new Map(p.daily.map((b) => [b.day, b.c]))]));
  const weekEnds = [...new Map(calendar.map((d) => [weekStart(d), d])).values()];
  const result: SectorSeries[] = map.sectors.map((sector) => {
    let level: number | null = 100;
    let started = false;
    const missingMembers = sector.stocks.some((s) => !byCode.has(s.code));
    const daily = calendar.map((date, i) => {
      const previousDate = calendar[i - 1];
      const members = sector.stocks.filter((s) => { const first = byCode.get(s.code)?.firstObservedOn; return first != null && first <= date; }).map((s) => s.code);
      const returnContributors = members.filter((code) => previousDate !== undefined && byDay.get(code)?.has(previousDate) && byDay.get(code)?.has(date));
      const existing = members.filter((code) => { const first = byCode.get(code)?.firstObservedOn; return previousDate !== undefined && first != null && first <= previousDate; });
      const gap = members.some((code) => !byDay.get(code)?.has(date)) || existing.some((code) => !returnContributors.includes(code));
      const reason = missingMembers ? "member_source_failed" : gap ? "member_observation_missing" : members.length === 0 ? "no_listed_members" : level === null ? "index_chain_broken_by_missing_observation" : null;
      if (missingMembers || gap) level = null;
      if (members.length === 0) return { day: date, value: null, reason, members, returnContributors };
      if (level !== null && started && returnContributors.length > 0) {
        const meanReturn = returnContributors.reduce((sum, code) => sum + (byDay.get(code)!.get(date)! / byDay.get(code)!.get(previousDate!)! - 1), 0) / returnContributors.length;
        level *= 1 + meanReturn;
      }
      started = true;
      return { day: date, value: level, reason, members, returnContributors };
    });
    const sectorAt = new Map(daily.map((d) => [d.day, d]));
    const highs = new Map(sector.stocks.map((s) => [s.code, newHigh(weekEnds.map((d) => byDay.get(s.code)?.get(d) ?? null))]));
    const weekly: SectorWeek[] = weekEnds.map((date, i) => {
      const index = sectorAt.get(date)!;
      const prev = weeklyValue(daily, weekEnds[i - 13]);
      const members = index.members;
      const memberReturns: SectorWeek["memberRanks"] = members.map((code) => {
        const last = byDay.get(code)?.get(date);
        const first = weekEnds[i - 13] === undefined ? undefined : byDay.get(code)?.get(weekEnds[i - 13]!);
        const r = ratio(last, first);
        return { code, return13w: r === null ? null : (r - 1) * 100, rank: null };
      });
      for (const row of memberReturns) if (row.return13w !== null) row.rank = 1 + memberReturns.filter((x) => x.return13w !== null && x.return13w > row.return13w!).length;
      const known = members.map((code) => highs.get(code)?.[i]).filter((x) => typeof x === "boolean");
      const count = known.filter((x) => x).length;
      const unknownCount = members.length - known.length + sector.stocks.filter((s) => !byCode.has(s.code)).length;
      const r = ratio(index.value, prev);
      return { day: date, value: index.value, return13w: r === null ? null : (r - 1) * 100, rank: null, rankedSectors: 0, rankedMembers: memberReturns.filter((r) => r.rank !== null).length, breadthPct: unknownCount === 0 && members.length > 0 ? count / members.length * 100 : null, newHighCount: count, eligibleCount: members.length, unknownCount, memberRanks: memberReturns };
    });
    return { id: sector.id, daily, weekly };
  });
  for (let i = 0; i < weekEnds.length; i++) {
    const rows = result.map((s) => s.weekly[i]!);
    for (const row of rows) {
      row.rankedSectors = rows.filter((r) => r.return13w !== null).length;
      if (row.return13w !== null) row.rank = 1 + rows.filter((r) => r.return13w !== null && r.return13w > row.return13w!).length;
    }
  }
  return result;
}
function weeklyValue(daily: SectorSeries["daily"], date: Day | undefined): number | null {
  return date === undefined ? null : daily.find((d) => d.day === date)?.value ?? null;
}
export function technicalWeeks(target: PriceSeries, market: PriceSeries | undefined, sector: SectorSeries | undefined): TechnicalWeek[] {
  const byWeek = new Map(target.weekly.map((b) => [b.weekStart, b]));
  const starts = [...new Set([...target.weekly, ...(market?.weekly ?? [])].map((b) => b.weekStart))].sort();
  const bars = starts.map((d) => byWeek.get(d));
  const closes = bars.map((b) => b?.c ?? null);
  const a10 = sma(closes, 10), a30 = sma(closes, 30), a40 = sma(closes, 40);
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd = closes.map((_, i) => e12[i] != null && e26[i] != null ? e12[i]! - e26[i]! : null);
  const signal = ema(macd, 9);
  const strength = rsi(closes);
  const marketAt = new Map(market?.daily.map((b) => [b.day, b.c]));
  const sectorAt = new Map(sector?.daily.map((b) => [b.day, b.value]));
  const stockToMarket = bars.map((b) => b ? ratio(b.c, marketAt.get(b.observedOn)) : null);
  const stockToSector = bars.map((b) => b ? ratio(b.c, sectorAt.get(b.observedOn)) : null);
  const sectorToMarket = bars.map((b) => b ? ratio(sectorAt.get(b.observedOn), marketAt.get(b.observedOn)) : null);
  const priceHigh = newHigh(closes), smHigh = newHigh(stockToMarket), ssHigh = newHigh(stockToSector), msHigh = newHigh(sectorToMarket);
  let peak = 0;
  return bars.flatMap((b, i) => {
    if (!b) return [];
    peak = Math.max(peak, b.c);
    const a40Value = a40[i] ?? null;
    return { day: b.observedOn, sma10: a10[i] ?? null, sma30: a30[i] ?? null, sma40: a40Value, high52w: priceHigh[i] ?? null, disparity40Pct: a40Value !== null && a40Value > 0 ? (b.c / a40Value - 1) * 100 : null, drawdownPct: peak > 0 ? (b.c / peak - 1) * 100 : 0, rangePct: bars[i - 1] && bars[i - 1]!.c > 0 ? (b.h - b.l) / bars[i - 1]!.c * 100 : null, rsi14: strength[i] ?? null, macd: macd[i] ?? null, macdSignal: signal[i] ?? null, macdHistogram: macd[i] != null && signal[i] != null ? macd[i]! - signal[i]! : null, stockToMarket: stockToMarket[i] ?? null, stockToSector: stockToSector[i] ?? null, sectorToMarket: sectorToMarket[i] ?? null, stockToMarketHigh52w: smHigh[i] ?? null, stockToSectorHigh52w: ssHigh[i] ?? null, sectorToMarketHigh52w: msHigh[i] ?? null, turnoverWon: NO_TURNOVER, turnoverSma10Won: NO_TURNOVER, marketSharePct: NO_MARKET_SHARE, marketCapRank: NO_CAP_RANK };
  });
}
export function corrections(daily: DailyBar[]) {
  const result: Array<{ from: Day; trough: Day; recoveredOn: Day | null; depthPct: number; observations: number; volume: number }> = [];
  let peak = daily[0];
  let active: (typeof result)[number] | null = null;
  for (const b of daily.slice(1)) {
    if (!peak) break;
    if (b.c >= peak.c) {
      if (active) { active.recoveredOn = b.day; active.observations++; active.volume += b.v; result.push(active); active = null; }
      peak = b;
    } else {
      const depth = (b.c / peak.c - 1) * 100;
      active ??= { from: peak.day, trough: b.day, recoveredOn: null, depthPct: depth, observations: 0, volume: 0 };
      active.observations++;
      active.volume += b.v;
      if (depth < active.depthPct) { active.depthPct = depth; active.trough = b.day; }
    }
  }
  if (active) result.push(active);
  return result;
}
