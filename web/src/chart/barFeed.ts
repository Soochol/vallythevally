import type { BarsQuery } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { BarsPage } from "../api/generated/BarsPage";
import type { Period } from "../api/generated/Period";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { ApiRequestError } from "../api/http";

/** 칸 하나가 지금 가진 봉. bars는 확정 봉(t 오름차순), current는 진행 중 구간의 봉. */
export interface History {
  bars: Bar[];
  current: Bar | null;
  nextBefore: UnixSeconds | null;
}

export function historyFromLatest(page: BarsPage): History {
  return { bars: page.bars, current: page.current, nextBefore: page.nextBefore };
}

/**
 * 과거 페이지를 앞에 붙인다. 이미 가진 첫 봉보다 이른 봉만 받는다.
 * 이미 가진 봉과 같거나 늦은 t는 덮어쓰지 않는다(D1).
 */
export function prependOlder(h: History, page: BarsPage): { history: History; added: number } {
  const first = h.bars[0] ?? h.current;
  const older = first ? page.bars.filter((b) => b.t < first.t) : page.bars;
  return {
    history: { bars: older.concat(h.bars), current: h.current, nextBefore: page.nextBefore },
    added: older.length,
  };
}

/** 차트에 넘길 봉 열: 확정 봉 뒤에 현재 봉. */
export function displayBars(h: History): Bar[] {
  const last = h.bars[h.bars.length - 1];
  if (!h.current) return h.bars;
  if (last && h.current.t <= last.t) return h.bars;
  return h.bars.concat(h.current);
}

export type FetchPage = (q: BarsQuery, signal: AbortSignal) => Promise<BarsPage>;

export interface FeedListener {
  /** 새 세대의 최신 페이지가 왔다. */
  reset(history: History): void;
  /** 과거 페이지를 앞에 붙였다. added는 실제로 붙은 봉 수. */
  prepended(history: History, added: number): void;
  /** 최신 페이지를 받지 못했다. */
  failed(error: ApiRequestError): void;
}

/**
 * 칸 하나의 봉 받기. 종목·봉 주기를 열 때마다 세대를 올리고, 이전 세대의 응답은 버린다(D1).
 * 과거 페이지는 한 번에 하나만 받는다.
 */
export class BarFeed {
  private generation = 0;
  private key: { symbol: SymbolCode; period: Period } | null = null;
  private history: History | null = null;
  private olderInFlight = false;
  private abort = new AbortController();

  constructor(
    private readonly fetchPage: FetchPage,
    private readonly listener: FeedListener,
  ) {}

  open(symbol: SymbolCode, period: Period): void {
    this.key = { symbol, period };
    this.reload();
  }

  /** 같은 종목·봉 주기를 처음부터 다시 받는다. */
  reload(): void {
    const key = this.key;
    if (!key) return;
    this.abort.abort();
    this.abort = new AbortController();
    const gen = ++this.generation;
    this.history = null;
    this.olderInFlight = false;
    this.fetchPage(key, this.abort.signal).then(
      (page) => {
        if (gen !== this.generation) return;
        this.history = historyFromLatest(page);
        this.listener.reset(this.history);
      },
      (e: unknown) => {
        if (gen !== this.generation) return;
        this.listener.failed(e instanceof ApiRequestError ? e : new ApiRequestError("internal", String(e)));
      },
    );
  }

  /** 왼쪽 끝이 가까워졌다. 받을 수 있으면 과거 페이지 하나를 받는다. */
  needOlder(): void {
    const { key, history } = this;
    if (!key || !history || history.nextBefore === null || this.olderInFlight) return;
    const gen = this.generation;
    this.olderInFlight = true;
    this.fetchPage({ ...key, before: history.nextBefore }, this.abort.signal).then(
      (page) => {
        if (gen !== this.generation || !this.history) return;
        this.olderInFlight = false;
        const { history: next, added } = prependOlder(this.history, page);
        this.history = next;
        this.listener.prepended(next, added);
      },
      () => {
        // 과거 페이지 실패는 다음 스크롤에서 다시 시도한다.
        if (gen === this.generation) this.olderInFlight = false;
      },
    );
  }

  dispose(): void {
    this.generation++;
    this.key = null;
    this.history = null;
    this.abort.abort();
  }
}
