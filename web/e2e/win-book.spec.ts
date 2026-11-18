import type { Locator, Page } from "@playwright/test";
import type { FeedBook } from "../src/api/generated/FeedBook";
import type { FeedKind } from "../src/api/generated/FeedKind";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderBook } from "../src/api/generated/OrderBook";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test, windowTabs } from "./harness";
import { pinQuote } from "./order-window";

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

function replyBook(scenario: Scenario, base: number) {
  scenario.reply((url) => url.pathname === "/api/symbols/005930/fundamentals", { body: { symbol: CODE, upperLimit: 91000, lowerLimit: 49000, marketCap: null, listedShares: null, per: null, pbr: null, roe: null, eps: null, bps: null, foreignExhaustionRate: null, high52w: null, low52w: null } });
  scenario.reply((url) => url.pathname === "/api/symbols/005930/order-book", { body: snapshotOf(base) });
  scenario.reply((url) => url.pathname === "/api/symbols/005930/trades", { body: { symbol: CODE, venue: "combined", trades: [], skippedRows: 0 } });
  pinQuote(scenario, CODE, base, 1000);
}

async function tradesSubs(scenario: Scenario): Promise<string[]> {
  await expect.poll(() => scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "trades" && m.symbol === CODE).length).toBe(2);
  return scenario.live.messages.flatMap((m) => (m.type === "subscribe_feed" && m.kind === "trades" && m.symbol === CODE ? [m.sub] : []));
}

async function emitTrade(scenario: Scenario, seq: number, price: number, qty: number) {
  for (const sub of await tradesSubs(scenario)) scenario.live.emit({ type: "feed_trades", sub, seq, trades: [{ t: scenario.now / 1000 + seq, price, qty, venue: null, strength: 101.5 }] });
}

const tops = (locator: Locator) => locator.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top * 10) / 10));

async function open(page: Page, scenario: Scenario, base: number) {
  bookWindow(scenario, CODE);
  replyBook(scenario, base);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("스냅샷 20행이 현재가 중심 격자로 먼저 보이고 상·하한가와 기준가가 정보 자리에 있다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveText([
    "71,000", "70,900", "70,800", "70,700", "70,600", "70,500", "70,400", "70,300", "70,200", "70,100",
    "70,000", "69,900", "69,800", "69,700", "69,600", "69,500", "69,400", "69,300", "69,200", "69,100",
  ]);
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveCount(20);
  const info = page.getByTestId("ladder-info");
  await expect(info).toHaveCount(7);
  await expect(info.filter({ hasText: "상한가" })).toContainText("91,000");
  await expect(info.filter({ hasText: "하한가" })).toContainText("49,000");
  await expect(info.filter({ hasText: "기준가" })).toContainText("69,000");
  await expect(info.filter({ hasText: "현재가" })).toContainText("70,000");
  await expect(info.filter({ hasText: "전일대비" })).toContainText("+1,000");
  await expect(page.getByTestId("book-total-ask")).toHaveText("1,000주");
});

test("사다리 스무 행의 높이가 같고 가격 칸의 왼쪽 x가 현재가 행을 포함해 모두 같다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  const boxes = await ladderRows(page).evaluateAll((rows) => rows.map((row) => {
    const price = row.querySelector(".mw-px")!.getBoundingClientRect();
    return { height: row.getBoundingClientRect().height, left: Math.round(price.left * 10) / 10, width: Math.round(price.width * 10) / 10 };
  }));
  expect(boxes).toHaveLength(20);
  expect(new Set(boxes.map((box) => box.height))).toEqual(new Set([24]));
  expect(new Set(boxes.map((box) => box.left)).size).toBe(1);
  expect(new Set(boxes.map((box) => box.width)).size).toBe(1);
});

test("총잔량 띠가 사다리 아래에 있고 정보 7항목이 사다리 1~7행과 같은 top에 있다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await expect(page.getByTestId("ladder-info")).toHaveCount(7);
  const ladder = (await page.getByTestId("price-ladder").boundingBox())!;
  const strip = (await page.getByTestId("book-total-ask").boundingBox())!;
  expect(strip.y).toBeGreaterThanOrEqual(ladder.y + ladder.height);
  const rowTops = await tops(ladderRows(page));
  expect(await tops(page.getByTestId("ladder-info"))).toEqual(rowTops.slice(0, 7));
});

test("첫 실시간 호가가 스냅샷을 대신하고 체결이 현재가 행을 옮기며 증감 글자가 잔량 칸 안에 보인다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await expect(ladderRows(page)).toHaveCount(20);
  const bookSub = await subOf(scenario, "book");

  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70100, 50], [70200, 40]], [[70000, 80], [69900, 60]], [90, 140]) });
  await expect(page.getByTestId("book-total-bid")).toHaveText("140주");
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveCount(4);

  await emitTrade(scenario, 1, 70100, 3);
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,100");
  await expect(ladderRows(page).locator(".mw-px-num").nth(10)).toHaveText("70,100");

  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70100, 70], [70200, 40]], [[70000, 80], [69900, 10]], [110, 90]) });
  const ask = page.locator(".mw-qty[data-side=ask]").filter({ has: page.locator(".mw-qty-change") });
  const bid = page.locator(".mw-qty[data-side=bid]").filter({ has: page.locator(".mw-qty-change") });
  await expect(ask.locator(".mw-qty-change")).toHaveText("+20주");
  await expect(bid.locator(".mw-qty-change")).toHaveText("−50주");
  const within = async (cell: Locator, inner: Locator) => {
    const outer = (await cell.boundingBox())!;
    const box = (await inner.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(outer.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
    expect(box.y).toBeGreaterThanOrEqual(outer.y - 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height + 0.5);
  };
  await within(ask, ask.locator(".mw-qty-change"));
  await within(bid, bid.locator(".mw-qty-change"));
  const askChange = (await ask.locator(".mw-qty-change").boundingBox())!;
  const askValue = (await ask.locator(".mw-qty-value").boundingBox())!;
  expect(askChange.x + askChange.width).toBeLessThanOrEqual(askValue.x + 1);
  const bidChange = (await bid.locator(".mw-qty-change").boundingBox())!;
  const bidValue = (await bid.locator(".mw-qty-value").boundingBox())!;
  expect(bidValue.x + bidValue.width).toBeLessThanOrEqual(bidChange.x + 1);
  await expect(page.locator(".mw-qty-delta")).toHaveCount(0);
  const ratio = page.getByRole("img", { name: /^매도 110주 · 매수 90주$/ });
  await expect(ratio).toBeVisible();
});

test("체결강도 줄이 13행, 최근 체결 행이 14행부터의 top과 같고 대량 글자와 막대가 없으며 새 체결이 맨 위에 온다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await emitTrade(scenario, 1, 70000, 3);
  await emitTrade(scenario, 2, 70100, 1_200_000);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70100");
  await expect(page.getByTestId("ladder-strength")).toContainText("101.50%");
  const rowTops = await tops(ladderRows(page));
  expect(await tops(page.getByTestId("ladder-strength"))).toEqual([rowTops[12]]);
  expect(await tops(page.getByTestId("ladder-trade"))).toEqual(rowTops.slice(13, 15));
  await expect(page.getByTestId("book-window")).not.toContainText("대량");
  await expect(page.locator(".mw-trade [class*=bar], .mw-trade i")).toHaveCount(0);
  const columns = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => [...row.children].map((part) => Math.round(part.getBoundingClientRect().left * 10) / 10)));
  expect(columns[0]).toEqual(columns[1]);
  await emitTrade(scenario, 3, 70200, 5);
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70200");
  await expect(page.getByTestId("ladder-trade").nth(1)).toHaveAttribute("data-price", "70100");
});

test("교차 가격 행 하나에 매도·매수 잔량이 함께 있고 현재가 행은 하나다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const bookSub = await subOf(scenario, "book");
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70000, 30], [70100, 20]], [[70100, 25], [70000, 15]], [50, 40]) });
  await emitTrade(scenario, 1, 70100, 1);
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  const crossed = ladderRows(page).filter({ has: page.locator(".mw-px-num", { hasText: /^70,100$/ }) });
  await expect(crossed).toHaveCount(1);
  await expect(crossed.locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveText("20주");
  await expect(crossed.locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveText("25주");
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,100");
  const shown = await ladderRows(page).locator(".mw-px-num").allTextContents();
  expect(new Set(shown).size).toBe(shown.length);
});

test("ETF는 5원 호가 단위 격자로 받은 스무 단이 모두 자기 행에 보인다", async ({ page, scenario }) => {
  const etf = "0000D0";
  bookWindow(scenario, etf);
  scenario.reply((url) => url.pathname === `/api/symbols/${etf}/fundamentals`, { body: { symbol: etf, upperLimit: 45_500, lowerLimit: 24_500, marketCap: null, listedShares: null, per: null, pbr: null, roe: null, eps: null, bps: null, foreignExhaustionRate: null, high52w: null, low52w: null } });
  scenario.reply((url) => url.pathname === `/api/symbols/${etf}/order-book`, { body: {
    symbol: etf,
    asks: Array.from({ length: 10 }, (_, i) => ({ price: 35_010 + 5 * i, quantity: 100 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: 35_005 - 5 * i, quantity: 200 + i })),
    totalAskQuantity: 1000,
    totalBidQuantity: 1000,
    bookTime: null,
  } });
  scenario.reply((url) => url.pathname === `/api/symbols/${etf}/trades`, { body: { symbol: etf, venue: "combined", trades: [], skippedRows: 0 } });
  pinQuote(scenario, etf, 35_005, 5);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveCount(20);
  const shown = await ladderRows(page).locator(".mw-px-num").allTextContents();
  expect(shown[0]).toBe("35,055");
  expect(shown[10]).toBe("35,005");
  expect(shown[19]).toBe("34,960");
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

test("앱 거래소가 KRX이면 도킹 탭에 통합 표시가 있고 본문에는 없다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const bookTab = windowTabs(page).getByRole("tab", { name: /^10호가/ });
  await expect(bookTab.locator(".mw-integrated")).toHaveCount(0);
  await pickDesktopVenue(page, "KRX");
  await expect(bookTab.locator(".mw-integrated")).toHaveText("통합");
  await expect(book(page).locator(".mw-integrated")).toHaveCount(0);
  const tabBox = (await bookTab.boundingBox())!;
  const badgeBox = (await bookTab.locator(".mw-integrated").boundingBox())!;
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(tabBox.x + tabBox.width);
  await page.screenshot({ path: "../target/ux-screens/dock-tab-integrated.png" });
  const sibling = windowTabs(page).filter({ has: page.getByRole("tab", { name: /^10호가/ }) }).getByRole("tab").filter({ hasNotText: /^10호가/ }).first();
  await sibling.click();
  await expect(bookTab).toHaveAttribute("aria-selected", "false");
  await expect(bookTab.locator(".mw-integrated")).toHaveText("통합");
});

test("캔버스 배치에서 KRX이면 10호가 창에 통합 표시가 머리에 하나만 있다", async ({ page, scenario }) => {
  bookWindow(scenario, CODE);
  replyBook(scenario, 70000);
  scenario.documents.saveLayout({ ...scenario.documents.layout(DEFAULT_LAYOUT_ID), placement: { v: 1, dock: null, canvas: null }, revision: scenario.documents.layout(DEFAULT_LAYOUT_ID).revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "canvas" });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await pickDesktopVenue(page, "KRX");
  const frame = page.locator('[data-canvas-window="book"]');
  await expect(frame.locator(".mw-integrated")).toHaveCount(1);
  await expect(frame.locator(".window-head .mw-integrated")).toHaveText("통합");
});

test("지수 종목이면 빈 상태를 보이고 호가를 구독하지 않는다", async ({ page, scenario }) => {
  bookWindow(scenario, "IDX:001");
  await page.goto("/");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expect(page.getByText("이 창은 주식만 보입니다")).toBeVisible();
  expect(scenario.live.messages.filter((m) => m.type === "subscribe_feed")).toHaveLength(0);
});

const PREVIOUS_CLOSE_GAP = 1000;

function quoteAt(scenario: Scenario, price: number, t: number) {
  return { ...scenario.market.quote(CODE)!, price, change: PREVIOUS_CLOSE_GAP, t };
}

async function openWithQuote(page: Page, scenario: Scenario, base: number, quote: () => ReturnType<typeof quoteAt>) {
  bookWindow(scenario, CODE);
  replyBook(scenario, base);
  scenario.on((url) => url.pathname === "/api/quotes", () => ({ body: [quote()] }));
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
}

test("체결이 없어도 시세 조회 응답의 가격이 바뀌면 다음 조회 뒤 현재가 행이 옮겨 간다", async ({ page, scenario }) => {
  let price = 70000;
  await page.clock.install({ time: scenario.now });
  await openWithQuote(page, scenario, 70000, () => quoteAt(scenario, price, scenario.now / 1000));
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,000");
  price = 69900;
  await page.clock.fastForward(5000);
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("69,900");
});

test("시세보다 늦은 체결이 현재가이고 더 이른 체결은 시세를 바꾸지 못한다", async ({ page, scenario }) => {
  const quoteT = scenario.now / 1000;
  await openWithQuote(page, scenario, 70000, () => quoteAt(scenario, 70000, quoteT));
  const tradeSub = await subOf(scenario, "trades");
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,000");

  scenario.live.emit({ type: "feed_trades", sub: tradeSub, seq: 1, trades: [{ t: quoteT - 10, price: 70100, qty: 1, venue: null, strength: null }] });
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,000");

  scenario.live.emit({ type: "feed_trades", sub: tradeSub, seq: 2, trades: [{ t: quoteT + 10, price: 70200, qty: 1, venue: null, strength: null }] });
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,200");
});

test("구독 직후 끊김이 오면 호가가 오기 전에도 끊김을 보이고 사다리를 흐리게 한다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const bookSub = await subOf(scenario, "book");
  scenario.live.emit({ type: "feed_link", sub: bookSub, live: false, at: 1 });
  await expect(page.getByRole("status").filter({ hasText: "끊김" })).toBeVisible();
  await expect(page.locator(".bk-ladder")).toHaveAttribute("data-stale", "");
});

test("자리 부족 안내는 같은 구독의 구독 복구에서만 사라지고 다른 구독의 응답은 지우지 않는다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const bookSub = await subOf(scenario, "book");
  const tradesSub = (await tradesSubs(scenario))[0]!;
  const notice = page.getByRole("status").filter({ hasText: "실시간 자리가 부족" });
  scenario.live.emit({ type: "sub_error", sub: bookSub, code: "realtime_limit" });
  await expect(notice).toBeVisible();

  scenario.live.emit({ type: "feed_subscribed", sub: tradesSub, kind: "trades" });
  await expect(notice).toBeVisible();

  scenario.live.emit({ type: "feed_subscribed", sub: bookSub, kind: "book" });
  await expect(notice).toHaveCount(0);
});

function bookSubs(scenario: Scenario): string[] {
  return scenario.live.messages.flatMap((m) => (m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE ? [m.sub] : []));
}

async function reconnect(scenario: Scenario): Promise<string> {
  const before = bookSubs(scenario).length;
  scenario.live.close();
  await expect.poll(() => bookSubs(scenario).length).toBe(before + 1);
  return bookSubs(scenario).at(-1)!;
}

test("끊김을 들은 창이 소켓을 다시 이었을 때 세션이 살아 있으면 끊김이 풀린다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  scenario.live.emit({ type: "feed_link", sub: await subOf(scenario, "book"), live: false, at: 1 });
  await expect(page.getByRole("status").filter({ hasText: "끊김" })).toBeVisible();

  const resubscribed = await reconnect(scenario);
  scenario.live.emit({ type: "feed_subscribed", sub: resubscribed, kind: "book" });
  await expect(book(page)).toHaveAttribute("data-connected", "");
  await expect(page.getByRole("status").filter({ hasText: "끊김" })).toHaveCount(0);
  await expect(page.locator(".bk-ladder")).not.toHaveAttribute("data-stale", "");
});

test("세션이 내려간 채 소켓을 다시 이으면 끊김이 그대로 보인다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  scenario.live.emit({ type: "feed_link", sub: await subOf(scenario, "book"), live: false, at: 1 });
  await expect(page.getByRole("status").filter({ hasText: "끊김" })).toBeVisible();

  const resubscribed = await reconnect(scenario);
  scenario.live.emit({ type: "feed_subscribed", sub: resubscribed, kind: "book" });
  scenario.live.emit({ type: "feed_link", sub: resubscribed, live: false, at: 1 });
  await expect(page.getByRole("status").filter({ hasText: "끊김" })).toBeVisible();
  await expect(page.locator(".bk-ladder")).toHaveAttribute("data-stale", "");
});
