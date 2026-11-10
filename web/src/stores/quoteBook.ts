import type { Quote } from "../api/generated/Quote";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { retryDelay, shouldRetry } from "../api/retry";
import type { MarketSocketLike, QuoteEvent } from "../api/socket";

/** 관심종목 한 줄의 값. `limited`는 서버가 실시간 자리를 주지 못한 종목이다. */
export interface WatchQuote {
  readonly quote: Quote | undefined;
  readonly limited: boolean;
}

const EMPTY: WatchQuote = { quote: undefined, limited: false };

export type FetchQuotes = (symbols: readonly SymbolCode[]) => Promise<Quote[]>;

function union(lists: Iterable<readonly SymbolCode[]>): SymbolCode[] {
  const seen = new Set<SymbolCode>();
  for (const list of lists) for (const code of list) seen.add(code);
  return [...seen];
}

const sameOrder = (a: readonly SymbolCode[], b: readonly SymbolCode[]) => a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * 보이는 관심종목 목록들의 현재가. 값은 실시간 `quotes`로 바뀌고, REST는 종목이 목록에 처음 들어올 때만 부른다.
 * 줄마다 같은 상태면 같은 객체를 돌려준다(`useSyncExternalStore`).
 */
export class QuoteBook {
  private readonly leases = new Set<{ symbols: readonly SymbolCode[] }>();
  private watched: readonly SymbolCode[] = [];
  private members = new Set<SymbolCode>();
  private readonly rows = new Map<SymbolCode, WatchQuote>();
  private readonly listeners = new Map<SymbolCode, Set<() => void>>();
  private scheduled = false;

  constructor(private readonly deps: { socket: Pick<MarketSocketLike, "setWatch" | "onQuotes">; fetchQuotes: FetchQuotes }) {
    deps.socket.onQuotes((e) => this.onEvent(e));
  }

  /** 보이는 목록 하나가 빌린다. 돌려준 함수로 푼다. */
  lease(symbols: readonly SymbolCode[]): () => void {
    const lease = { symbols };
    this.leases.add(lease);
    this.schedule();
    return () => {
      if (this.leases.delete(lease)) this.schedule();
    };
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

  private reconcile(): void {
    this.scheduled = false;
    const next = union([...this.leases].map((l) => l.symbols));
    if (sameOrder(next, this.watched)) return;
    const before = this.members;
    this.watched = next;
    this.members = new Set(next);
    for (const code of before) if (!this.members.has(code) && this.rows.delete(code)) this.notify(code);
    this.deps.socket.setWatch(next);
    const added = next.filter((c) => !before.has(c));
    if (added.length > 0) void this.load(added, 0);
  }

  private async load(symbols: readonly SymbolCode[], failures: number): Promise<void> {
    let quotes: Quote[];
    try {
      quotes = await this.deps.fetchQuotes(symbols);
    } catch (e) {
      if (!shouldRetry(failures, e)) return;
      setTimeout(() => {
        const missing = symbols.filter((c) => this.members.has(c) && this.get(c).quote === undefined);
        if (missing.length > 0) void this.load(missing, failures + 1);
      }, retryDelay(failures, e));
      return;
    }
    for (const q of quotes) {
      const row = this.get(q.symbol);
      if (this.members.has(q.symbol) && row.quote === undefined) this.put(q.symbol, { quote: q, limited: row.limited });
    }
  }

  private onEvent(e: QuoteEvent): void {
    switch (e.type) {
      case "quotes":
        for (const q of e.quotes) if (this.members.has(q.symbol)) this.put(q.symbol, { quote: q, limited: this.get(q.symbol).limited });
        return;
      case "watch_limited": {
        const limited = new Set(e.symbols);
        for (const code of this.watched) this.setLimited(code, limited.has(code));
        return;
      }
      case "resync":
        for (const code of this.watched) this.setLimited(code, false);
        return;
    }
  }

  private setLimited(code: SymbolCode, limited: boolean): void {
    const row = this.get(code);
    if (row.limited !== limited) this.put(code, { quote: row.quote, limited });
  }

  private put(code: SymbolCode, row: WatchQuote): void {
    this.rows.set(code, row);
    this.notify(code);
  }

  private notify(code: SymbolCode): void {
    for (const l of this.listeners.get(code) ?? []) l();
  }
}
