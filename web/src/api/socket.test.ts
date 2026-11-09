import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SeriesKey } from "./bars";
import type { ClientMessage } from "./generated/ClientMessage";
import type { ConnectionStatus } from "./generated/ConnectionStatus";
import type { ServerMessage } from "./generated/ServerMessage";
import { type Connection, type Connect, MarketSocket, sameOriginWsUrl, type SubEvent, type TransportEvents } from "./socket";

const LIVE: ConnectionStatus = { realtime: "live", since: 1_000, backfilling: false };
const key: SeriesKey = { symbol: "005930", venue: "combined", period: "1m" };

/** 가짜 WebSocket 연결. 연결 시도마다 하나씩 생긴다. */
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
  receive(m: ServerMessage | { type: "quotes"; quotes: [] }) {
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
    last().receive({ type: "quotes", quotes: [] });
    expect(a).toEqual([]);
    expect(b).toEqual([barMsg]);
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

  test("stop하면 연결을 닫고 다시 붙지 않는다", () => {
    const { socket, transports, last } = setup();
    socket.start();
    socket.stop();
    expect(last().closed).toBe(true);
    last().drop();
    vi.advanceTimersByTime(60_000);
    expect(transports).toHaveLength(1);
  });
});
