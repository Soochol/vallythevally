import { expect, test } from "vitest";
import type { FeedBook } from "../../api/generated/FeedBook";
import type { OrderBook } from "../../api/generated/OrderBook";
import { acceptAfterHoursLive, acceptAfterHoursSnapshot, acceptLive, acceptSnapshot, EMPTY_BOOK, stripTotals } from "./bookModel";

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

test("실시간 호가는 프레임 시각을 담고 조회 호가는 시각이 없다", () => {
  const shown = acceptSnapshot(EMPTY_BOOK, snapshot);
  if (shown.phase !== "snapshot") throw new Error("snapshot");
  expect(shown.view.t).toBeNull();
  const replaced = acceptLive(shown, { ...live([[102, 5]], [[101, 6]]), t: 1_790_000_000 });
  if (replaced.phase !== "live") throw new Error("live");
  expect(replaced.view.t).toBe(1_790_000_000);
});

test("빈 단(null)은 건너뛴다", () => {
  const state = acceptLive(EMPTY_BOOK, live([], [[101, 6]]));
  if (state.phase !== "live") throw new Error("live");
  expect(state.view.bids).toHaveLength(1);
});

const withAfterHours = (ask: number | null, bid: number | null): OrderBook => ({ ...snapshot, afterHoursAskQuantity: ask, afterHoursBidQuantity: bid });

test("시간외 잔량은 조회 값 뒤 실시간 값이 오면 실시간 값이다", () => {
  const shown = acceptAfterHoursSnapshot(null, withAfterHours(5000, 0), 100);
  expect(shown).toEqual({ source: "snapshot", totals: { t: 100, askQty: 5000, bidQty: 0 } });
  const replaced = acceptAfterHoursLive({ t: 200, askQty: 6000, bidQty: 0 });
  expect(replaced).toEqual({ source: "live", totals: { t: 200, askQty: 6000, bidQty: 0 } });
});

test("실시간 시간외 잔량 뒤에 늦게 온 조회 값은 무시한다", () => {
  const live = acceptAfterHoursLive({ t: 200, askQty: 6000, bidQty: 0 });
  expect(acceptAfterHoursSnapshot(live, withAfterHours(5000, 0), 300)).toBe(live);
});

test("조회 시간외 두 필드가 null이면 시간외 잔량이 없다", () => {
  expect(acceptAfterHoursSnapshot(null, withAfterHours(null, null), 100)).toBeNull();
});

test("사다리가 비어 있어도 시간외 잔량을 둘 수 있다", () => {
  expect(EMPTY_BOOK.phase).toBe("empty");
  expect(acceptAfterHoursLive({ t: 200, askQty: 13_770, bidQty: 0 }).totals.askQty).toBe(13_770);
});

test("띠는 시간외 잔량이 있으면 그 숫자와 정규 총잔량 설명을 보인다", () => {
  const strip = stripTotals({ ask: 90, bid: 140 }, { t: 1, askQty: 13_770, bidQty: 0 });
  expect(strip).toMatchObject({ ask: 13_770, bid: 0, source: "afterHours" });
  expect(strip.description).toContain("정규 총잔량 매도 90주 · 매수 140주");
});

test("띠는 시간외 잔량이 없으면 정규 총잔량이다", () => {
  expect(stripTotals({ ask: 90, bid: 140 }, null)).toEqual({ ask: 90, bid: 140, source: "regular", description: null });
});

test("띠는 정규 총잔량이 없으면 시간외 종가 잔량만 설명한다", () => {
  expect(stripTotals(null, { t: 1, askQty: 13_770, bidQty: 0 })).toEqual({ ask: 13_770, bid: 0, source: "afterHours", description: "시간외 종가 잔량" });
});
