import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ServerMessage } from "../api/generated/ServerMessage";
import type { ViState } from "../api/generated/ViState";
import { type Connect, MarketSocket, type TransportEvents } from "../api/socket";
import { ViBook } from "./viBook";

const SAMSUNG = "005930";
const HYNIX = "000660";
const KAKAO = "035720";
const HELLO: ServerMessage = { type: "hello", protocol: 1, serverTime: 1_000, status: { realtime: "live", since: 1_000, backfilling: false } };

const firing = (symbol: string, patch: Partial<ViState> = {}): ViState => ({ symbol, market: "krx", active: true, direction: "up", triggerPrice: 881_000, base: 800_000, triggeredAt: 1_000, releasedAt: null, ...patch });
const released = (symbol: string): ViState => firing(symbol, { active: false, base: null, releasedAt: 1_134 });
const snapshot = (...states: ViState[]): ServerMessage => ({ type: "vi_snapshot", states });
const update = (state: ViState): ServerMessage => ({ type: "vi_update", state });

function setup() {
  const links: TransportEvents[] = [];
  const connect: Connect = (_url, on) => {
    links.push(on);
    return { send: () => undefined, close: () => undefined };
  };
  const socket = new MarketSocket({ url: () => "ws://test/api/ws", connect });
  const book = new ViBook(socket);
  socket.start();
  const receive = (...messages: ServerMessage[]) => {
    for (const message of messages) links.at(-1)!.message(JSON.stringify(message));
  };
  return { book, receive, drop: () => links.at(-1)!.close(), connections: () => links.length };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("스냅샷은 전체를 바꾸고 갱신은 그 종목만 바꾼다", () => {
  const { book, receive } = setup();
  expect(book.get(SAMSUNG)).toBeNull();
  receive(HELLO, snapshot(firing(SAMSUNG), firing(HYNIX, { direction: "down" })));
  expect(book.get(SAMSUNG)).toEqual(firing(SAMSUNG));
  const hynix = book.get(HYNIX);
  expect(hynix).toEqual(firing(HYNIX, { direction: "down" }));

  receive(update(released(SAMSUNG)));
  expect(book.get(SAMSUNG)).toEqual(released(SAMSUNG));
  expect(book.get(HYNIX)).toBe(hynix);

  receive(snapshot(firing(KAKAO)));
  expect([book.get(SAMSUNG), book.get(HYNIX)]).toEqual([null, null]);
  expect(book.get(KAKAO)).toEqual(firing(KAKAO));
});

test("바뀐 종목의 구독자만 부르고 같은 상태는 같은 참조로 둔다", () => {
  const { book, receive } = setup();
  receive(HELLO, snapshot(firing(SAMSUNG), firing(HYNIX)));
  const samsung = vi.fn();
  const hynix = vi.fn();
  const stop = book.subscribe(SAMSUNG, samsung);
  book.subscribe(HYNIX, hynix);
  const before = [book.get(SAMSUNG), book.get(HYNIX)];

  receive(snapshot(firing(HYNIX), firing(SAMSUNG)), update(firing(SAMSUNG)));
  expect(book.get(SAMSUNG)).toBe(before[0]);
  expect(book.get(HYNIX)).toBe(before[1]);
  expect(samsung).not.toHaveBeenCalled();
  expect(hynix).not.toHaveBeenCalled();

  receive(update(firing(SAMSUNG, { base: 884_000 })));
  expect(book.get(SAMSUNG)?.base).toBe(884_000);
  expect(samsung).toHaveBeenCalledTimes(1);
  expect(hynix).not.toHaveBeenCalled();

  receive(snapshot(firing(HYNIX)));
  expect(samsung).toHaveBeenCalledTimes(2);
  expect(hynix).not.toHaveBeenCalled();

  stop();
  receive(update(firing(SAMSUNG)));
  expect(samsung).toHaveBeenCalledTimes(2);
});

test("소켓이 끊기면 비우고 다시 붙으면 스냅샷으로 채운다", () => {
  const { book, receive, drop, connections } = setup();
  receive(HELLO, snapshot(firing(SAMSUNG)));
  const listener = vi.fn();
  book.subscribe(SAMSUNG, listener);

  receive({ type: "status", status: { realtime: "reconnecting", since: 1_010, backfilling: false } });
  expect(book.get(SAMSUNG)).toEqual(firing(SAMSUNG));
  expect(listener).not.toHaveBeenCalled();

  drop();
  expect(book.get(SAMSUNG)).toBeNull();
  expect(listener).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(1_000);
  expect(connections()).toBe(2);
  receive(HELLO, snapshot(firing(SAMSUNG)));
  expect(book.get(SAMSUNG)).toEqual(firing(SAMSUNG));
  expect(listener).toHaveBeenCalledTimes(2);
});

test("스냅샷과 갱신 모두에서 NXT 상태는 무시하고 KRX 상태만 유지한다", () => {
  const { book, receive } = setup();
  const samsung = vi.fn();
  const hynix = vi.fn();
  book.subscribe(SAMSUNG, samsung);
  book.subscribe(HYNIX, hynix);

  receive(HELLO, snapshot(firing(SAMSUNG), firing(SAMSUNG, { market: "nxt", active: false }), firing(HYNIX, { market: "nxt" })));
  expect(book.get(SAMSUNG)).toEqual(firing(SAMSUNG));
  expect(book.get(HYNIX)).toBeNull();
  expect(samsung).toHaveBeenCalledTimes(1);
  expect(hynix).not.toHaveBeenCalled();

  receive(update(firing(SAMSUNG, { market: "nxt", active: false })), update(firing(HYNIX, { market: "nxt" })));
  expect(book.get(SAMSUNG)).toEqual(firing(SAMSUNG));
  expect(book.get(HYNIX)).toBeNull();
  expect(samsung).toHaveBeenCalledTimes(1);
  expect(hynix).not.toHaveBeenCalled();
});
