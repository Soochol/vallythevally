import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { TradeRow } from "../trades/tape";
import { emptyTape, tapeReducer, type TapeAction } from "../trades/tape";
import { tradeHistoryPath } from "../trades/useTradeTape";
import { infoSlot, scrollAction, tradeSlot } from "./LadderSlots";
import { buildLadder } from "./ladder";
import { PriceLadder, priceTone } from "./PriceLadder";
import { expectedInfoItems, placeInfoItems, quoteInfoItems } from "./quoteInfo";
import { tradeRows } from "./recentTrades";

const trade = (price: number, side: TradeRow["side"], key = `l${price}`): TradeRow => ({ kind: "trade", key, origin: "live", secondOfDay: 0, price, quantity: 12, side, venue: "krx", receivedAt: 0 });
const noop = () => {};
const renderBox = (trades: TradeRow[], previousClose: number | null) => renderToStaticMarkup(tradeSlot({ strength: 101.5, sameTimeRatio: null, lastTrade: null, trades, hold: noop, release: noop }, previousClose)() as never);
const priceToneOf = (html: string, price: number) => new RegExp(`data-price="${price}"[^>]*><span class="mw-trade-price" data-tone="(\\w+)"`).exec(html)?.[1];

test("체결 행은 방향을 data-side로 싣고 수량 색은 그 값으로 칠해지며 방향 없는 체결도 행으로 나온다", () => {
  const html = renderBox([trade(70100, "buy"), trade(69900, "sell"), trade(70000, "none")], 70000);
  expect(html.match(/data-side="(buy|sell|none)"/g)).toEqual(['data-side="buy"', 'data-side="sell"', 'data-side="none"']);
  expect(html).not.toContain("border-left");
});

test("체결 수량은 단위 줄임 없이 쉼표 숫자 그대로 낸다", () => {
  const html = renderBox([{ ...trade(70100, "buy"), quantity: 999_999 }, { ...trade(70000, "buy"), quantity: 9_999 }], 70000);
  expect(html).toContain('<span class="mw-trade-qty">999,999</span>');
  expect(html).toContain('<span class="mw-trade-qty">9,999</span>');
  expect(html).not.toContain("만");
});

test("체결 가격 색은 사다리 가격 칸과 같은 함수로 정해져 매수·매도와 상관없다", () => {
  const html = renderBox([trade(70100, "sell"), trade(69900, "buy"), trade(70000, "buy")], 70000);
  expect([70100, 69900, 70000].map((price) => priceToneOf(html, price))).toEqual(["up", "down", "flat"]);
  const rows = buildLadder({ asks: [{ price: 70100, quantity: 5, change: 0 }], bids: [{ price: 69900, quantity: 5, change: 0 }], lastPrice: 70000, previousClose: 70000, bounds: { lower: null, upper: null }, tickRule: "stock" });
  const ladder = renderToStaticMarkup(createElement(PriceLadder, { rows, previousClose: 70000 }));
  expect(ladder).toMatch(/class="mw-px mw-up"><span class="mw-px-num">70,100/);
  expect(ladder).toMatch(/class="mw-px mw-down"><span class="mw-px-num">69,900/);
  expect([priceTone(70100, 70000), priceTone(69900, 70000), priceTone(70000, 70000)]).toEqual(["up", "down", "flat"]);
});

test("전일 종가를 모르면 매수·매도와 관계없이 보합색이다", () => {
  for (const previousClose of [null, 0, -1]) {
    const html = renderBox([trade(70100, "buy"), trade(69900, "sell")], previousClose);
    expect([70100, 69900].map((price) => priceToneOf(html, price))).toEqual(["flat", "flat"]);
  }
});

test("체결 상자는 8행 높이에서 체결강도 줄 아래 체결을 모두 내보낸다", () => {
  const trades = Array.from({ length: 20 }, (_, i) => trade(70000 + i, "buy"));
  const html = renderBox(trades, 70000);
  expect(html.match(/data-testid="ladder-trade"/g)).toHaveLength(20);
  expect(html.indexOf("ladder-strength")).toBeLessThan(html.indexOf("ladder-trades"));
});

test("스크롤이 내려가 있으면 hold하고 맨 위로 돌아오면 release하며 그동안 온 체결은 맨 위에 붙는다", () => {
  expect([scrollAction(40), scrollAction(1), scrollAction(0)]).toEqual(["hold", "hold", "release"]);
  const liveAction = (price: number): TapeAction => ({ type: "live", trades: [{ t: 0, price, qty: 1, venue: "krx", strength: null }], receivedAt: 0 });
  const prices = (state: typeof emptyTape) => tradeRows(state, "combined").map((row) => row.price);
  let state = [liveAction(1), liveAction(2)].reduce(tapeReducer, emptyTape);
  state = tapeReducer(state, { type: scrollAction(40) });
  state = tapeReducer(state, liveAction(3));
  expect(prices(state)).toEqual([2, 1]);
  state = tapeReducer(state, { type: scrollAction(0) });
  expect(prices(state)).toEqual([3, 2, 1]);
});

test("사다리 지난 체결 요청은 pages=1을 싣고 체결창 요청은 싣지 않는다", () => {
  expect(tradeHistoryPath("005930" as never, "combined", 1)).toBe("/api/symbols/005930/trades?venue=combined&limit=500&pages=1");
  expect(tradeHistoryPath("005930" as never, "krx")).toBe("/api/symbols/005930/trades?venue=krx&limit=500");
});

test("정보란은 바꿀 수 있는 줄만 button으로 그리고 data-flipped를 싣는다", () => {
  const rows = buildLadder({ asks: [{ price: 70_100, quantity: 5, change: 0 }], bids: [{ price: 70_000, quantity: 5, change: 0 }], lastPrice: 70_000, previousClose: 70_000, bounds: { lower: null, upper: null }, tickRule: "stock" });
  const input = {
    price: 70_300,
    previousClose: 70_000,
    summary: { open: 70_100, high: 71_000, low: 69_000, volume: 1_234_567, tradeValueWon: 86_790_000_000 },
    fundamentals: { upperLimit: 91_000, lowerLimit: 49_000, marketCap: 82_400_000_000, listedShares: 50_000_000 },
  };
  const flipped = new Set(["open", "expectedPrice", "cap"] as const);
  const page0 = placeInfoItems(rows, quoteInfoItems(0, input, flipped), expectedInfoItems({ price: 71_800, qty: 300 }, 70_000, flipped));
  const html0 = renderToStaticMarkup(infoSlot(page0, { page: 0, select: noop, flipped, toggle: noop })(10) as never);
  expect(html0).toContain('<button type="button" class="mw-card-row" data-testid="ladder-info" data-label="시가 등락" data-flipped=""');
  expect(html0).toContain('<button type="button" class="mw-card-row" data-testid="ladder-info" data-label="예상 등락" data-flipped=""');
  expect(html0).toContain('<div class="mw-card-row" data-testid="ladder-info" data-label="예상체결량" data-warn="">');
  const html1 = renderToStaticMarkup(infoSlot(quoteInfoItems(1, input, flipped), { page: 1, select: noop, flipped, toggle: noop })(10) as never);
  expect(html1).toContain('<button type="button" class="mw-card-row" data-testid="ladder-info" data-label="상장주식" data-flipped=""');
});
