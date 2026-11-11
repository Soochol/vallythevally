import type { BarsQuery, SeriesKey } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { BarsPage } from "../api/generated/BarsPage";
import type { SubErrorCode } from "../api/generated/SubErrorCode";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { ApiRequestError } from "../api/http";
import type { MarketSocketLike, SubEvent } from "../api/socket";

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

function newestT(h: History): UnixSeconds | null {
  const last = h.bars[h.bars.length - 1];
  if (!last) return h.current?.t ?? null;
  return h.current && h.current.t > last.t ? h.current.t : last.t;
}

/** 가진 봉보다 이른 봉. Lightweight Charts의 `update()`는 이른 시각을 받으면 예외를 던진다. */
function isOlderThanHeld(h: History, b: Bar): boolean {
  const newest = newestT(h);
  return newest !== null && b.t < newest;
}

function replaceLast(bars: Bar[], b: Bar): Bar[] {
  return bars.slice(0, -1).concat(b);
}

function withLive(h: History, b: Bar): History {
  const last = h.bars[h.bars.length - 1];
  if (last?.t === b.t) return { ...h, bars: replaceLast(h.bars, b), current: h.current && h.current.t <= b.t ? null : h.current };
  return { ...h, current: b };
}

function withConfirmed(h: History, b: Bar): History {
  const last = h.bars[h.bars.length - 1];
  const bars = last?.t === b.t ? replaceLast(h.bars, b) : h.bars.concat(b);
  return { ...h, bars, current: h.current && h.current.t <= b.t ? null : h.current };
}

export type FetchPage = (q: BarsQuery, signal: AbortSignal) => Promise<BarsPage>;

export interface FeedListener {
  /** 새 세대의 최신 페이지가 왔다. */
  reset(history: History): void;
  /** 과거 페이지를 앞에 붙였다. added는 실제로 붙은 봉 수. */
  prepended(history: History, added: number): void;
  /** 최신 페이지를 받지 못했다. */
  failed(error: ApiRequestError): void;
  /** 과거 페이지를 받지 못했다. 가진 봉은 그대로다. `retryOlder`나 다시 열기 전까지 과거 페이지를 받지 않는다. */
  olderFailed(error: ApiRequestError): void;
  olderLoading?(): void;
  /** 실시간으로 현재 봉이 바뀌었다. bar의 t는 가진 봉의 마지막 t보다 이르지 않다. */
  live(history: History, bar: Bar): void;
  confirmed(history: History, bar: Bar): void;
  /** 구독이 거절되었다. 나중에 `subscribed`가 오면 null로 다시 부른다. */
  subError(code: SubErrorCode | null): void;
}

type StreamMessage = Extract<SubEvent, { seq: number }>;

/**
 * 칸 하나의 봉 받기. 종목·거래소·봉 주기를 열 때마다 세대를 올리고, 이전 세대의 응답은 버린다(D1).
 * 과거 페이지는 한 번에 하나만 받는다. 실패하면 스크롤로 다시 보내지 않는다.
 * HTTP와 WebSocket은 다른 연결이라 페이지보다 옛 메시지가 페이지 뒤에 올 수 있다.
 */
export class BarFeed {
  private generation = 0;
  private key: SeriesKey | null = null;
  private history: History | null = null;
  private buffer: StreamMessage[] | null = null;
  private seqFloor: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private olderInFlight = false;
  private olderFailed = false;
  private abort = new AbortController();

  constructor(
    private readonly fetchPage: FetchPage,
    private readonly listener: FeedListener,
    private readonly socket?: Pick<MarketSocketLike, "subscribe">,
  ) {}

  open(key: SeriesKey): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.key = key;
    this.reload();
  }

  /** 같은 봉 열을 처음부터 다시 받는다. 구독은 그대로 둔다. */
  reload(): void {
    const key = this.key;
    if (!key) return;
    this.abort.abort();
    this.abort = new AbortController();
    const gen = ++this.generation;
    this.history = null;
    this.buffer = [];
    this.seqFloor = null;
    this.olderInFlight = false;
    this.olderFailed = false;
    if (this.socket && !this.unsubscribe) this.unsubscribe = this.socket.subscribe(key, (m) => this.onSocket(m));
    this.fetchPage(key, this.abort.signal).then(
      (page) => {
        if (gen !== this.generation) return;
        const buffered = this.buffer ?? [];
        this.buffer = null;
        this.history = historyFromLatest(page);
        this.seqFloor = page.seq;
        this.listener.reset(this.history);
        for (const m of buffered) {
          this.applyStream(m);
          if (gen !== this.generation) return;
        }
      },
      (e: unknown) => {
        if (gen !== this.generation) return;
        this.buffer = null;
        this.listener.failed(e instanceof ApiRequestError ? e : new ApiRequestError("internal", String(e)));
      },
    );
  }

  /** 왼쪽 끝이 가까워졌다. 받을 수 있으면 과거 페이지 하나를 받는다. */
  needOlder(): void {
    const { key, history } = this;
    if (!key || !history || history.nextBefore === null || this.olderInFlight || this.olderFailed) return;
    const gen = this.generation;
    this.olderInFlight = true;
    this.listener.olderLoading?.();
    this.fetchPage({ ...key, before: history.nextBefore }, this.abort.signal).then(
      (page) => {
        if (gen !== this.generation || !this.history) return;
        this.olderInFlight = false;
        const { history: next, added } = prependOlder(this.history, page);
        this.history = next;
        this.listener.prepended(next, added);
      },
      (e: unknown) => {
        if (gen !== this.generation) return;
        this.olderInFlight = false;
        this.olderFailed = true;
        this.listener.olderFailed(e instanceof ApiRequestError ? e : new ApiRequestError("internal", String(e)));
      },
    );
  }

  /** 실패한 과거 페이지를 다시 받는다(`다시 시도`). */
  retryOlder(): void {
    this.olderFailed = false;
    this.needOlder();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.generation++;
    this.key = null;
    this.history = null;
    this.buffer = null;
    this.abort.abort();
  }

  private onSocket(m: SubEvent): void {
    switch (m.type) {
      case "resync":
        return this.reload();
      case "sub_error":
        return this.listener.subError(m.code);
      case "subscribed":
        this.listener.subError(null);
        return this.receive(m);
      case "bar":
      case "confirmed":
      case "reload":
        return this.receive(m);
      default: {
        const _exhaustive: never = m;
        return _exhaustive;
      }
    }
  }

  private receive(m: StreamMessage): void {
    if (this.buffer) this.buffer.push(m);
    else if (this.history) this.applyStream(m);
  }

  private applyStream(m: StreamMessage): void {
    const h = this.history;
    if (!h) return;
    if (this.seqFloor !== null && m.seq <= this.seqFloor) return;
    switch (m.type) {
      case "reload":
        return this.reload();
      case "subscribed":
        if (m.current) this.applyLive(h, m.current);
        return;
      case "bar":
        return this.applyLive(h, m.bar);
      case "confirmed": {
        if (isOlderThanHeld(h, m.bar)) return;
        this.history = withConfirmed(h, m.bar);
        return this.listener.confirmed(this.history, m.bar);
      }
      default: {
        const _exhaustive: never = m;
        return _exhaustive;
      }
    }
  }

  private applyLive(h: History, b: Bar): void {
    if (isOlderThanHeld(h, b)) return;
    this.history = withLive(h, b);
    this.listener.live(this.history, b);
  }
}
