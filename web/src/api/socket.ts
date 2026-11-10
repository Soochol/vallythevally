import type { SeriesKey } from "./bars";
import type { ClientMessage } from "./generated/ClientMessage";
import type { ConnectionStatus } from "./generated/ConnectionStatus";
import type { ServerMessage } from "./generated/ServerMessage";
import type { SymbolCode } from "./generated/SymbolCode";

/** 구독 하나에 오는 메시지. `resync`는 서버와 다시 연결되어 칸을 처음부터 만들어야 한다는 뜻이다(backend.md §8.3의 6). */
export type SubEvent =
  | Extract<ServerMessage, { type: "subscribed" | "bar" | "confirmed" | "reload" | "sub_error" }>
  | { type: "resync" };

/** 관심종목 현재가 쪽 메시지. `resync`는 새 연결이라 서버의 `watch_limited`가 빈 상태부터 다시 온다는 뜻이다. */
export type QuoteEvent = Extract<ServerMessage, { type: "quotes" | "watch_limited" }> | { type: "resync" };

/** 브라우저↔서버 연결. `open`은 `hello`를 받은 뒤다. */
export type Connection = { socket: "connecting" | "closed" } | { socket: "open"; status: ConnectionStatus };

export interface MarketSocketLike {
  subscribe(key: SeriesKey, handler: (m: SubEvent) => void): () => void;
  /** 지금 연결 상태로 한 번 부르고, 바뀔 때마다 부른다. */
  watch(listener: (c: Connection) => void): () => void;
  /** 지금 보이는 관심종목 전체, 위에서부터. 마지막 것을 기억해 새 `hello`마다 다시 보낸다. */
  setWatch(symbols: readonly SymbolCode[]): void;
  onQuotes(handler: (e: QuoteEvent) => void): () => void;
}

export interface Transport {
  send(text: string): void;
  close(): void;
}

export interface TransportEvents {
  message(text: string): void;
  close(): void;
}

export type Connect = (url: string, on: TransportEvents) => Transport;

export const browserConnect: Connect = (url, on) => {
  const ws = new WebSocket(url);
  ws.onmessage = (e) => {
    if (typeof e.data === "string") on.message(e.data);
  };
  ws.onclose = () => on.close();
  return { send: (text) => ws.send(text), close: () => ws.close() };
};

export const RECONNECT_DELAYS_S = [1, 2, 5, 10] as const;

export function sameOriginWsUrl(loc: Pick<Location, "protocol" | "host">): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/api/ws`;
}

function parseServerMessage(text: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") return null;
  return value as ServerMessage;
}

interface Subscription {
  key: SeriesKey;
  handler: (m: SubEvent) => void;
}

/** 탭 하나에 WebSocket 하나(`/api/ws`). 끊기면 다시 붙고, 새 `hello`마다 모든 구독을 다시 보낸다. */
export class MarketSocket implements MarketSocketLike {
  private transport: Transport | null = null;
  private running = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextSub = 1;
  private connection: Connection = { socket: "connecting" };
  private readonly subs = new Map<string, Subscription>();
  private readonly watchers = new Set<(c: Connection) => void>();
  private watchSymbols: SymbolCode[] = [];
  private readonly quoteHandlers = new Set<(e: QuoteEvent) => void>();

  constructor(private readonly opts: { url: () => string; connect?: Connect }) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const t = this.transport;
    this.transport = null;
    t?.close();
    this.setConnection({ socket: "closed" });
  }

  subscribe(key: SeriesKey, handler: (m: SubEvent) => void): () => void {
    const sub = `s${this.nextSub++}`;
    this.subs.set(sub, { key, handler });
    if (this.connection.socket === "open") this.sendSubscribe(sub, key);
    return () => {
      if (this.subs.delete(sub) && this.connection.socket === "open") this.send({ type: "unsubscribe", sub });
    };
  }

  watch(listener: (c: Connection) => void): () => void {
    this.watchers.add(listener);
    listener(this.connection);
    return () => this.watchers.delete(listener);
  }

  setWatch(symbols: readonly SymbolCode[]): void {
    this.watchSymbols = [...symbols];
    if (this.connection.socket === "open") this.sendWatch();
  }

  onQuotes(handler: (e: QuoteEvent) => void): () => void {
    this.quoteHandlers.add(handler);
    return () => this.quoteHandlers.delete(handler);
  }

  private connect(): void {
    this.timer = null;
    const transport = (this.opts.connect ?? browserConnect)(this.opts.url(), {
      message: (text) => {
        if (this.transport === transport) this.onMessage(text);
      },
      close: () => {
        if (this.transport === transport) this.onClose();
      },
    });
    this.transport = transport;
  }

  private onClose(): void {
    this.transport = null;
    this.setConnection({ socket: "closed" });
    if (!this.running) return;
    const delay = RECONNECT_DELAYS_S[Math.min(this.attempt, RECONNECT_DELAYS_S.length - 1)]!;
    this.attempt++;
    this.timer = setTimeout(() => this.connect(), delay * 1000);
  }

  private onMessage(text: string): void {
    const m = parseServerMessage(text);
    if (!m) return;
    switch (m.type) {
      case "hello":
        return this.onHello(m.status);
      case "status":
        if (this.connection.socket === "open") this.setConnection({ socket: "open", status: m.status });
        return;
      case "subscribed":
      case "sub_error":
      case "bar":
      case "confirmed":
      case "reload":
        this.subs.get(m.sub)?.handler(m);
        return;
      case "quotes":
      case "watch_limited":
        return this.emitQuotes(m);
      default:
        return;
    }
  }

  private onHello(status: ConnectionStatus): void {
    this.attempt = 0;
    this.setConnection({ socket: "open", status });
    const subs = [...this.subs];
    for (const [sub, { key }] of subs) this.sendSubscribe(sub, key);
    for (const [sub, { handler }] of subs) if (this.subs.has(sub)) handler({ type: "resync" });
    if (this.watchSymbols.length > 0) this.sendWatch();
    this.emitQuotes({ type: "resync" });
  }

  private sendWatch(): void {
    this.send({ type: "watch", symbols: this.watchSymbols });
  }

  private emitQuotes(e: QuoteEvent): void {
    for (const h of this.quoteHandlers) h(e);
  }

  private sendSubscribe(sub: string, key: SeriesKey): void {
    this.send({ type: "subscribe", sub, symbol: key.symbol, venue: key.venue, period: key.period });
  }

  private send(m: ClientMessage): void {
    this.transport?.send(JSON.stringify(m));
  }

  private setConnection(c: Connection): void {
    this.connection = c;
    for (const w of this.watchers) w(c);
  }
}
