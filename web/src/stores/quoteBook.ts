import type { Quote } from "../api/generated/Quote";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { Venue } from "../api/generated/Venue";
import { retryDelay, shouldRetry } from "../api/retry";
import type { Connection, MarketSocketLike, QuoteEvent } from "../api/socket";

/** 관심종목 한 줄의 값. `limited`는 서버가 실시간 자리를 주지 못한 종목이다. */
export interface WatchQuote {
  readonly quote: Quote | undefined;
  readonly limited: boolean;
  readonly stale: boolean;
}

const EMPTY: WatchQuote = { quote: undefined, limited: false, stale: false };

export interface LeaseOptions {
  readonly front?: boolean;
}

interface Lease {
  readonly symbols: readonly SymbolCode[];
  readonly front: boolean;
}

type FetchQuotes = (symbols: readonly SymbolCode[], venue: Venue) => Promise<Quote[]>;

const isLiveConnection = (connection: Connection): boolean =>
  connection.socket === "open" && connection.status.realtime === "live";

function union(lists: Iterable<readonly SymbolCode[]>): SymbolCode[] {
  const seen = new Set<SymbolCode>();
  for (const list of lists) for (const code of list) seen.add(code);
  return [...seen];
}

const sameOrder = (a: readonly SymbolCode[], b: readonly SymbolCode[]) => a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * 보이는 관심종목 목록들의 현재가. 값은 실시간 `quotes`로 바뀌고, REST는 종목이 목록에 처음 들어올 때나 거래소가 바뀔 때 부른다.
 * 줄마다 같은 상태면 같은 객체를 돌려준다(`useSyncExternalStore`).
 */
export class QuoteBook {
  private readonly leases = new Set<Lease>();
  private venue: Venue = "combined";
  private watched: readonly SymbolCode[] = [];
  private frontSymbols = new Set<SymbolCode>();
  private entries = new Map<SymbolCode, number>();
  private lastEntry = 0;
  // 서버는 이 집합이 바뀔 때만 다시 보낸다. 줄이 빠졌다 들어와도 서버가 새로 알리기 전까지는 이 값이 맞다.
  private serverLimited = new Set<SymbolCode>();
  private readonly rows = new Map<SymbolCode, WatchQuote>();
  private readonly listeners = new Map<SymbolCode, Set<() => void>>();
  private scheduled = false;
  private live = true;

  constructor(private readonly deps: { socket: Pick<MarketSocketLike, "setWatch" | "onQuotes"> & Partial<Pick<MarketSocketLike, "watch">>; fetchQuotes: FetchQuotes }) {
    deps.socket.onQuotes((e) => this.onEvent(e));
    deps.socket.watch?.((c) => this.onConnection(c));
  }

  lease(symbols: readonly SymbolCode[], options?: LeaseOptions): () => void {
    const lease: Lease = { symbols, front: options?.front === true };
    this.leases.add(lease);
    this.schedule();
    return () => {
      if (this.leases.delete(lease)) this.schedule();
    };
  }

  setVenue(venue: Venue): void {
    if (venue === this.venue) return;
    this.venue = venue;
    this.entries = new Map(this.watched.map((c) => [c, ++this.lastEntry]));
    for (const code of this.watched) if (this.rows.delete(code)) this.notify(code);
    if (this.watched.length === 0) return;
    this.deps.socket.setWatch(this.watched, venue);
    for (const code of this.watched) if (this.serverLimited.has(code)) this.setLimited(code, true);
    void this.load(this.watched, 0, false);
  }

  get(code: SymbolCode): WatchQuote {
    return this.rows.get(code) ?? EMPTY;
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

  // React는 목록이 바뀌면 옛 lease를 풀고 새 lease를 같은 틱에 잡는다. 한 번에 합쳐야 순서 바꾸기가 빠짐+들어옴(REST)이 되지 않는다.
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.reconcile());
  }

  private orderedLists(): { lists: readonly (readonly SymbolCode[])[]; front: Set<SymbolCode> } {
    const frontLists: (readonly SymbolCode[])[] = [];
    const normalLists: (readonly SymbolCode[])[] = [];
    const front = new Set<SymbolCode>();
    for (const lease of this.leases) {
      if (lease.front) {
        frontLists.push(lease.symbols);
        for (const code of lease.symbols) front.add(code);
      } else {
        normalLists.push(lease.symbols);
      }
    }
    return { lists: [...frontLists, ...normalLists], front };
  }

  private reconcile(): void {
    this.scheduled = false;
    const { lists, front } = this.orderedLists();
    const prevFront = this.frontSymbols;
    this.frontSymbols = front;
    const next = union(lists);
    const newlyFrontStale = this.live
      ? next.filter((c) => front.has(c) && !prevFront.has(c) && this.entries.has(c) && this.get(c).stale && !this.get(c).limited)
      : [];
    if (sameOrder(next, this.watched)) {
      if (newlyFrontStale.length > 0) this.refresh(newlyFrontStale);
      return;
    }
    const before = this.entries;
    this.watched = next;
    this.entries = new Map(next.map((c) => [c, before.get(c) ?? ++this.lastEntry]));
    for (const code of before.keys()) if (!this.entries.has(code) && this.rows.delete(code)) this.notify(code);
    this.deps.socket.setWatch(next, this.venue);
    const added = next.filter((c) => !before.has(c));
    for (const code of added) if (this.serverLimited.has(code)) this.setLimited(code, true);
    if (added.length > 0) void this.load(added, 0, false);
    if (newlyFrontStale.length > 0) this.refresh(newlyFrontStale);
  }

  private refresh(symbols: readonly SymbolCode[]): void {
    for (const code of symbols) this.entries.set(code, ++this.lastEntry);
    void this.load(symbols, 0, true);
  }

  private async load(symbols: readonly SymbolCode[], failures: number, acceptStale: boolean): Promise<void> {
    const venue = this.venue;
    const asked = new Map(symbols.map((c) => [c, this.entries.get(c)] as const));
    const sameEntry = (c: SymbolCode) => asked.has(c) && asked.get(c) === this.entries.get(c);
    const needsQuote = (c: SymbolCode) => {
      const row = this.get(c);
      return row.quote === undefined || (acceptStale && row.stale);
    };
    let quotes: Quote[];
    try {
      quotes = await this.deps.fetchQuotes(symbols, venue);
    } catch (e) {
      if (!shouldRetry(failures, e)) return;
      setTimeout(() => {
        const missing = symbols.filter((c) => sameEntry(c) && needsQuote(c));
        if (missing.length > 0) void this.load(missing, failures + 1, acceptStale);
      }, retryDelay(failures, e));
      return;
    }
    for (const q of quotes) {
      if (!sameEntry(q.symbol) || !needsQuote(q.symbol)) continue;
      const row = this.get(q.symbol);
      this.put(q.symbol, { quote: q, limited: row.limited, stale: !this.live || row.limited });
    }
  }

  private onConnection(connection: Connection): void {
    const nextLive = isLiveConnection(connection);
    if (nextLive === this.live) return;
    this.live = nextLive;
    if (!nextLive) {
      for (const code of this.watched) {
        const row = this.rows.get(code);
        if (row !== undefined && !row.stale) this.put(code, { quote: row.quote, limited: row.limited, stale: true });
      }
      return;
    }
    const toRefresh: SymbolCode[] = [];
    for (const code of this.watched) {
      if (!this.frontSymbols.has(code)) continue;
      const row = this.rows.get(code);
      if (row !== undefined && row.stale && !row.limited) toRefresh.push(code);
    }
    if (toRefresh.length > 0) this.refresh(toRefresh);
  }

  private onEvent(e: QuoteEvent): void {
    switch (e.type) {
      case "quotes":
        if (e.venue !== this.venue) return;
        for (const q of e.quotes) {
          if (!this.entries.has(q.symbol)) continue;
          const row = this.get(q.symbol);
          const quote = q.source === "expected" && row.quote ? { ...q, volume: row.quote.volume } : q;
          this.put(q.symbol, { quote, limited: row.limited, stale: !this.live || row.limited });
        }
        return;
      case "watch_limited": {
        this.serverLimited = new Set(e.symbols);
        const recovered: SymbolCode[] = [];
        for (const code of this.watched) {
          const limited = this.serverLimited.has(code);
          const wasLimited = this.get(code).limited;
          this.setLimited(code, limited);
          if (wasLimited && !limited && this.live && this.frontSymbols.has(code)) recovered.push(code);
        }
        if (recovered.length > 0) this.refresh(recovered);
        return;
      }
      case "resync": {
        this.serverLimited = new Set();
        const recovered: SymbolCode[] = [];
        for (const code of this.watched) {
          const row = this.rows.get(code);
          if (row === undefined) continue;
          const changed = row.limited || !row.stale;
          if (!changed) continue;
          this.put(code, { quote: row.quote, limited: false, stale: true });
          if (this.live && this.frontSymbols.has(code)) recovered.push(code);
        }
        if (recovered.length > 0) this.refresh(recovered);
        return;
      }
    }
  }

  private setLimited(code: SymbolCode, limited: boolean): void {
    const row = this.get(code);
    const stale = limited ? true : row.stale;
    if (row.limited !== limited || row.stale !== stale) this.put(code, { quote: row.quote, limited, stale });
  }

  private put(code: SymbolCode, row: WatchQuote): void {
    this.rows.set(code, row);
    this.notify(code);
  }

  private notify(code: SymbolCode): void {
    for (const l of this.listeners.get(code) ?? []) l();
  }
}
