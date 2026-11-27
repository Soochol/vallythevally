import type { Page } from "@playwright/test";
import type { FeedBook } from "../src/api/generated/FeedBook";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderBook } from "../src/api/generated/OrderBook";
import type { ViPlaybook } from "../src/api/generated/ViPlaybook";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pollSaved, test, windowTabs } from "./harness";
import { daySummaryOf } from "./fixtures/scenario";
import { CODE as SAMSUNG, FUNDAMENTAL_FIGURES, ordersOn, pinQuote, tradingApi } from "./order-window";

const HYNIX = "000660";
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const REG_START = "2026-11-09T10:00:00+09:00";
const REG_SEC = Math.floor(Date.parse(REG_START) / 1000);

const EMPTY_PLAYBOOK: ViPlaybook = {
  symbol: SAMSUNG,
  direction: "up",
  kind: "all",
  lookbackDays: 20,
  sampleCount: 0,
  horizons: [],
  recentMatches: [],
};

function snapshotOf(symbol: string, base: number): OrderBook {
  return {
    symbol,
    asks: Array.from({ length: 10 }, (_, i) => ({ price: base + 100 * (i + 1), quantity: 10 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: base - 100 * i, quantity: 20 + i })),
    totalAskQuantity: 1000,
    totalBidQuantity: 3000,
    afterHoursAskQuantity: null,
    afterHoursBidQuantity: null,
    bookTime: "10:00:00",
    expected: null,
  };
}

function liveBook(base: number, t: number, expected: { price: number; qty: number } | null): FeedBook {
  return {
    t,
    asks: [{ price: base + 100, qty: 100 }, { price: base + 200, qty: 80 }],
    bids: [{ price: base, qty: 120 }, { price: base - 100, qty: 90 }],
    totalAskQty: 180,
    totalBidQty: 210,
    expected,
  };
}

function setupSymbolApi(scenario: Scenario, code: string, base: number) {
  scenario.reply((url) => url.pathname === `/api/symbols/${code}/fundamentals`, { body: { symbol: code, upperLimit: base + 20_000, lowerLimit: base - 20_000, ...FUNDAMENTAL_FIGURES } });
  scenario.reply((url) => url.pathname === `/api/symbols/${code}/order-book`, { body: snapshotOf(code, base) });
  scenario.reply((url) => url.pathname === `/api/symbols/${code}/trades`, { body: { symbol: code, venue: "combined", trades: [], skippedRows: 0 } });
  scenario.reply((url) => url.pathname === `/api/symbols/${code}/vi-playbook`, { body: { ...EMPTY_PLAYBOOK, symbol: code } });
  pinQuote(scenario, code, base, 1000);
  scenario.on((url) => url.pathname === `/api/symbols/${code}/day-summary`, () => {
    const quote = scenario.market.quote(code, "combined");
    return { body: quote ? daySummaryOf({ ...quote, price: base, change: 1000 }) : null };
  });
}

function setupLayout(scenario: Scenario, kind: "order" | "book") {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: SAMSUNG, venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "watch", link: "a", kind: "watchlist" },
    kind === "order"
      ? { id: "order", link: "a", kind: "order", venue: "krx" }
      : { id: "book", link: "a", kind: "book" },
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  const wl = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({
    ...wl,
    lists: wl.lists.map((list, idx) => (idx === 0 ? { ...list, symbols: [SAMSUNG, HYNIX] } : list)),
    revision: wl.revision + 1,
  });
}

async function latestBookSub(scenario: Scenario, code: string, afterCount = 0): Promise<string> {
  let sub = "";
  await pollSaved(() => {
    const subs = scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === code);
    if (subs.length <= afterCount) return "";
    const last = subs[subs.length - 1]!;
    sub = last.type === "subscribe_feed" ? last.sub : "";
    return sub;
  }).not.toBe("");
  return sub;
}

async function switchSymbol(page: Page, code: string) {
  await windowTabs(page).getByRole("tab", { name: /^관심종목/ }).click();
  await page.getByRole("complementary", { name: "관심종목" }).locator(`li[data-code="${code}"]`).click();
}

test.use({ clockStart: REG_START });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("호가주문창에서 종목을 전환했다 돌아와도 VI 예상체결 히스토리와 서버 스냅샷이 유지되고 해제 시 숨긴다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  setupLayout(scenario, "order");
  setupSymbolApi(scenario, SAMSUNG, 70_000);
  setupSymbolApi(scenario, HYNIX, 200_000);

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^호가주문/ }).click();
  await expect(page.getByTestId("order-window")).toHaveAttribute("data-symbol", SAMSUNG);

  const sub1 = await latestBookSub(scenario, SAMSUNG);
  const triggeredAt = REG_SEC - 20;
  scenario.live.emit({
    type: "vi_update",
    state: { symbol: SAMSUNG, market: "krx", active: true, direction: "up", triggerPrice: 77_000, base: 70_000, triggeredAt, releasedAt: null },
  });
  scenario.live.emit({ type: "feed_book", sub: sub1, book: liveBook(70_000, triggeredAt + 5, { price: 77_200, qty: 300 }) });
  scenario.live.emit({ type: "feed_book", sub: sub1, book: liveBook(70_000, triggeredAt + 10, { price: 77_500, qty: 450 }) });

  await expect(page.getByTestId("order-vi-top")).toBeVisible();
  await expect(page.getByTestId("order-vi-sparkline").locator("rect.od-vi-spark-bar")).toHaveCount(2);
  await expect(page.getByTestId("order-vi-expected-latest")).toContainText("77,500");

  await switchSymbol(page, HYNIX);
  await windowTabs(page).getByRole("tab", { name: /^호가주문/ }).click();
  await expect(page.getByTestId("order-window")).toHaveAttribute("data-symbol", HYNIX);
  await expect(page.getByTestId("order-vi-top")).toHaveCount(0);

  const beforeReturn = scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === SAMSUNG).length;
  await switchSymbol(page, SAMSUNG);
  await windowTabs(page).getByRole("tab", { name: /^호가주문/ }).click();
  await expect(page.getByTestId("order-window")).toHaveAttribute("data-symbol", SAMSUNG);
  await latestBookSub(scenario, SAMSUNG, beforeReturn);

  await expect(page.getByTestId("order-vi-top")).toBeVisible();
  await expect(page.getByTestId("order-vi-sparkline").locator("rect.od-vi-spark-bar")).toHaveCount(2);

  scenario.live.emit({
    type: "vi_expected_snapshot",
    symbol: SAMSUNG,
    market: "krx",
    triggeredAt,
    points: [
      { t: triggeredAt + 5, price: 77_200, qty: 300 },
      { t: triggeredAt + 10, price: 77_500, qty: 450 },
      { t: triggeredAt + 18, price: 77_900, qty: 620 },
    ],
  });
  await expect(page.getByTestId("order-vi-sparkline").locator("rect.od-vi-spark-bar")).toHaveCount(3);
  await expect(page.getByTestId("order-vi-expected-latest")).toContainText("77,900");

  scenario.live.emit({
    type: "vi_update",
    state: { symbol: SAMSUNG, market: "krx", active: false, direction: "up", triggerPrice: 77_000, base: null, triggeredAt, releasedAt: REG_SEC },
  });
  await expect(page.getByTestId("order-vi-top")).toHaveCount(0);
});

test("10호가창에도 상단 VI 히스토리 오버레이가 보이고 종목 전환 복귀 후 유지되며 해제 시 숨긴다", async ({ page, scenario }) => {
  setupLayout(scenario, "book");
  setupSymbolApi(scenario, SAMSUNG, 70_000);
  setupSymbolApi(scenario, HYNIX, 200_000);

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expect(page.getByTestId("book-window")).toHaveAttribute("data-symbol", SAMSUNG);

  const sub1 = await latestBookSub(scenario, SAMSUNG);
  const triggeredAt = REG_SEC - 15;
  scenario.live.emit({
    type: "vi_update",
    state: { symbol: SAMSUNG, market: "krx", active: true, direction: "up", triggerPrice: 77_000, base: 70_000, triggeredAt, releasedAt: null },
  });
  scenario.live.emit({ type: "feed_book", sub: sub1, book: liveBook(70_000, triggeredAt + 4, { price: 77_300, qty: 250 }) });
  scenario.live.emit({ type: "feed_book", sub: sub1, book: liveBook(70_000, triggeredAt + 9, { price: 77_600, qty: 500 }) });

  await expect(page.getByTestId("order-vi-top")).toBeVisible();
  await expect(page.getByTestId("order-vi-bottom")).toHaveCount(0);
  await expect(page.getByTestId("order-vi-sparkline").locator("rect.od-vi-spark-bar")).toHaveCount(2);
  await expect(page.getByTestId("order-vi-expected-latest")).toContainText("77,600");

  await switchSymbol(page, HYNIX);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expect(page.getByTestId("book-window")).toHaveAttribute("data-symbol", HYNIX);
  await expect(page.getByTestId("order-vi-top")).toHaveCount(0);

  await switchSymbol(page, SAMSUNG);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expect(page.getByTestId("book-window")).toHaveAttribute("data-symbol", SAMSUNG);
  await expect(page.getByTestId("order-vi-top")).toBeVisible();
  await expect(page.getByTestId("order-vi-sparkline").locator("rect.od-vi-spark-bar")).toHaveCount(2);
  await expect(page.getByTestId("order-vi-expected-latest")).toContainText("77,600");

  scenario.live.emit({
    type: "vi_update",
    state: { symbol: SAMSUNG, market: "krx", active: false, direction: "up", triggerPrice: 77_000, base: null, triggeredAt, releasedAt: REG_SEC },
  });
  await expect(page.getByTestId("order-vi-top")).toHaveCount(0);
});
