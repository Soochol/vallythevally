import type { Period } from "../../api/generated/Period";
import type { QuoteDayInfo } from "../../api/generated/QuoteDayInfo";
import type { QuoteDayState } from "../../api/generated/QuoteDayState";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { Venue } from "../../api/generated/Venue";
import { kstDateOf } from "../barJump";
import { PERIOD_ORDER } from "../crosshairSync";
import { type DateRange, mergeRanges, missingFromRanges, rangesContain } from "./coverage";

export interface QuoteKey {
  symbol: SymbolCode;
  venue: Venue;
  period: Period;
  variant?: string;
}

export interface QuotePage<P> {
  available: boolean;
  days: readonly QuoteDayInfo[];
  points: readonly P[];
}

export type QuoteRange = DateRange & { after?: UnixSeconds };

export interface QuoteFeedDeps<P> {
  fetch(key: QuoteKey, range: QuoteRange, signal: AbortSignal): Promise<QuotePage<P>>;
  changed(from: UnixSeconds | null): void;
  now(): UnixSeconds;
}

export type QuoteState = "loading" | "ready" | "notCollected" | "disabled" | "failed";

export interface QuoteView<P> {
  readonly state: QuoteState;
  at(t: UnixSeconds): P | undefined;
}

export const TAIL_EVERY_MS = 5000;
const BASE_RETRY_SEC = TAIL_EVERY_MS / 1000;
const MAX_RETRY_SEC = 60;

const KST_OFFSET = 32400;
const DAY_SECONDS = 86400;
const TAIL_START_SEC = 8 * 3600;
const TAIL_END_SEC = 20 * 3600 + 5 * 60;

function sameKey(a: QuoteKey | null, b: QuoteKey | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.symbol === b.symbol && a.venue === b.venue && a.period === b.period && a.variant === b.variant;
}

function inTailWindow(now: UnixSeconds): boolean {
  const sec = (((now + KST_OFFSET) % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  return sec >= TAIL_START_SEC && sec <= TAIL_END_SEC;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

const minTime = (a: UnixSeconds | null, b: UnixSeconds): UnixSeconds => (a === null || b < a ? b : a);

export class QuoteFeed<P extends { t: UnixSeconds }> implements QuoteView<P> {
  private key: QuoteKey | null = null;
  private gen = 0;
  private _state: QuoteState = "loading";
  private readonly points = new Map<UnixSeconds, P>();
  private readonly days = new Map<string, QuoteDayState>();
  private have: DateRange[] = [];
  private need: DateRange | null = null;
  private available = true;
  private receivedAny = false;
  private covering = false;
  private failedCover = false;
  private coverFailures = 0;
  private nextCoverRetryAt: UnixSeconds = 0;
  private tailing = false;
  private coverAbort: AbortController | null = null;
  private tailAbort: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly deps: QuoteFeedDeps<P>) {}

  get state(): QuoteState {
    return this._state;
  }

  at(t: UnixSeconds): P | undefined {
    return this.points.get(t);
  }

  open(key: QuoteKey | null): void {
    if (this.disposed || sameKey(this.key, key)) return;
    this.gen++;
    this.abortInFlight();
    this.stopTimer();
    this.key = key ? { ...key } : null;
    this._state = "loading";
    this.points.clear();
    this.days.clear();
    this.have = [];
    this.need = null;
    this.available = true;
    this.receivedAny = false;
    this.covering = false;
    this.failedCover = false;
    this.coverFailures = 0;
    this.nextCoverRetryAt = 0;
    this.tailing = false;
  }

  cover(from: UnixSeconds, to: UnixSeconds): void {
    if (this.disposed || !this.key) return;
    const a = kstDateOf(from);
    const b = kstDateOf(to);
    const next = a <= b ? { from: a, to: b } : { from: b, to: a };
    const changed = this.need === null || this.need.from !== next.from || this.need.to !== next.to;
    this.need = next;
    if (changed) {
      this.failedCover = false;
      this.coverFailures = 0;
      this.nextCoverRetryAt = 0;
    }
    if (!this.covering && !this.failedCover) this.pumpCover();
  }

  dispose(): void {
    this.disposed = true;
    this.gen++;
    this.abortInFlight();
    this.stopTimer();
  }

  private abortInFlight(): void {
    this.coverAbort?.abort();
    this.coverAbort = null;
    this.tailAbort?.abort();
    this.tailAbort = null;
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private syncTimer(): void {
    const today = kstDateOf(this.deps.now());
    const coversToday = rangesContain(this.have, today);
    const want = !this.disposed && this.key !== null && (this.failedCover || (this.available && coversToday));
    if (want && this.timer === null) this.timer = setInterval(() => this.onTick(), TAIL_EVERY_MS);
    else if (!want && this.timer !== null) this.stopTimer();
  }

  private computeState(): QuoteState {
    if (!this.receivedAny) return this.failedCover ? "failed" : "loading";
    if (!this.available) return "disabled";
    let nonNone = 0;
    let allNotCollected = true;
    for (const state of this.days.values()) {
      if (state === "none") continue;
      nonNone++;
      if (state !== "notCollected") allNotCollected = false;
    }
    if (nonNone > 0 && allNotCollected) return "notCollected";
    return "ready";
  }

  private pumpCover(): void {
    if (this.disposed || !this.key || !this.need || this.covering) return;
    const chunks = missingFromRanges(this.need, this.have);
    if (chunks.length === 0) {
      this.failedCover = false;
      this.syncTimer();
      return;
    }
    const chunk = chunks[0]!;
    const gen = this.gen;
    const key = this.key;
    const ac = new AbortController();
    this.covering = true;
    this.failedCover = false;
    this.coverAbort = ac;
    this.deps.fetch(key, chunk, ac.signal).then(
      (page) => {
        if (gen !== this.gen || this.disposed) return;
        this.covering = false;
        this.coverAbort = null;
        this.coverFailures = 0;
        this.nextCoverRetryAt = 0;
        this.available = page.available;
        this.receivedAny = true;
        this.have = mergeRanges(this.have, chunk);
        for (const day of page.days) this.days.set(day.date, day.state);
        for (const pt of page.points) this.points.set(pt.t, pt);
        this._state = this.computeState();
        this.deps.changed(null);
        this.syncTimer();
        this.pumpCover();
      },
      () => {
        if (gen !== this.gen || this.disposed) return;
        this.covering = false;
        this.coverAbort = null;
        this.failedCover = true;
        this.coverFailures++;
        const delay = Math.min(MAX_RETRY_SEC, BASE_RETRY_SEC * 2 ** (this.coverFailures - 1));
        this.nextCoverRetryAt = this.deps.now() + delay;
        if (!this.receivedAny) {
          this._state = "failed";
          this.deps.changed(null);
        }
        this.syncTimer();
      },
    );
  }

  private onTick(): void {
    if (this.disposed || !this.key) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const now = this.deps.now();
    if (this.failedCover && !this.covering && now >= this.nextCoverRetryAt) this.pumpCover();
    if (this.tailing || this.have.length === 0) return;
    const today = kstDateOf(now);
    if (!rangesContain(this.have, today)) return;
    if (!inTailWindow(now)) return;
    const todayStart = Date.parse(`${today}T00:00:00+09:00`) / 1000;
    const todayEnd = todayStart + DAY_SECONDS;
    let maxT: UnixSeconds | null = null;
    for (const t of this.points.keys()) {
      if (t >= todayStart && t < todayEnd && (maxT === null || t > maxT)) maxT = t;
    }
    const barSeconds = PERIOD_ORDER[this.key.period] * 60;
    const after = maxT === null ? todayStart : maxT - barSeconds;
    const gen = this.gen;
    const key = this.key;
    const ac = new AbortController();
    this.tailing = true;
    this.tailAbort = ac;
    this.deps.fetch(key, { from: today, to: today, after }, ac.signal).then(
      (page) => {
        if (gen !== this.gen || this.disposed) return;
        this.tailing = false;
        this.tailAbort = null;
        this.available = page.available;
        this.receivedAny = true;
        for (const day of page.days) this.days.set(day.date, day.state);
        const prevState = this._state;
        this._state = this.computeState();
        this.syncTimer();
        const nextMap = new Map<UnixSeconds, P>();
        for (const pt of page.points) if (pt.t >= after) nextMap.set(pt.t, pt);
        let firstChanged: UnixSeconds | null = null;
        for (const [t, oldPt] of this.points) {
          if (t < after) continue;
          const nextPt = nextMap.get(t);
          if (nextPt === undefined) {
            this.points.delete(t);
            firstChanged = minTime(firstChanged, t);
          } else if (!sameValue(oldPt, nextPt)) {
            this.points.set(t, nextPt);
            firstChanged = minTime(firstChanged, t);
          }
        }
        for (const [t, nextPt] of nextMap) {
          if (!this.points.has(t)) {
            this.points.set(t, nextPt);
            firstChanged = minTime(firstChanged, t);
          }
        }
        if (firstChanged !== null) this.deps.changed(firstChanged);
        else if (prevState !== this._state) this.deps.changed(null);
      },
      () => {
        if (gen !== this.gen || this.disposed) return;
        this.tailing = false;
        this.tailAbort = null;
      },
    );
  }
}
