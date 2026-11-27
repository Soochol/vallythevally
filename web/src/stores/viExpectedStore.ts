import type { FeedExpected } from "../api/generated/FeedExpected";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import type { Venue } from "../api/generated/Venue";
import type { ViExpectedPoint } from "../api/generated/ViExpectedPoint";
import type { ViMarket } from "../api/generated/ViMarket";
import type { ViState } from "../api/generated/ViState";
import type { FeedEvent, FeedRequest, MarketSocket, ViEvent } from "../api/socket";

export const MAX_EXPECTED_POINTS = 240;
export const MAX_EXPECTED_SESSIONS = 500;
export const EMPTY_EXPECTED_POINTS: readonly ViExpectedPoint[] = [];

const KST_OFFSET_SECS = 9 * 3600;
const DAY_SECS = 86_400;

export interface ViStateLookup {
  get(code: SymbolCode, market: ViMarket): ViState | null;
}

function activeViForVenue(lookup: ViStateLookup, code: SymbolCode, venue: Venue): ViState | null {
  if (venue === "nxt") {
    const nxt = lookup.get(code, "nxt");
    return nxt?.active ? nxt : null;
  }
  if (venue === "krx") {
    const krx = lookup.get(code, "krx");
    return krx?.active ? krx : null;
  }
  const krx = lookup.get(code, "krx");
  if (krx?.active) return krx;
  const nxt = lookup.get(code, "nxt");
  return nxt?.active ? nxt : null;
}

interface SessionEntry {
  readonly code: SymbolCode;
  readonly triggeredAt: UnixSeconds | null;
  readonly points: readonly ViExpectedPoint[];
  readonly kstDay: number;
}

function kstDayOf(unixSeconds: UnixSeconds): number {
  return Math.floor((unixSeconds + KST_OFFSET_SECS) / DAY_SECS);
}

function bucketKey(code: SymbolCode, market: ViMarket): string {
  return `${code}:${market}`;
}

function sameSeries(a: readonly ViExpectedPoint[], b: readonly ViExpectedPoint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.t !== right.t || left.price !== right.price || left.qty !== right.qty) return false;
  }
  return true;
}

export function appendExpectedPoint(
  series: readonly ViExpectedPoint[],
  expected: FeedExpected | null,
  t: UnixSeconds,
): readonly ViExpectedPoint[] {
  if (expected === null || !(expected.price > 0) || !Number.isFinite(expected.price)) return series;
  const qty = Number.isFinite(expected.qty) && expected.qty >= 0 ? expected.qty : 0;
  const last = series[series.length - 1];
  if (last !== undefined) {
    if (t < last.t) return series;
    if (last.price === expected.price && last.qty === qty) return series;
  }
  const next = [...series, { t, price: expected.price, qty }];
  return next.length > MAX_EXPECTED_POINTS ? next.slice(next.length - MAX_EXPECTED_POINTS) : next;
}

export function mergeExpectedSeries(
  existing: readonly ViExpectedPoint[],
  incoming: readonly ViExpectedPoint[],
): readonly ViExpectedPoint[] {
  if (incoming.length === 0) return existing;
  const combined = [...existing, ...incoming]
    .filter((point) => point.price > 0 && Number.isFinite(point.price) && Number.isFinite(point.qty) && point.qty >= 0)
    .sort((a, b) => a.t - b.t);
  let merged: readonly ViExpectedPoint[] = [];
  for (const point of combined) {
    merged = appendExpectedPoint(merged, { price: point.price, qty: point.qty }, point.t);
  }
  return merged;
}

export class ViExpectedStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly activeKeys = new Set<string>();
  private readonly listeners = new Map<SymbolCode, Set<() => void>>();
  private latestKstDay: number | null = null;
  private readonly viLookup: ViStateLookup | undefined;

  constructor(socket?: Pick<MarketSocket, "onVi"> & Partial<Pick<MarketSocket, "onFeedTap">>, viLookup?: ViStateLookup) {
    this.viLookup = viLookup;
    socket?.onVi((event) => this.onEvent(event));
    socket?.onFeedTap?.((request, event) => this.onFeedTap(request, event));
  }

  private onFeedTap(request: FeedRequest, event: FeedEvent): void {
    if (request.kind !== "book" || event.type !== "feed_book" || event.book.expected === null || this.viLookup === undefined) return;
    const active = activeViForVenue(this.viLookup, request.symbol, request.venue ?? "combined");
    if (active === null) return;
    this.record(request.symbol, active.market, active.triggeredAt, event.book.expected, event.book.t);
  }

  get(code: SymbolCode, market: ViMarket, triggeredAt: UnixSeconds | null): readonly ViExpectedPoint[] {
    const entry = this.sessions.get(bucketKey(code, market));
    if (entry === undefined || entry.triggeredAt !== triggeredAt) return EMPTY_EXPECTED_POINTS;
    return entry.points;
  }

  subscribe(code: SymbolCode, listener: () => void): () => void {
    let set = this.listeners.get(code);
    if (!set) this.listeners.set(code, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(code) === set) this.listeners.delete(code);
    };
  }

  record(
    code: SymbolCode,
    market: ViMarket,
    triggeredAt: UnixSeconds | null,
    expected: FeedExpected | null,
    at: UnixSeconds,
  ): void {
    if (expected === null || !(expected.price > 0) || !Number.isFinite(expected.price)) return;
    if (triggeredAt !== null && at < triggeredAt) return;
    const day = kstDayOf(at);
    this.advanceDay(day);
    const key = bucketKey(code, market);
    const existing = this.sessions.get(key);
    const base = existing !== undefined && existing.triggeredAt === triggeredAt ? existing.points : EMPTY_EXPECTED_POINTS;
    const next = appendExpectedPoint(base, expected, at);
    if (existing !== undefined && existing.triggeredAt === triggeredAt && next === base) return;
    if (next.length === 0) return;
    this.put(key, { code, triggeredAt, points: next, kstDay: day });
    this.notify(code);
  }

  mergeSnapshot(
    code: SymbolCode,
    market: ViMarket,
    triggeredAt: UnixSeconds | null,
    incoming: readonly ViExpectedPoint[],
  ): void {
    const valid = incoming.filter(
      (point) =>
        point.price > 0 &&
        Number.isFinite(point.price) &&
        Number.isFinite(point.qty) &&
        point.qty >= 0 &&
        (triggeredAt === null || point.t >= triggeredAt),
    );
    if (valid.length === 0) return;
    const day = kstDayOf(valid[valid.length - 1]!.t);
    this.advanceDay(day);
    const key = bucketKey(code, market);
    const existing = this.sessions.get(key);
    const base = existing !== undefined && existing.triggeredAt === triggeredAt ? existing.points : EMPTY_EXPECTED_POINTS;
    const merged = mergeExpectedSeries(base, valid);
    if (existing !== undefined && existing.triggeredAt === triggeredAt && sameSeries(base, merged)) return;
    if (merged.length === 0) return;
    this.put(key, { code, triggeredAt, points: merged, kstDay: day });
    this.notify(code);
  }

  clear(): void {
    if (this.sessions.size === 0 && this.activeKeys.size === 0 && this.latestKstDay === null) return;
    const cleared = new Set<SymbolCode>();
    for (const entry of this.sessions.values()) cleared.add(entry.code);
    this.sessions.clear();
    this.activeKeys.clear();
    this.latestKstDay = null;
    for (const code of cleared) this.notify(code);
  }

  private onEvent(event: ViEvent): void {
    switch (event.type) {
      case "vi_expected_snapshot":
        this.mergeSnapshot(event.symbol, event.market, event.triggeredAt, event.points);
        return;
      case "vi_snapshot": {
        if (event.states.length === 0) {
          this.clear();
          return;
        }
        this.activeKeys.clear();
        const changed = new Set<SymbolCode>();
        for (const state of event.states) {
          const key = bucketKey(state.symbol, state.market);
          if (state.triggeredAt !== null) this.advanceDay(kstDayOf(state.triggeredAt));
          if (state.active) {
            this.activeKeys.add(key);
            const existing = this.sessions.get(key);
            if (existing !== undefined && existing.triggeredAt !== state.triggeredAt) {
              this.sessions.delete(key);
              changed.add(state.symbol);
            }
          }
        }
        for (const code of changed) this.notify(code);
        return;
      }
      case "vi_update": {
        const { state } = event;
        const key = bucketKey(state.symbol, state.market);
        if (state.triggeredAt !== null) this.advanceDay(kstDayOf(state.triggeredAt));
        if (state.active) {
          this.activeKeys.add(key);
          const existing = this.sessions.get(key);
          if (existing !== undefined && existing.triggeredAt !== state.triggeredAt) {
            this.sessions.delete(key);
            this.notify(state.symbol);
          }
        } else {
          this.activeKeys.delete(key);
        }
        return;
      }
    }
  }

  private advanceDay(day: number): void {
    if (this.latestKstDay !== null && day <= this.latestKstDay) return;
    const prev = this.latestKstDay;
    this.latestKstDay = day;
    if (prev === null) return;
    const evicted = new Set<SymbolCode>();
    for (const [key, entry] of this.sessions) {
      if (entry.kstDay < day) {
        this.sessions.delete(key);
        evicted.add(entry.code);
      }
    }
    for (const code of evicted) this.notify(code);
  }

  private put(key: string, entry: SessionEntry): void {
    if (this.sessions.has(key)) this.sessions.delete(key);
    this.sessions.set(key, entry);
    this.evictOverLimit();
  }

  private evictOverLimit(): void {
    while (this.sessions.size > MAX_EXPECTED_SESSIONS) {
      let victimKey: string | null = null;
      for (const key of this.sessions.keys()) {
        if (!this.activeKeys.has(key)) {
          victimKey = key;
          break;
        }
      }
      if (victimKey === null) {
        victimKey = this.sessions.keys().next().value ?? null;
      }
      if (victimKey === null) break;
      const removed = this.sessions.get(victimKey);
      this.sessions.delete(victimKey);
      if (removed !== undefined) this.notify(removed.code);
    }
  }

  private notify(code: SymbolCode): void {
    for (const listener of this.listeners.get(code) ?? []) listener();
  }
}
