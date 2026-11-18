import { expect, test } from "vitest";
import type { FeedBook } from "../../api/generated/FeedBook";
import type { OrderBook } from "../../api/generated/OrderBook";
import { acceptLive, acceptSnapshot, EMPTY_BOOK } from "./bookModel";

const snapshot: OrderBook = { symbol: "005930", asks: [{ price: 101, quantity: 10 }], bids: [{ price: 100, quantity: 20 }], totalAskQuantity: 10, totalBidQuantity: 20, afterHoursAskQuantity: null, afterHoursBidQuantity: null, bookTime: null };
const live = (asks: [number, number][], bids: [number, number][]): FeedBook => ({
  t: 1,
  asks: asks.map(([price, qty]) => ({ price, qty })),
  bids: [...bids.map(([price, qty]) => ({ price, qty })), null],
  totalAskQty: 1,
  totalBidQty: 2,
  expected: null,
});

test("스냅샷은 빈 상태에서 보이고 첫 실시간 호가가 오면 버려진다", () => {
  const shown = acceptSnapshot(EMPTY_BOOK, snapshot);
  expect(shown.phase).toBe("snapshot");
  const replaced = acceptLive(shown, live([[102, 5]], [[101, 6]]));
  expect(replaced.phase).toBe("live");
  if (replaced.phase !== "live") return;
  expect(replaced.view.asks.map((l) => l.price)).toEqual([102]);
  expect(replaced.view.asks[0]!.change).toBe(0);
});

test("실시간 호가 뒤에 늦게 온 스냅샷은 무시한다", () => {
  const afterLive = acceptLive(EMPTY_BOOK, live([[102, 5]], [[101, 6]]));
  expect(acceptSnapshot(afterLive, snapshot)).toBe(afterLive);
});

test("잔량 증감은 같은 쪽 같은 가격의 직전 실시간 값 대비이고 새 가격은 0이다", () => {
  const first = acceptLive(EMPTY_BOOK, live([[102, 5], [103, 8]], [[101, 6]]));
  const second = acceptLive(first, live([[102, 9], [104, 3]], [[101, 2]]));
  if (second.phase !== "live") throw new Error("live");
  expect(second.view.asks.map((l) => l.change)).toEqual([4, 0]);
  expect(second.view.bids.map((l) => l.change)).toEqual([-4]);
});

test("빈 단(null)은 건너뛴다", () => {
  const state = acceptLive(EMPTY_BOOK, live([], [[101, 6]]));
  if (state.phase !== "live") throw new Error("live");
  expect(state.view.bids).toHaveLength(1);
});
