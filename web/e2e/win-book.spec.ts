import type { Page } from "@playwright/test";
import type { FeedBook } from "../src/api/generated/FeedBook";
import type { FeedKind } from "../src/api/generated/FeedKind";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderBook } from "../src/api/generated/OrderBook";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test, windowTabs } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const CODE = "005930";

const book = (page: Page) => page.getByTestId("book-window");
const ladderRows = (page: Page) => page.getByTestId("price-ladder").locator(".mw-lr");

function bookWindow(scenario: Scenario, symbol: string) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart: LayoutWindow = symbol.startsWith("IDX:")
    ? { id: "cell-0", link: null, kind: "chart", symbol, venue: null, period: "D", chartSettings: SETTINGS }
    : { id: "cell-0", link: null, kind: "chart", symbol, venue: "combined", period: "D", chartSettings: SETTINGS };
  const windows: LayoutWindow[] = [chart, ...layout.windows.filter((w) => w.kind !== "chart"), { id: "book", link: null, kind: "book" }];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

function previousClose(scenario: Scenario): number {
  const quote = scenario.market.quote(CODE)!;
  return quote.price - quote.change;
}

function snapshotOf(base: number): OrderBook {
  return {
    symbol: CODE,
    asks: Array.from({ length: 10 }, (_, i) => ({ price: base + 100 * (i + 1), quantity: 10 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: base - 100 * i, quantity: 20 + i })),
    totalAskQuantity: 1000,
    totalBidQuantity: 3000,
    bookTime: null,
  };
}

function liveOf(asks: [number, number][], bids: [number, number][], totals: [number, number]): FeedBook {
  return { t: 1, asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), totalAskQty: totals[0], totalBidQty: totals[1], expected: null };
}

async function subOf(scenario: Scenario, kind: FeedKind): Promise<string> {
  let sub = "";
  await expect.poll(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === kind && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  return sub;
}

async function open(page: Page, scenario: Scenario, base: number) {
  bookWindow(scenario, CODE);
  scenario.reply((url) => url.pathname === "/api/symbols/005930/fundamentals", { body: { symbol: CODE, upperLimit: 91000, lowerLimit: 49000, marketCap: null, listedShares: null, per: null, pbr: null, roe: null, eps: null, bps: null, foreignExhaustionRate: null, high52w: null, low52w: null } });
  scenario.reply((url) => url.pathname === "/api/symbols/005930/order-book", { body: snapshotOf(base) });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("스냅샷 20행이 먼저 보이고 상·하한가와 기준가가 아래에 있다", async ({ page, scenario }) => {
  const base = previousClose(scenario);
  await open(page, scenario, base);
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(ladderRows(page).locator(".mw-px").first()).toContainText((base + 1000).toLocaleString("ko-KR"));
  await expect(page.getByTestId("book-upper")).toHaveText("91,000");
  await expect(page.getByTestId("book-lower")).toHaveText("49,000");
  await expect(page.getByTestId("book-base")).toHaveText(base.toLocaleString("ko-KR"));
  await expect(page.getByTestId("book-total-ask")).toHaveText("1,000주");
});

test("첫 실시간 호가가 스냅샷을 대신하고 체결이 현재가 행을 강조하며 증감을 보인다", async ({ page, scenario }) => {
  const base = 70000;
  await open(page, scenario, base);
  await expect(ladderRows(page)).toHaveCount(20);
  const bookSub = await subOf(scenario, "book");
  const tradeSub = await subOf(scenario, "trades");

  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70100, 50], [70200, 40]], [[70000, 80], [69900, 60]], [90, 140]) });
  await expect(page.getByTestId("book-total-bid")).toHaveText("140주");
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveCount(4);

  scenario.live.emit({ type: "feed_trades", sub: tradeSub, seq: 1, trades: [{ t: 1, price: 70000, qty: 3, venue: null, strength: null }] });
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,000");

  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70100, 70], [70200, 40]], [[70000, 80], [69900, 10]], [110, 90]) });
  await expect(page.locator(".mw-lr[data-side=ask] .mw-qty-delta").first()).toHaveText("+20주");
  await expect(page.locator(".mw-lr[data-side=bid] .mw-qty-delta")).toHaveText("−50주");
  const ratio = page.getByRole("img", { name: /^매도 110주 · 매수 90주$/ });
  await expect(ratio).toBeVisible();
});

test("교차 호가를 그대로 그리고 현재가 행은 하나다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const bookSub = await subOf(scenario, "book");
  const tradeSub = await subOf(scenario, "trades");
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70000, 30], [70100, 20]], [[70100, 25], [70000, 15]], [50, 40]) });
  scenario.live.emit({ type: "feed_trades", sub: tradeSub, seq: 1, trades: [{ t: 1, price: 70100, qty: 1, venue: null, strength: null }] });
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  const prices = await ladderRows(page).locator(".mw-px").allTextContents();
  const shown = prices.map((text) => Number(text.replace(/[^0-9]/g, "").slice(0, 5))).filter((n) => n > 0);
  expect(shown).toEqual([70100, 70000, 70100, 70000]);
});

test("끊기면 사다리를 흐리게 하고 끊김을 보인다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const bookSub = await subOf(scenario, "book");
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70100, 50]], [[70000, 80]], [50, 80]) });
  await expect(book(page)).toHaveAttribute("data-connected", "");
  scenario.live.emit({ type: "feed_link", sub: bookSub, live: false, at: 2 });
  await expect(page.getByRole("status").filter({ hasText: "끊김" })).toBeVisible();
  await expect(page.locator(".bk-ladder")).toHaveAttribute("data-stale", "");
  await page.screenshot({ path: "../target/ux-screens/win-book-disconnected.png" });
});

test("앱 거래소가 KRX이면 머리에 통합 표시가 있다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await expect(page.getByTitle("키움 호가·프로그램·거래원은 KRX와 NXT를 합친 값입니다")).toHaveCount(0);
  await pickDesktopVenue(page, "KRX");
  await expect(page.getByTitle("키움 호가·프로그램·거래원은 KRX와 NXT를 합친 값입니다")).toHaveText("통합");
});

test("지수 종목이면 빈 상태를 보이고 호가를 구독하지 않는다", async ({ page, scenario }) => {
  bookWindow(scenario, "IDX:001");
  await page.goto("/");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expect(page.getByText("이 창은 주식만 보입니다")).toBeVisible();
  expect(scenario.live.messages.filter((m) => m.type === "subscribe_feed")).toHaveLength(0);
});
