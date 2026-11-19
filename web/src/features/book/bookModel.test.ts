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

const fullFrame = (): FeedBook => ({
  t: 1,
  asks: Array.from({ length: 10 }, (_, i) => ({ price: 71_100 + 100 * i, qty: 100 * (i + 1) })),
  bids: Array.from({ length: 10 }, (_, i) => ({ price: 71_000 - 100 * i, qty: 10 * (i + 1) })),
  totalAskQty: 5_500,
  totalBidQty: 550,
  expected: null,
});

const withHole = (book: FeedBook, side: "asks" | "bids", depth: number): FeedBook => ({ ...book, [side]: book[side].map((level, i) => (i === depth ? null : level)) });

test("가격이 빈 단이 중간에 낀 프레임이 와도 직전 실시간 호가의 그 단을 지우지 않는다", () => {
  const first = acceptLive(EMPTY_BOOK, fullFrame());
  const holed = acceptLive(first, withHole(withHole(fullFrame(), "asks", 3), "bids", 5));
  if (holed.phase !== "live" || first.phase !== "live") throw new Error("live");
  expect(holed.view.asks.map((l) => l.price)).toEqual(first.view.asks.map((l) => l.price));
  expect(holed.view.bids.map((l) => l.quantity)).toEqual(first.view.bids.map((l) => l.quantity));
  expect(holed.view.asks.every((l) => l.change === 0)).toBe(true);
});

test("호가가 한 틱 움직인 프레임의 빈 단은 직전 단으로 채우지 않아 가격이 겹치지 않는다", () => {
  const first = acceptLive(EMPTY_BOOK, fullFrame());
  const moved = fullFrame();
  const shifted: FeedBook = {
    ...moved,
    asks: moved.asks.map((level, i) => (i === 3 ? null : { price: 71_200 + 100 * i, qty: level!.qty })),
    bids: moved.bids.map((level, i) => (i === 3 ? null : { price: 71_100 - 100 * i, qty: level!.qty })),
  };
  const next = acceptLive(first, shifted);
  if (next.phase !== "live") throw new Error("live");
  const asks = next.view.asks.map((l) => l.price);
  const bids = next.view.bids.map((l) => l.price);
  expect(new Set(asks).size).toBe(asks.length);
  expect(new Set(bids).size).toBe(bids.length);
  expect(asks).toEqual([...asks].sort((a, b) => a - b));
  expect(bids).toEqual([...bids].sort((a, b) => b - a));
});

test("1단이 비고 호가가 한 틱 움직인 프레임은 직전 1단으로 채워 반대쪽과 교차하지 않는다", () => {
  const first = acceptLive(EMPTY_BOOK, fullFrame());
  const moved: FeedBook = {
    ...fullFrame(),
    asks: fullFrame().asks.map((level, i) => (i === 0 ? null : { price: 71_200 + 100 * i, qty: level!.qty })),
    bids: fullFrame().bids.map((level, i) => ({ price: 71_100 - 100 * i, qty: level!.qty })),
  };
  const next = acceptLive(first, moved);
  if (next.phase !== "live") throw new Error("live");
  expect(next.view.asks[0]!.price).toBeGreaterThan(next.view.bids[0]!.price);
});

test("뒤쪽 단이 비어 오면 얇아진 호가로 받아들인다", () => {
  const first = acceptLive(EMPTY_BOOK, fullFrame());
  const thin = { ...fullFrame(), asks: [...fullFrame().asks.slice(0, 3), ...Array<null>(7).fill(null)], bids: Array<null>(10).fill(null) };
  const next = acceptLive(first, thin);
  if (next.phase !== "live") throw new Error("live");
  expect(next.view.asks).toHaveLength(3);
  expect(next.view.bids).toHaveLength(0);
});

test("직전 실시간 호가가 없으면 구멍 난 프레임은 있는 단만 보인다", () => {
  const state = acceptLive(EMPTY_BOOK, withHole(fullFrame(), "asks", 3));
  if (state.phase !== "live") throw new Error("live");
  expect(state.view.asks).toHaveLength(9);
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
  expect(strip.description).toContain("정규 총잔량 매도 90 · 매수 140");
});

test("띠는 시간외 잔량이 없으면 정규 총잔량이다", () => {
  expect(stripTotals({ ask: 90, bid: 140 }, null)).toEqual({ ask: 90, bid: 140, source: "regular", description: null });
});

test("띠는 정규 총잔량이 없으면 시간외 종가 잔량만 설명한다", () => {
  expect(stripTotals(null, { t: 1, askQty: 13_770, bidQty: 0 })).toEqual({ ask: 13_770, bid: 0, source: "afterHours", description: "시간외 종가 잔량" });
});
