import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ServerMessage } from "../api/generated/ServerMessage";
import type { ViState } from "../api/generated/ViState";
import { type Connect, MarketSocket, type TransportEvents } from "../api/socket";
import { ViBook } from "./viBook";
import { MAX_EXPECTED_POINTS, MAX_EXPECTED_SESSIONS, ViExpectedStore } from "./viExpectedStore";

const SAMSUNG = "005930";
const HYNIX = "000660";
const DAY1_1000 = Math.floor(Date.parse("2026-11-24T10:00:00+09:00") / 1000);
const DAY2_0905 = Math.floor(Date.parse("2026-11-25T09:05:00+09:00") / 1000);
const HELLO: ServerMessage = { type: "hello", protocol: 1, serverTime: DAY1_1000, status: { realtime: "live", since: DAY1_1000, backfilling: false } };

const viState = (symbol: string, patch: Partial<ViState> = {}): ViState => ({
  symbol,
  market: "krx",
  active: true,
  direction: "up",
  triggerPrice: 77_000,
  base: 70_000,
  triggeredAt: DAY1_1000,
  releasedAt: null,
  ...patch,
});

function setup() {
  const links: TransportEvents[] = [];
  const connect: Connect = (_url, on) => {
    links.push(on);
    return { send: () => undefined, close: () => undefined };
  };
  const socket = new MarketSocket({ url: () => "ws://test/api/ws", connect });
  const book = new ViBook(socket);
  const store = new ViExpectedStore(socket, book);
  socket.start();
  const receive = (...messages: ServerMessage[]) => {
    for (const message of messages) links.at(-1)!.message(JSON.stringify(message));
  };
  return { socket, store, receive, drop: () => links.at(-1)!.close(), connections: () => links.length };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("records unique expected points in order, caps at 240, and ignores pre-trigger or stale timestamps", () => {
  const { store } = setup();
  store.record(SAMSUNG, "krx", DAY1_1000, { price: 77_000, qty: 100 }, DAY1_1000 - 1);
  expect(store.get(SAMSUNG, "krx", DAY1_1000)).toEqual([]);

  store.record(SAMSUNG, "krx", DAY1_1000, { price: 77_100, qty: 100 }, DAY1_1000 + 5);
  store.record(SAMSUNG, "krx", DAY1_1000, { price: 77_100, qty: 100 }, DAY1_1000 + 6);
  store.record(SAMSUNG, "krx", DAY1_1000, { price: 77_200, qty: 120 }, DAY1_1000 + 4);
  expect(store.get(SAMSUNG, "krx", DAY1_1000)).toEqual([
    { t: DAY1_1000 + 5, price: 77_100, qty: 100 },
  ]);

  for (let i = 1; i <= MAX_EXPECTED_POINTS + 10; i++) {
    store.record(SAMSUNG, "krx", DAY1_1000, { price: 77_100 + i * 100, qty: 100 + i }, DAY1_1000 + 10 + i);
  }
  const series = store.get(SAMSUNG, "krx", DAY1_1000);
  expect(series).toHaveLength(MAX_EXPECTED_POINTS);
  expect(series[0]).toEqual({ t: DAY1_1000 + 21, price: 78_200, qty: 111 });
  expect(series.at(-1)).toEqual({ t: DAY1_1000 + 10 + MAX_EXPECTED_POINTS + 10, price: 77_100 + (MAX_EXPECTED_POINTS + 10) * 100, qty: 100 + MAX_EXPECTED_POINTS + 10 });
});

test("merges server vi_expected_snapshot with local points and survives reconnect", () => {
  const { store, receive, drop, connections } = setup();
  const listener = vi.fn();
  store.subscribe(SAMSUNG, listener);

  receive(HELLO, { type: "vi_update", state: viState(SAMSUNG) });
  store.record(SAMSUNG, "krx", DAY1_1000, { price: 77_500, qty: 400 }, DAY1_1000 + 30);
  expect(listener).toHaveBeenCalledTimes(1);

  drop();
  expect(store.get(SAMSUNG, "krx", DAY1_1000)).toEqual([{ t: DAY1_1000 + 30, price: 77_500, qty: 400 }]);

  vi.advanceTimersByTime(1_000);
  expect(connections()).toBe(2);
  receive(
    HELLO,
    { type: "vi_snapshot", states: [viState(SAMSUNG)] },
    {
      type: "vi_expected_snapshot",
      symbol: SAMSUNG,
      market: "krx",
      triggeredAt: DAY1_1000,
      points: [
        { t: DAY1_1000 + 5, price: 77_100, qty: 200 },
        { t: DAY1_1000 + 20, price: 77_300, qty: 300 },
        { t: DAY1_1000 + 30, price: 77_500, qty: 400 },
        { t: DAY1_1000 + 40, price: 77_600, qty: 500 },
      ],
    },
  );

  expect(store.get(SAMSUNG, "krx", DAY1_1000)).toEqual([
    { t: DAY1_1000 + 5, price: 77_100, qty: 200 },
    { t: DAY1_1000 + 20, price: 77_300, qty: 300 },
    { t: DAY1_1000 + 30, price: 77_500, qty: 400 },
    { t: DAY1_1000 + 40, price: 77_600, qty: 500 },
  ]);
  expect(listener).toHaveBeenCalledTimes(2);
});

test("keeps cache on release, resets on next VI trigger, empty vi_snapshot, and KST day rollover", () => {
  const { store, receive } = setup();
  receive(HELLO, { type: "vi_update", state: viState(SAMSUNG) });
  store.record(SAMSUNG, "krx", DAY1_1000, { price: 77_100, qty: 200 }, DAY1_1000 + 5);

  receive({ type: "vi_update", state: viState(SAMSUNG, { active: false, releasedAt: DAY1_1000 + 120 }) });
  expect(store.get(SAMSUNG, "krx", DAY1_1000)).toEqual([{ t: DAY1_1000 + 5, price: 77_100, qty: 200 }]);

  const secondTrigger = DAY1_1000 + 600;
  receive({ type: "vi_update", state: viState(SAMSUNG, { active: true, triggeredAt: secondTrigger }) });
  expect(store.get(SAMSUNG, "krx", DAY1_1000)).toEqual([]);
  expect(store.get(SAMSUNG, "krx", secondTrigger)).toEqual([]);

  store.record(SAMSUNG, "krx", secondTrigger, { price: 78_000, qty: 350 }, secondTrigger + 2);
  store.record(HYNIX, "krx", secondTrigger, { price: 200_000, qty: 150 }, secondTrigger + 2);

  receive({ type: "vi_snapshot", states: [] });
  expect(store.get(SAMSUNG, "krx", secondTrigger)).toEqual([]);
  expect(store.get(HYNIX, "krx", secondTrigger)).toEqual([]);

  store.record(SAMSUNG, "krx", DAY1_1000, { price: 77_100, qty: 200 }, DAY1_1000 + 5);
  store.record(HYNIX, "krx", DAY2_0905, { price: 201_000, qty: 100 }, DAY2_0905 + 5);
  expect(store.get(SAMSUNG, "krx", DAY1_1000)).toEqual([]);
  expect(store.get(HYNIX, "krx", DAY2_0905)).toEqual([{ t: DAY2_0905 + 5, price: 201_000, qty: 100 }]);
});

test("evicts inactive sessions first when exceeding MAX_EXPECTED_SESSIONS", () => {
  const { store, receive } = setup();
  receive(HELLO, { type: "vi_update", state: viState(SAMSUNG) });
  store.record(SAMSUNG, "krx", DAY1_1000, { price: 77_100, qty: 200 }, DAY1_1000 + 1);

  for (let i = 0; i < MAX_EXPECTED_SESSIONS + 5; i++) {
    const code = String(100_000 + i);
    store.record(code, "krx", DAY1_1000, { price: 10_000 + i, qty: 10 }, DAY1_1000 + 2);
  }
  expect(store.get(SAMSUNG, "krx", DAY1_1000)).toEqual([{ t: DAY1_1000 + 1, price: 77_100, qty: 200 }]);
  expect(store.get("100000", "krx", DAY1_1000)).toEqual([]);
});

test("captures burst feed_book expected updates synchronously via feed tap", () => {
  const { socket, store, receive } = setup();
  const stop = socket.subscribeFeed({ symbol: SAMSUNG, kind: "book", venue: "combined" }, () => undefined);
  receive(HELLO, { type: "vi_update", state: viState(SAMSUNG) });
  receive(
    { type: "feed_book", sub: "s1", book: { t: DAY1_1000 + 5, asks: [], bids: [], totalAskQty: 0, totalBidQty: 0, expected: { price: 77_200, qty: 300 } } },
    { type: "feed_book", sub: "s1", book: { t: DAY1_1000 + 10, asks: [], bids: [], totalAskQty: 0, totalBidQty: 0, expected: { price: 77_500, qty: 450 } } },
  );
  stop();
  expect(store.get(SAMSUNG, "krx", DAY1_1000)).toEqual([
    { t: DAY1_1000 + 5, price: 77_200, qty: 300 },
    { t: DAY1_1000 + 10, price: 77_500, qty: 450 },
  ]);
});
