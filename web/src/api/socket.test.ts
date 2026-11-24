import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SeriesKey } from "./bars";
import type { ClientMessage } from "./generated/ClientMessage";
import type { ConnectionStatus } from "./generated/ConnectionStatus";
import type { ServerMessage } from "./generated/ServerMessage";
import type { Quote } from "./generated/Quote";
import { type Connection, type Connect, type FeedEvent, MarketSocket, type QuoteEvent, sameOriginWsUrl, type SubEvent, type TransportEvents } from "./socket";

const LIVE: ConnectionStatus = { realtime: "live", since: 1_000, backfilling: false };
const key: SeriesKey = { symbol: "005930", venue: "combined", period: "1m" };

class FakeTransport {
  readonly sent: ClientMessage[] = [];
  closed = false;
  constructor(
    readonly url: string,
    private readonly on: TransportEvents,
  ) {}
  send(text: string) {
    this.sent.push(JSON.parse(text) as ClientMessage);
  }
  close() {
    this.closed = true;
  }
  receive(m: ServerMessage | { type: "data_changed" }) {
    this.on.message(JSON.stringify(m));
  }
  drop() {
    this.on.close();
  }
}

function setup() {
  const transports: FakeTransport[] = [];
  const connect: Connect = (url, on) => {
    const t = new FakeTransport(url, on);
    transports.push(t);
    return t;
  };
  const socket = new MarketSocket({ url: () => "ws://test/api/ws", connect });
  const connections: Connection["socket"][] = [];
  socket.watch((c) => connections.push(c.socket));
  const last = () => transports[transports.length - 1]!;
  return { socket, transports, last, connections };
}

const hello = (status = LIVE): ServerMessage => ({ type: "hello", protocol: 1, serverTime: 1_000, status });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MarketSocket", () => {
  test("주소는 같은 출처의 /api/ws다", () => {
    expect(sameOriginWsUrl({ protocol: "http:", host: "127.0.0.1:8080" })).toBe("ws://127.0.0.1:8080/api/ws");
    expect(sameOriginWsUrl({ protocol: "https:", host: "vv.example" })).toBe("wss://vv.example/api/ws");
  });

  test("hello를 받으면 쌓인 구독을 보내고 연결 상태를 알린다", () => {
    const { socket, last, connections } = setup();
    socket.start();
    socket.subscribe(key, () => {});
    expect(last().sent).toEqual([]);
    last().receive(hello());
    expect(last().sent).toEqual([{ type: "subscribe", sub: "s1", symbol: "005930", venue: "combined", period: "1m" }]);
    expect(connections).toEqual(["connecting", "open"]);
  });

  test("구독의 메시지만 그 handler로 간다. 모르는 메시지는 버린다", () => {
    const { socket, last } = setup();
    socket.start();
    last().receive(hello());
    const a: SubEvent[] = [];
    const b: SubEvent[] = [];
    socket.subscribe(key, (m) => a.push(m));
    socket.subscribe({ ...key, period: "D" }, (m) => b.push(m));
    const barMsg: ServerMessage = { type: "bar", sub: "s2", seq: 1, bar: { t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 } };
    last().receive(barMsg);
    last().receive({ type: "data_changed" });
    last().receive({ type: "vi_snapshot", states: [] });
    last().receive({ type: "vi_update", state: { symbol: "005930", active: true, direction: "up", triggerPrice: 881_000, base: 800_000, triggeredAt: 1_000, releasedAt: null } });
    expect(a).toEqual([]);
    expect(b).toEqual([barMsg]);
  });

  test("collector_daemon 프레임은 판단과 시각을 onCollectorDaemon으로 알린다", () => {
    const transports: FakeTransport[] = [];
    const heard: [string, number][] = [];
    const socket = new MarketSocket({ url: () => "ws://test/api/ws", connect: (url, on) => { const t = new FakeTransport(url, on); transports.push(t); return t; }, onCollectorDaemon: (judgment, at) => heard.push([judgment, at]) });
    socket.start();
    transports[0]!.receive(hello());
    transports[0]!.receive({ type: "collector_daemon", judgment: "down", at: 1_700_000_000 });
    expect(heard).toEqual([["down", 1_700_000_000]]);
  });

  test("해지하면 unsubscribe를 보낸다", () => {
    const { socket, last } = setup();
    socket.start();
    last().receive(hello());
    const off = socket.subscribe(key, () => {});
    off();
    expect(last().sent.map((m) => m.type)).toEqual(["subscribe", "unsubscribe"]);
  });

  test("끊기면 1, 2, 5, 10, 10초 뒤에 다시 붙는다", () => {
    const { socket, transports, connections } = setup();
    socket.start();
    for (const seconds of [1, 2, 5, 10, 10]) {
      transports[transports.length - 1]!.drop();
      const before = transports.length;
      vi.advanceTimersByTime(seconds * 1000 - 1);
      expect(transports).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(transports).toHaveLength(before + 1);
    }
    expect(connections[1]).toBe("closed");
  });

  test("hello를 받으면 기다림이 다시 1초부터다", () => {
    const { socket, transports, last } = setup();
    socket.start();
    last().drop();
    vi.advanceTimersByTime(1000);
    last().drop();
    vi.advanceTimersByTime(2000);
    last().receive(hello());
    last().drop();
    vi.advanceTimersByTime(1000);
    expect(transports).toHaveLength(4);
  });

  test("다시 연결되어 새 hello가 오면 구독을 다시 보내고 handler마다 resync를 준다", () => {
    const { socket, last } = setup();
    socket.start();
    last().receive(hello());
    const events: SubEvent[] = [];
    socket.subscribe(key, (m) => events.push(m));
    last().drop();
    vi.advanceTimersByTime(1000);
    last().receive(hello({ realtime: "reconnecting", since: 2_000, backfilling: false }));
    expect(last().sent).toEqual([{ type: "subscribe", sub: "s1", symbol: "005930", venue: "combined", period: "1m" }]);
    expect(events).toEqual([{ type: "resync" }]);
  });

  test("연결 전에 생긴 구독도 첫 hello에서 resync를 받는다. 그 페이지는 서버가 구독을 알기 전에 받은 것일 수 있다", () => {
    const { socket, last } = setup();
    socket.start();
    const events: SubEvent[] = [];
    socket.subscribe(key, (m) => events.push(m));
    last().receive(hello());
    expect(events).toEqual([{ type: "resync" }]);
    socket.subscribe({ ...key, period: "D" }, (m) => events.push(m));
    expect(events).toHaveLength(1);
  });

  test("status 메시지는 연결 상태를 바꾼다", () => {
    const { socket, last } = setup();
    socket.start();
    const seen: Connection[] = [];
    socket.watch((c) => seen.push(c));
    last().receive(hello());
    last().receive({ type: "status", status: { realtime: "halted", since: 3_000, backfilling: false } });
    expect(seen[seen.length - 1]).toEqual({ socket: "open", status: { realtime: "halted", since: 3_000, backfilling: false } });
  });

  test("관심종목은 연결 전이면 hello에서, 열려 있으면 바로 보낸다", () => {
    const { socket, last } = setup();
    socket.start();
    socket.setWatch(["005930", "000660"], "combined");
    expect(last().sent).toEqual([]);
    last().receive(hello());
    expect(last().sent).toEqual([{ type: "watch", symbols: ["005930", "000660"], venue: "combined" }]);
    socket.setWatch(["000660"], "combined");
    socket.setWatch([], "combined");
    expect(last().sent.slice(1)).toEqual([
      { type: "watch", symbols: ["000660"], venue: "combined" },
      { type: "watch", symbols: [], venue: "combined" },
    ]);
  });

  test("관심종목 거래소는 watch에 실리고, 거래소만 바꿔 다시 보내며, 다시 연결돼도 마지막 거래소로 보낸다", () => {
    const { socket, last } = setup();
    socket.start();
    last().receive(hello());
    socket.setWatch(["005930"], "krx");
    socket.setWatch(["005930"], "nxt");
    expect(last().sent).toEqual([
      { type: "watch", symbols: ["005930"], venue: "krx" },
      { type: "watch", symbols: ["005930"], venue: "nxt" },
    ]);
    last().drop();
    vi.advanceTimersByTime(1000);
    last().receive(hello());
    expect(last().sent).toEqual([{ type: "watch", symbols: ["005930"], venue: "nxt" }]);
  });

  test("quotes와 watch_limited는 onQuotes로 간다", () => {
    const { socket, last } = setup();
    socket.start();
    last().receive(hello());
    const events: QuoteEvent[] = [];
    socket.onQuotes((e) => events.push(e));
    const quote: Quote = { symbol: "005930", price: 71_000, change: 500, changeRate: 0.71, volume: 10, t: 1_000, source: "realtime", venue: "combined" };
    last().receive({ type: "quotes", venue: "combined", quotes: [quote] });
    last().receive({ type: "watch_limited", symbols: ["000660"] });
    expect(events).toEqual([
      { type: "quotes", venue: "combined", quotes: [quote] },
      { type: "watch_limited", symbols: ["000660"] },
    ]);
  });

  test("다시 연결되면 마지막 관심종목을 다시 보내고 onQuotes에 resync를 준다", () => {
    const { socket, last } = setup();
    socket.start();
    last().receive(hello());
    const events: QuoteEvent[] = [];
    socket.onQuotes((e) => events.push(e));
    socket.setWatch(["005930"], "combined");
    socket.setWatch(["005930", "IDX:001"], "combined");
    last().drop();
    vi.advanceTimersByTime(1000);
    last().receive(hello());
    expect(last().sent).toEqual([{ type: "watch", symbols: ["005930", "IDX:001"], venue: "combined" }]);
    expect(events).toEqual([{ type: "resync" }]);
  });

  test("관심종목을 비운 뒤 다시 연결되면 watch를 보내지 않는다. 새 연결의 서버는 빈 상태로 시작한다", () => {
    const { socket, last } = setup();
    socket.start();
    last().receive(hello());
    socket.setWatch(["005930"], "combined");
    socket.setWatch([], "combined");
    last().drop();
    vi.advanceTimersByTime(1000);
    last().receive(hello());
    expect(last().sent).toEqual([]);
  });

  test("stop하면 연결을 닫고 다시 붙지 않는다", () => {
    const { socket, transports, last } = setup();
    socket.start();
    socket.stop();
    expect(last().closed).toBe(true);
    last().drop();
    vi.advanceTimersByTime(60_000);
    expect(transports).toHaveLength(1);
  });

  test("새 창 흐름 구독은 열려 있으면 바로, 아니면 hello에서 보내고 해지하면 unsubscribe를 보낸다", () => {
    const { socket, last } = setup();
    socket.start();
    const early = socket.subscribeFeed({ symbol: "005930", kind: "book" }, () => {});
    expect(last().sent).toEqual([]);
    last().receive(hello());
    expect(last().sent).toEqual([{ type: "subscribe_feed", sub: "s1", symbol: "005930", kind: "book", venue: null }]);
    const late = socket.subscribeFeed({ symbol: "000660", kind: "trades", venue: "krx" }, () => {});
    expect(last().sent[1]).toEqual({ type: "subscribe_feed", sub: "s2", symbol: "000660", kind: "trades", venue: "krx" });
    early();
    late();
    expect(last().sent.slice(2)).toEqual([
      { type: "unsubscribe", sub: "s1" },
      { type: "unsubscribe", sub: "s2" },
    ]);
  });

  test("흐름 메시지는 그 구독의 handler로만 가고 봉 구독과 섞이지 않는다", () => {
    const { socket, last } = setup();
    socket.start();
    last().receive(hello());
    const feed: FeedEvent[] = [];
    const bars: SubEvent[] = [];
    socket.subscribeFeed({ symbol: "005930", kind: "trades" }, (m) => feed.push(m));
    socket.subscribe(key, (m) => bars.push(m));
    const trades: ServerMessage = { type: "feed_trades", sub: "s1", seq: 1, trades: [{ t: 1, price: 100, qty: -3, venue: "krx", strength: null }] };
    last().receive({ type: "feed_subscribed", sub: "s1", kind: "trades" });
    last().receive(trades);
    last().receive({ type: "sub_error", sub: "s1", code: "realtime_limit" });
    last().receive({ type: "sub_error", sub: "s2", code: "unknown_symbol" });
    expect(feed.map((m) => m.type)).toEqual(["feed_subscribed", "feed_trades", "sub_error"]);
    expect(bars.map((m) => m.type)).toEqual(["sub_error"]);
  });

  test("다시 연결되어 새 hello가 오면 새 창 구독을 다시 보내고 resync를 준다", () => {
    const { socket, transports, last } = setup();
    socket.start();
    last().receive(hello());
    const feed: FeedEvent[] = [];
    socket.subscribeFeed({ symbol: "005930", kind: "brokers" }, (m) => feed.push(m));
    last().drop();
    vi.advanceTimersByTime(1000);
    expect(transports).toHaveLength(2);
    last().receive(hello());
    expect(last().sent).toEqual([{ type: "subscribe_feed", sub: "s1", symbol: "005930", kind: "brokers", venue: null }]);
    expect(feed).toEqual([{ type: "resync" }]);
  });

  test("연결이 닫혀 있을 때 해지한 새 창 구독은 다시 연결돼도 보내지 않는다", () => {
    const { socket, transports, last } = setup();
    socket.start();
    last().receive(hello());
    const off = socket.subscribeFeed({ symbol: "005930", kind: "program" }, () => {});
    last().drop();
    off();
    vi.advanceTimersByTime(1000);
    expect(transports).toHaveLength(2);
    last().receive(hello());
    expect(last().sent).toEqual([]);
  });
});
