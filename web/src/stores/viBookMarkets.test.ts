import { expect, test, vi } from "vitest";
import type { ServerMessage } from "../api/generated/ServerMessage";
import type { ViMarket } from "../api/generated/ViMarket";
import type { ViState } from "../api/generated/ViState";
import { type Connect, MarketSocket, type TransportEvents } from "../api/socket";
import { ViBook } from "./viBook";

const SAMSUNG = "005930";
const HELLO: ServerMessage = { type: "hello", protocol: 1, serverTime: 1_000, status: { realtime: "live", since: 1_000, backfilling: false } };

const firing = (market: ViMarket, patch: Partial<ViState> = {}): ViState => ({ symbol: SAMSUNG, market, active: true, direction: "up", triggerPrice: 77_100, base: 70_000, triggeredAt: 1_000, releasedAt: null, ...patch });
const update = (state: ViState): ServerMessage => ({ type: "vi_update", state });
const snapshot = (...states: ViState[]): ServerMessage => ({ type: "vi_snapshot", states });

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
  return { book, receive, drop: () => links.at(-1)!.close() };
}

test("한 종목의 KRX와 NXT 상태를 따로 갖는다", () => {
  const { book, receive } = setup();
  receive(HELLO, snapshot(firing("krx"), firing("nxt", { direction: "down" })));
  expect(book.get(SAMSUNG, "krx")).toEqual(firing("krx"));
  expect(book.get(SAMSUNG, "nxt")).toEqual(firing("nxt", { direction: "down" }));

  const krx = book.get(SAMSUNG, "krx");
  receive(update(firing("nxt", { active: false, releasedAt: 1_120 })));
  expect(book.get(SAMSUNG, "nxt")?.active).toBe(false);
  expect(book.get(SAMSUNG, "krx")).toBe(krx);

  receive(snapshot(firing("nxt")));
  expect([book.get(SAMSUNG, "krx"), book.get(SAMSUNG, "nxt")?.active]).toEqual([null, true]);
});

test("같은 상태가 다시 오면 부르지 않고 소켓이 끊기면 두 시장을 모두 비운다", () => {
  const { book, receive, drop } = setup();
  receive(HELLO, snapshot(firing("krx"), firing("nxt")));
  const listener = vi.fn();
  book.subscribe(SAMSUNG, listener);
  receive(update(firing("nxt")), snapshot(firing("nxt"), firing("krx")));
  expect(listener).not.toHaveBeenCalled();
  receive(update(firing("nxt", { direction: "down" })));
  expect(listener).toHaveBeenCalledTimes(1);
  drop();
  expect([book.get(SAMSUNG, "krx"), book.get(SAMSUNG, "nxt")]).toEqual([null, null]);
});
