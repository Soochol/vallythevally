import type { SeriesKey } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import type { MarketSocketLike } from "../api/socket";
import { BarFeed, displayBars, type FetchPage, type History } from "./barFeed";
import { chooseFinePeriod, type FineBarsRead, type FineBarsReader, type FinePeriod, type FineSpan } from "./drawings/finePeriod";

export const MAX_FINE_PAGES = 20;

const LOADING: FineBarsRead = { kind: "loading" };
const FAILED: FineBarsRead = { kind: "failed" };
const OVER_LIMIT: FineBarsRead = { kind: "none", reason: "overLimit" };

const nowSeconds = (): UnixSeconds => Math.floor(Date.now() / 1000);

function reaches(h: History, from: UnixSeconds): boolean {
  const first = h.bars[0] ?? h.current;
  return h.nextBefore === null || (first !== null && first.t <= from);
}

function firstAtOrAfter(bars: readonly Bar[], t: UnixSeconds): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const within = (bars: readonly Bar[], span: FineSpan) => bars.slice(firstAtOrAfter(bars, span.from), firstAtOrAfter(bars, span.to));

class FineSeries {
  history: History | null = null;
  latest: "loading" | "ready" | "failed" = "loading";
  older: "idle" | "loading" | "failed" = "idle";
  pages = 0;
  readonly feed: BarFeed;

  constructor(
    public from: UnixSeconds,
    key: SeriesKey,
    fetchPage: FetchPage,
    socket: Pick<MarketSocketLike, "subscribe"> | undefined,
    changed: (series: FineSeries) => void,
  ) {
    this.feed = new BarFeed(
      fetchPage,
      {
        reset: (h) => {
          this.history = h;
          this.latest = "ready";
          this.older = "idle";
          this.pages = 0;
          changed(this);
        },
        prepended: (h) => {
          this.history = h;
          this.older = "idle";
          changed(this);
        },
        failed: () => {
          this.history = null;
          this.latest = "failed";
          changed(this);
        },
        olderFailed: () => {
          this.older = "failed";
          changed(this);
        },
        live: (h) => {
          this.history = h;
          changed(this);
        },
        confirmed: (h) => {
          this.history = h;
          changed(this);
        },
        subError: () => {},
      },
      socket,
    );
    this.feed.open(key);
  }

  reachedFrom(): boolean {
    return this.history !== null && reaches(this.history, this.from);
  }

  retry(): void {
    if (this.latest === "failed") {
      this.latest = "loading";
      this.feed.reload();
    }
    if (this.older === "failed") this.older = "idle";
  }

  pull(): void {
    if (this.latest !== "ready" || this.older !== "idle" || this.reachedFrom() || this.pages >= MAX_FINE_PAGES) return;
    this.pages++;
    this.older = "loading";
    this.feed.retryOlder();
  }
}

export class FineBars implements FineBarsReader {
  private key: SeriesKey | null = null;
  private readonly series = new Map<FinePeriod, FineSeries>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly fetchPage: FetchPage,
    private readonly socket?: Pick<MarketSocketLike, "subscribe">,
    private readonly now: () => UnixSeconds = nowSeconds,
  ) {}

  open(key: SeriesKey): void {
    this.closeAll();
    this.key = key;
  }

  demand(spans: readonly FineSpan[]): void {
    const key = this.key;
    if (!key) return;
    const now = this.now();
    const earliest = new Map<FinePeriod, UnixSeconds>();
    for (const span of spans) {
      const choice = chooseFinePeriod(key.period, span.from, now);
      if (choice.kind === "none") continue;
      const held = earliest.get(choice.period);
      if (held === undefined || span.from < held) earliest.set(choice.period, span.from);
    }
    for (const [period, series] of this.series) {
      if (earliest.has(period)) continue;
      series.feed.dispose();
      this.series.delete(period);
    }
    for (const [period, from] of earliest) {
      const series = this.series.get(period);
      if (!series) {
        this.series.set(period, new FineSeries(from, { ...key, period }, this.fetchPage, this.socket, (s) => this.changed(s)));
        continue;
      }
      if (series.from === from) continue;
      series.from = from;
      series.retry();
      series.pull();
    }
  }

  read(span: FineSpan): FineBarsRead {
    const key = this.key;
    if (!key) return LOADING;
    const choice = chooseFinePeriod(key.period, span.from, this.now());
    if (choice.kind === "none") return choice;
    const series = this.series.get(choice.period);
    if (!series) return LOADING;
    if (series.history && reaches(series.history, span.from)) return { kind: "ready", period: choice.period, bars: within(displayBars(series.history), span) };
    if (series.latest === "failed" || series.older === "failed") return FAILED;
    if (series.older === "idle" && series.pages >= MAX_FINE_PAGES) return OVER_LIMIT;
    return LOADING;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.closeAll();
    this.key = null;
    this.listeners.clear();
  }

  private closeAll(): void {
    for (const series of this.series.values()) series.feed.dispose();
    this.series.clear();
  }

  private changed(series: FineSeries): void {
    series.pull();
    for (const listener of this.listeners) listener();
  }
}
