import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ServerMessage } from "../api/generated/ServerMessage";
import { type Connect, MarketSocket, type TransportEvents } from "../api/socket";
import { ViBook } from "./viBook";

const HELLO: ServerMessage = { type: "hello", protocol: 1, serverTime: 1_000, status: { realtime: "live", since: 1_000, backfilling: false } };
const EMPTY: ServerMessage = { type: "vi_snapshot", states: [] };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("스냅샷을 받은 동안만 VI 상태를 안다고 하고 바뀔 때만 알린다", () => {
  const links: TransportEvents[] = [];
  const connect: Connect = (_url, on) => {
    links.push(on);
    return { send: () => undefined, close: () => undefined };
  };
  const socket = new MarketSocket({ url: () => "ws://test/api/ws", connect });
  const book = new ViBook(socket);
  const listener = vi.fn();
  const stop = book.subscribeKnown(listener);
  const receive = (message: ServerMessage) => links.at(-1)!.message(JSON.stringify(message));

  socket.start();
  receive(HELLO);
  expect(book.isKnown()).toBe(false);
  receive(EMPTY);
  expect(book.isKnown()).toBe(true);
  receive(EMPTY);
  expect(listener).toHaveBeenCalledTimes(1);

  links.at(-1)!.close();
  expect(book.isKnown()).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);

  vi.advanceTimersByTime(1_000);
  receive(HELLO);
  expect(book.isKnown()).toBe(false);
  receive(EMPTY);
  expect(book.isKnown()).toBe(true);
  expect(listener).toHaveBeenCalledTimes(3);

  stop();
  links.at(-1)!.close();
  expect(listener).toHaveBeenCalledTimes(3);
});
