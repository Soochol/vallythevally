import type { Locator, Page } from "@playwright/test";
import type { FeedBook } from "../src/api/generated/FeedBook";
import type { FeedKind } from "../src/api/generated/FeedKind";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderBook } from "../src/api/generated/OrderBook";
import type { SymbolDaySummary } from "../src/api/generated/SymbolDaySummary";
import type { TradePrint } from "../src/api/generated/TradePrint";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test, windowTabs, pollSaved } from "./harness";
import { daySummaryOf } from "./fixtures/scenario";
import { feedSubscriptions, FUNDAMENTAL_FIGURES, INFO_PAGE_1, INFO_PAGE_2, INFO_PAGE_2_ENDS, INFO_PAGE_2_VALUES, infoCard, infoLabels, infoTab, infoValues, nxtTraded, pinQuote, requestedVenues, venueScene } from "./order-window";

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
    afterHoursAskQuantity: null,
    afterHoursBidQuantity: null,
    bookTime: null,
  };
}

function liveOf(asks: [number, number][], bids: [number, number][], totals: [number, number]): FeedBook {
  return { t: 1, asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), totalAskQty: totals[0], totalBidQty: totals[1], expected: null };
}

async function subOf(scenario: Scenario, kind: FeedKind): Promise<string> {
  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === kind && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  return sub;
}

function replyBook(scenario: Scenario, base: number, change = 1000, history: TradePrint[] = []) {
  scenario.reply((url) => url.pathname === "/api/symbols/005930/fundamentals", { body: { symbol: CODE, upperLimit: 91000, lowerLimit: 49000, ...FUNDAMENTAL_FIGURES } });
  scenario.reply((url) => url.pathname === "/api/symbols/005930/order-book", { body: snapshotOf(base) });
  scenario.reply((url) => url.pathname === "/api/symbols/005930/trades", { body: { symbol: CODE, venue: "combined", trades: history, skippedRows: 0 } });
  pinQuote(scenario, CODE, base, change);
}

async function tradesSubs(scenario: Scenario): Promise<string[]> {
  await pollSaved(() => scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "trades" && m.symbol === CODE).length).toBe(2);
  return scenario.live.messages.flatMap((m) => (m.type === "subscribe_feed" && m.kind === "trades" && m.symbol === CODE ? [m.sub] : []));
}

async function emitTrade(scenario: Scenario, seq: number, price: number, qty: number) {
  for (const sub of await tradesSubs(scenario)) scenario.live.emit({ type: "feed_trades", sub, seq, trades: [{ t: scenario.now / 1000 + seq, price, qty, venue: null, strength: 101.5 }] });
}

const tops = (locator: Locator) => locator.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top * 10) / 10));

async function open(page: Page, scenario: Scenario, base: number, change = 1000, history: TradePrint[] = [], summary: Partial<SymbolDaySummary> = {}) {
  bookWindow(scenario, CODE);
  replyBook(scenario, base, change, history);
  scenario.on((url) => url.pathname === "/api/symbols/005930/day-summary", () => {
    const quote = scenario.market.quote(CODE, "combined");
    return { body: quote ? { ...daySummaryOf({ ...quote, price: base, change }), ...summary } : null };
  });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

const CARD_ROW_HEIGHT = 24;
const rangeRatio = async (page: Page) => {
  const track = (await page.locator(".mw-range-track").boundingBox())!;
  const tick = (await page.getByTestId("ladder-info-tick").boundingBox())!;
  return (tick.x + tick.width / 2 - track.x) / track.width;
};

test("스냅샷 20행이 매도 1호가 기준 격자로 먼저 보이고 상세 정보 카드가 사다리 1~9행 자리에 있으며 시세 쪽에 시가·고가·저가·기준가·전일대비·거래량·거래대금 값이 맞다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await expect(ladderRows(page)).toHaveCount(20);
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveText([
    "71,000", "70,900", "70,800", "70,700", "70,600", "70,500", "70,400", "70,300", "70,200", "70,100",
    "70,000", "69,900", "69,800", "69,700", "69,600", "69,500", "69,400", "69,300", "69,200", "69,100",
  ]);
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveCount(20);
  const info = page.getByTestId("ladder-info");
  await expect(info).toHaveCount(7);
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  await expect(infoValues(page)).toHaveText(["69,900", "70,400", "69,400", "69,000", "+1,000 +1.45%", "123만", "864억"]);
  await expect(info.filter({ hasText: "전일대비" }).locator("b")).toHaveAttribute("data-tone", "up");
  await expect(info.filter({ hasText: "전일대비" })).toHaveAttribute("data-band", "up");
  await expect(page.getByTestId("book-total-ask")).toHaveText("1,000");

  const rowTops = await tops(ladderRows(page));
  const card = (await infoCard(page).boundingBox())!;
  const price = (await ladderRows(page).first().locator(".mw-px").boundingBox())!;
  expect(card.y).toBeCloseTo(rowTops[0]!, 0);
  expect(card.height).toBe(9 * CARD_ROW_HEIGHT);
  expect(card.x).toBeGreaterThanOrEqual(price.x + price.width - 1);
  expect(await tops(info)).toEqual([1, 2, 3, 5, 6, 7, 8].map((row) => rowTops[row]));
  await expect(page.getByTestId("ladder-info-range")).toHaveCount(1);
  await expect(page.getByRole("tablist", { name: "상세 정보" }).getByRole("tab")).toHaveText(["시세", "종목"]);
  await expect(infoTab(page, "시세")).toHaveAttribute("aria-selected", "true");
});

test("종목 탭을 누르면 상·하한가·52주 범위·시가총액·PER·PBR·외국인소진율이 보이고 시세 탭으로 돌아온다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);

  await page.getByTestId("ladder-info").nth(3).click();
  await expect(infoTab(page, "시세")).toHaveAttribute("aria-selected", "true");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);

  await infoTab(page, "종목").click();
  await expect(infoTab(page, "종목")).toHaveAttribute("aria-selected", "true");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  await expect(infoValues(page)).toHaveText(INFO_PAGE_2_VALUES);
  await expect(page.getByTestId("ladder-info-ends").locator("span")).toHaveText(INFO_PAGE_2_ENDS);
  await expect(page.getByTestId("ladder-info-range")).toHaveAttribute("data-label", "52주 범위");
  const rowTops = await tops(ladderRows(page));
  expect(await tops(page.getByTestId("ladder-info"))).toEqual([1, 2, 5, 6, 7].map((row) => rowTops[row]));
  expect((await infoCard(page).boundingBox())!.height).toBe(8 * CARD_ROW_HEIGHT);
  await expect(page.getByTestId("ladder-info").filter({ hasText: "하한가" }).locator("b")).toHaveAttribute("data-tone", "down");
  expect(await rangeRatio(page)).toBeCloseTo((70_000 - 51_000) / (88_000 - 51_000), 1);

  await infoTab(page, "시세").click();
  await expect(infoTab(page, "시세")).toHaveAttribute("aria-selected", "true");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
});

test("탭은 초점이 가면 화살표·Enter·Space로 바뀐다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await infoTab(page, "시세").focus();
  await page.keyboard.press("ArrowRight");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  await expect(infoTab(page, "종목")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  await expect(infoTab(page, "시세")).toBeFocused();
  await infoTab(page, "종목").focus();
  await page.keyboard.press("Enter");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  await infoTab(page, "시세").focus();
  await page.keyboard.press("Space");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
});

test("당일 범위 막대의 현재가 눈금이 (현재가−저가)/(고가−저가) 위치에 있다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await expect(page.getByTestId("ladder-info-tick")).toBeVisible();
  expect(Math.abs((await rangeRatio(page)) - (70_000 - 69_400) / (70_400 - 69_400))).toBeLessThan(0.02);
  await emitTrade(scenario, 1, 70_200, 1);
  await expect.poll(async () => Math.abs((await rangeRatio(page)) - (70_200 - 69_400) / (70_400 - 69_400))).toBeLessThan(0.02);
});

test("고가·저가가 없으면 당일 범위 막대가 없고 카드는 한 줄 줄어든다", async ({ page, scenario }) => {
  await open(page, scenario, 70000, 1000, [], { high: null, low: null });
  await expect(infoValues(page)).toHaveText(["69,900", "-", "-", "69,000", "+1,000 +1.45%", "123만", "864억"]);
  await expect(page.getByTestId("ladder-info-range")).toHaveCount(0);
  await expect(page.getByTestId("ladder-info-tick")).toHaveCount(0);
  expect((await infoCard(page).boundingBox())!.height).toBe(8 * CARD_ROW_HEIGHT);
});

test("교차 호가로 카드 자리 행에 매수 잔량이 있으면 잔량이 가려지지 않고 카드는 그 행 위까지만이다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const bookSub = await subOf(scenario, "book");
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70_100, 50], [70_200, 40], [70_300, 30], [70_400, 20]], [[70_700, 33], [70_000, 80], [69_900, 60]], [140, 173]) });
  const crossed = ladderRows(page).filter({ has: page.locator(".mw-px-num", { hasText: /^70,700$/ }) });
  await expect(crossed.locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveText("33");
  const rowTop = (await crossed.boundingBox())!.y;
  const card = (await infoCard(page).boundingBox())!;
  expect(card.y + card.height).toBeLessThanOrEqual(rowTop + 0.5);
  const crossedIndex = (await tops(ladderRows(page))).indexOf(Math.round(rowTop * 10) / 10);
  expect(card.height).toBe(crossedIndex * CARD_ROW_HEIGHT);
  await expect(page.getByTestId("ladder-info").filter({ hasText: "거래대금" })).toHaveCount(0);
});

const AUCTION_ASKS: [number, number][] = [[819_000, 934], [820_000, 1_533], [821_000, 418]];
const AUCTION_BIDS: [number, number][] = [[818_000, 3_012], [817_000, 61], [816_000, 57]];

const CAPTURE_LAST = 196_400;

async function openWithAskAtLast(page: Page, scenario: Scenario, wideBy = 0) {
  bookWindow(scenario, CODE);
  replyBook(scenario, CAPTURE_LAST);
  scenario.reply((url) => url.pathname === "/api/symbols/005930/fundamentals", { body: { symbol: CODE, upperLimit: 255_000, lowerLimit: 137_000, marketCap: null, listedShares: null, per: null, pbr: null, roe: null, eps: null, bps: null, foreignExhaustionRate: null, high52w: null, low52w: null } });
  scenario.reply((url) => url.pathname === "/api/symbols/005930/order-book", { body: {
    ...snapshotOf(CAPTURE_LAST),
    asks: Array.from({ length: 10 }, (_, i) => ({ price: CAPTURE_LAST + 100 * i, quantity: 10 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: CAPTURE_LAST - 100 - wideBy - 100 * i, quantity: 20 + i })),
  } });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
}

const MID_SLOT = (page: Page, side: "ask" | "bid") => ladderRows(page).locator(`.mw-qty[data-side=${side}] .mw-qty-value`);

test("매도 1호가가 현재가와 같아도 매도 10단은 가운데 선 위, 매수 10단은 아래에 모두 보인다", async ({ page, scenario }) => {
  await openWithAskAtLast(page, scenario);
  const prices = ladderRows(page).locator(".mw-px-num");
  await expect(prices).toHaveCount(20);
  await expect(prices.nth(0)).toHaveText("197,300");
  await expect(prices.nth(9)).toHaveText("196,400");
  await expect(prices.nth(10)).toHaveText("196,300");
  await expect(prices.nth(19)).toHaveText("195,400");
  await expect(MID_SLOT(page, "ask")).toHaveCount(10);
  await expect(MID_SLOT(page, "bid")).toHaveCount(10);
  await expect(ladderRows(page).nth(9).locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveCount(1);
  await expect(ladderRows(page).nth(10).locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveCount(1);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("196,400");
});

test("호가 사이 빈 가격 건너뛰기가 켜져 있으면 10호가창도 벌어진 호가에서 매수 1호가를 가운데 선 바로 아래 행에 둔다", async ({ page, scenario }) => {
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), orderSettings: { skipSpreadGap: true } });
  await openWithAskAtLast(page, scenario, 200);
  const prices = ladderRows(page).locator(".mw-px-num");
  await expect(prices.nth(9)).toHaveText("196,400");
  await expect(prices.nth(10)).toHaveText("196,100");
  await expect(prices.nth(19)).toHaveText("195,200");
  await expect(MID_SLOT(page, "bid")).toHaveCount(10);
  await expect(MID_SLOT(page, "ask")).toHaveCount(10);
});

test("호가 사이 빈 가격 건너뛰기가 꺼져 있으면 10호가창은 벌어진 호가에서 빈 가격 행을 둔다", async ({ page, scenario }) => {
  await openWithAskAtLast(page, scenario, 200);
  const prices = ladderRows(page).locator(".mw-px-num");
  await expect(prices.nth(10)).toHaveText("196,300");
  await expect(ladderRows(page).nth(10).locator(".mw-qty-value")).toHaveCount(0);
  await expect(MID_SLOT(page, "bid")).toHaveCount(8);
});

test("동시호가 6호가는 매도 3단이 가운데 선 위, 매수 3단이 아래 행에 놓이고 정보 일곱 칸이 모두 보인다", async ({ page, scenario }) => {
  await open(page, scenario, 810_000);
  const bookSub = await subOf(scenario, "book");
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf(AUCTION_ASKS, AUCTION_BIDS, [2_885, 3_130]) });
  await expect(page.getByTestId("book-total-bid")).toHaveText("3,130");
  await expect(ladderRows(page)).toHaveCount(20);
  const priceAt = (row: number) => ladderRows(page).nth(row).locator(".mw-px-num");
  await expect(priceAt(7)).toHaveText("821,000");
  await expect(priceAt(8)).toHaveText("820,000");
  await expect(priceAt(9)).toHaveText("819,000");
  await expect(priceAt(10)).toHaveText("818,000");
  await expect(priceAt(11)).toHaveText("817,000");
  await expect(priceAt(12)).toHaveText("816,000");
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(6);
  await expect(ladderRows(page).nth(7).locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveText("418");
  const bids = page.locator('.mw-lr[data-side="bid"] .mw-qty[data-side=bid] .mw-qty-value');
  await expect(bids).toHaveText(["3,012", "61", "57"]);
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveCount(6);
  const info = page.getByTestId("ladder-info");
  await expect(info).toHaveCount(7);
  for (const label of INFO_PAGE_1) await expect(info.filter({ hasText: label })).toBeVisible();
});

test("교차 동시호가 6호가에서 같은 가격이 두 행에 있어도 현재가 행은 하나다", async ({ page, scenario }) => {
  await open(page, scenario, 70_000);
  const bookSub = await subOf(scenario, "book");
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70_000, 30], [70_100, 20], [70_200, 10]], [[70_100, 25], [70_000, 15], [69_900, 5]], [60, 45]) });
  await emitTrade(scenario, 1, 70_100, 1);
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(6);
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,100");
});

test("동시호가 6호가 뒤에 10단 호가가 오면 매도 1호가 기준 격자로 돌아간다", async ({ page, scenario }) => {
  bookWindow(scenario, CODE);
  replyBook(scenario, 810_000);
  scenario.reply((url) => url.pathname === "/api/symbols/005930/fundamentals", { body: { symbol: CODE, upperLimit: 1_053_000, lowerLimit: 567_000, marketCap: null, listedShares: null, per: null, pbr: null, roe: null, eps: null, bps: null, foreignExhaustionRate: null, high52w: null, low52w: null } });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  const bookSub = await subOf(scenario, "book");
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf(AUCTION_ASKS, AUCTION_BIDS, [2_885, 3_130]) });
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(6);
  const asks = Array.from({ length: 10 }, (_, i): [number, number] => [811_000 + 1_000 * i, 10 + i]);
  const bids = Array.from({ length: 10 }, (_, i): [number, number] => [810_000 - 1_000 * i, 20 + i]);
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf(asks, bids, [1_000, 3_000]) });
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(20);
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("810,000");
});

test("가격이 빈 단이 낀 0D 프레임이 와도 사다리 잔량 칸이 비지 않고 6호가로 바뀌지 않는다", async ({ page, scenario }) => {
  await open(page, scenario, 70_000);
  const bookSub = await subOf(scenario, "book");
  const asks = Array.from({ length: 10 }, (_, i): [number, number] => [70_100 + 100 * i, 10 + i]);
  const bids = Array.from({ length: 10 }, (_, i): [number, number] => [70_000 - 100 * i, 20 + i]);
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf(asks, bids, [1_000, 3_000]) });
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveCount(20);
  const shown = await ladderRows(page).locator(".mw-qty-value").allTextContents();
  const holed: FeedBook = { ...liveOf(asks, bids, [1_000, 3_000]), t: 2 };
  holed.asks[3] = null;
  holed.asks[4] = null;
  holed.bids[5] = null;
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: holed });
  await expect(ladderRows(page).locator(".mw-px-num")).toHaveCount(20);
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveText(shown);
});

test("상한가에 매도 호가가 정말 없으면 매도 쪽이 비고 매수는 그대로 보인다", async ({ page, scenario }) => {
  await open(page, scenario, 70_000);
  const bookSub = await subOf(scenario, "book");
  const asks = Array.from({ length: 10 }, (_, i): [number, number] => [70_100 + 100 * i, 10 + i]);
  const bids = Array.from({ length: 10 }, (_, i): [number, number] => [70_000 - 100 * i, 20 + i]);
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf(asks, bids, [1_000, 3_000]) });
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveCount(20);
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: { ...liveOf([], bids, [0, 3_000]), asks: Array(10).fill(null), t: 2 } });
  await expect(ladderRows(page).locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveCount(0);
  await expect(ladderRows(page).locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveCount(10);
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

test("총잔량 띠가 사다리 아래에 있고 정보 7항목이 카드 안 사다리 1~9행 자리에 있다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await expect(page.getByTestId("ladder-info")).toHaveCount(7);
  const ladder = (await page.getByTestId("price-ladder").boundingBox())!;
  const strip = (await page.getByTestId("book-total-ask").boundingBox())!;
  expect(strip.y).toBeGreaterThanOrEqual(ladder.y + ladder.height);
  const rowTops = await tops(ladderRows(page));
  expect(await tops(page.getByTestId("ladder-info"))).toEqual([1, 2, 3, 5, 6, 7, 8].map((row) => rowTops[row]));
});

test("첫 실시간 호가가 스냅샷을 대신하고 체결이 현재가 행을 옮기며 증감 글자가 잔량 칸 안에 보인다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await expect(ladderRows(page)).toHaveCount(20);
  const bookSub = await subOf(scenario, "book");

  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70100, 50], [70200, 40], [70300, 30], [70400, 20]], [[70000, 80], [69900, 60]], [90, 140]) });
  await expect(page.getByTestId("book-total-bid")).toHaveText("140");
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveCount(6);

  await emitTrade(scenario, 1, 70100, 3);
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await expect(page.locator(".mw-lr[data-current]")).toContainText("70,100");
  await expect(ladderRows(page).locator(".mw-px-num").nth(9)).toHaveText("70,100");

  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70100, 70], [70200, 40], [70300, 30], [70400, 20]], [[70000, 80], [69900, 10]], [110, 90]) });
  const ask = page.locator(".mw-qty[data-side=ask]").filter({ has: page.locator(".mw-qty-change") });
  const bid = page.locator(".mw-qty[data-side=bid]").filter({ has: page.locator(".mw-qty-change") });
  await expect(ask.locator(".mw-qty-change")).toHaveText("+20");
  await expect(bid.locator(".mw-qty-change")).toHaveText("−50");
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
  const askCell = (await ask.boundingBox())!;
  expect(askChange.x - askCell.x).toBeLessThanOrEqual(6);
  const bidChange = (await bid.locator(".mw-qty-change").boundingBox())!;
  const bidValue = (await bid.locator(".mw-qty-value").boundingBox())!;
  expect(bidValue.x + bidValue.width).toBeLessThanOrEqual(bidChange.x + 1);
  const bidCell = (await bid.boundingBox())!;
  expect(bidCell.x + bidCell.width - (bidChange.x + bidChange.width)).toBeLessThanOrEqual(6);
  await expect(ladderRows(page).locator(".mw-qty-value").filter({ hasText: "주" })).toHaveCount(0);
  const glowAlpha = await ask.locator(".mw-qty-glow").evaluate((glow) => {
    const color = getComputedStyle(glow).backgroundColor;
    const slash = color.match(/\/\s*([\d.]+)\s*\)/);
    if (slash) return Number(slash[1]);
    const parts = color.match(/rgba\(([^)]+)\)/);
    return parts ? Number(parts[1]!.split(",")[3]) : 1;
  });
  expect(glowAlpha).toBeLessThanOrEqual(0.2);
  await expect(page.locator(".mw-qty-delta")).toHaveCount(0);
  const ratio = page.getByRole("img", { name: /^매도 110 · 매수 90$/ });
  await expect(ratio).toBeVisible();
});

async function emitTrades(scenario: Scenario, seq: number, trades: [price: number, qty: number][]) {
  for (const sub of await tradesSubs(scenario)) scenario.live.emit({ type: "feed_trades", sub, seq, trades: trades.map(([price, qty], index) => ({ t: scenario.now / 1000 + seq + index / 100, price, qty, venue: null, strength: 101.5 })) });
}

const colorOf = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).color);
const tokenColor = (page: Page, token: string) => page.evaluate((name) => {
  const probe = document.createElement("i");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, token);
const tradeRow = (page: Page, price: number) => page.locator(`[data-testid=ladder-trade][data-price="${price}"]`);
const ladderPrice = (page: Page, price: number) => ladderRows(page).filter({ has: page.locator(".mw-px-num", { hasText: new RegExp(`^${price.toLocaleString("en-US")}$`) }) }).locator(".mw-px");

test("체결강도 줄이 11행, 체결 행이 12행부터의 top에 24px 간격으로 있고 왼쪽 테두리와 대량 글자·막대가 없으며 새 체결이 맨 위에 온다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const before = await tops(ladderRows(page));
  await emitTrade(scenario, 1, 70000, 3);
  await emitTrade(scenario, 2, 70100, 1_200_000);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70100");
  await expect(page.getByTestId("ladder-strength")).toContainText("101.50%");
  const rowTops = await tops(ladderRows(page));
  expect(rowTops).toEqual(before);
  expect(await tops(page.getByTestId("ladder-strength"))).toEqual([rowTops[10]]);
  expect(await tops(page.getByTestId("ladder-trade"))).toEqual(rowTops.slice(11, 13));
  const tradeParts = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => ({ count: row.children.length, text: row.textContent ?? "", border: getComputedStyle(row).borderLeftWidth, qtyTopAtOverlap: (() => {
    const qtyRect = row.children[1]!.getBoundingClientRect();
    const priceText = document.createRange();
    priceText.selectNodeContents(row.children[0]!.firstChild!);
    if (priceText.getBoundingClientRect().right <= qtyRect.left) return "none";
    return document.elementFromPoint(qtyRect.left + 1, qtyRect.top + qtyRect.height / 2) === row.children[1] ? "qty" : "other";
  })() })));
  for (const part of tradeParts) {
    expect(part.count).toBe(2);
    expect(part.border).toBe("0px");
    expect(part.text).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(["none", "qty"], JSON.stringify(part)).toContain(part.qtyTopAtOverlap);
  }
  await expect(page.getByTestId("book-window")).not.toContainText("대량");
  await expect(page.locator(".mw-trade [class*=bar], .mw-trade i")).toHaveCount(0);
  const columns = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => [row.children[0]!.getBoundingClientRect().left, row.children[1]!.getBoundingClientRect().right].map((x) => Math.round(x * 10) / 10)));
  expect(columns[0]).toEqual(columns[1]);
  await emitTrade(scenario, 3, 70200, 5);
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70200");
  await expect(page.getByTestId("ladder-trade").nth(1)).toHaveAttribute("data-price", "70100");
});

test("체결 수량은 매수 상승색·매도 하락색·방향 없음 기본색이고 가격은 같은 가격의 사다리 가격 칸과 같은 색이다", async ({ page, scenario }) => {
  await open(page, scenario, 70000, 0);
  await emitTrades(scenario, 1, [[70100, -4], [69900, 5], [70000, 6], [70200, 0]]);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(4);
  const [up, down, text] = await Promise.all([tokenColor(page, "--up"), tokenColor(page, "--down"), tokenColor(page, "--text")]);
  expect(up).not.toBe(down);
  expect(await colorOf(tradeRow(page, 70100).locator(".mw-trade-qty"))).toBe(down);
  expect(await colorOf(tradeRow(page, 69900).locator(".mw-trade-qty"))).toBe(up);
  expect(await colorOf(tradeRow(page, 70000).locator(".mw-trade-qty"))).toBe(up);
  const noSide = await colorOf(tradeRow(page, 70200).locator(".mw-trade-qty"));
  expect([up, down]).not.toContain(noSide);
  const priceColors = new Map<number, string>();
  for (const price of [70100, 69900, 70000]) {
    const traded = await colorOf(tradeRow(page, price).locator(".mw-trade-price"));
    expect(traded).toBe(await colorOf(ladderPrice(page, price)));
    priceColors.set(price, traded);
  }
  expect(priceColors.get(70100)).toBe(up);
  expect(priceColors.get(69900)).toBe(down);
  expect(priceColors.get(70000)).not.toBe(up);
  expect(priceColors.get(70000)).not.toBe(down);
  expect(text).toBeTruthy();
});

test("체결이 8건보다 많으면 상자 안에서 스크롤되고 스크롤바가 보이며 체결강도 줄은 제자리다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await emitTrades(scenario, 1, Array.from({ length: 14 }, (_, i) => [70000 + i, 1 + i]));
  await expect(page.getByTestId("ladder-trade")).toHaveCount(14);
  const box = page.getByTestId("ladder-trades");
  const metrics = await box.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight, overflowY: getComputedStyle(element).overflowY, barWidth: getComputedStyle(element, "::-webkit-scrollbar").width, barHidden: getComputedStyle(element).scrollbarWidth === "none" }));
  expect(metrics.scroll).toBeGreaterThan(metrics.client);
  expect(metrics).toMatchObject({ overflowY: "auto", barWidth: "5px", barHidden: false });
  const strengthTop = await tops(page.getByTestId("ladder-strength"));
  const rowTops = await tops(ladderRows(page));
  await box.evaluate((element) => { element.scrollTop = 72; });
  expect(await tops(page.getByTestId("ladder-strength"))).toEqual(strengthTop);
  expect(await tops(ladderRows(page))).toEqual(rowTops);
});

test("체결이 8건보다 많아 스크롤바가 보일 때 체결량 오른쪽 끝과 스크롤바 왼쪽 사이가 6px 이상이다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await emitTrades(scenario, 1, Array.from({ length: 14 }, (_, i) => [70000 + i, 1 + i]));
  await expect(page.getByTestId("ladder-trade")).toHaveCount(14);
  const gaps = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => {
    const scroller = row.parentElement!;
    const barLeft = scroller.getBoundingClientRect().left + scroller.clientWidth;
    return barLeft - row.children[1]!.getBoundingClientRect().right;
  }));
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(5.99);
  await bookGroup(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "420px"; });
  const lines = await page.getByTestId("ladder-strength").evaluate((element) => {
    const text = document.createRange();
    text.selectNodeContents(element.querySelector("b")!);
    const qty = document.querySelector("[data-testid=ladder-trade] .mw-trade-qty")!.getBoundingClientRect();
    return { strength: text.getBoundingClientRect().right, qty: qty.right };
  });
  expect(Math.abs(lines.strength - lines.qty)).toBeLessThan(1);
});

test("스크롤을 내린 동안 새 체결이 와도 보던 행이 그대로이고 맨 위로 올리면 새 체결이 맨 위에 보인다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await emitTrades(scenario, 1, Array.from({ length: 14 }, (_, i) => [70000 + i, 1 + i]));
  await expect(page.getByTestId("ladder-trade")).toHaveCount(14);
  const box = page.getByTestId("ladder-trades");
  await box.evaluate((element) => { element.scrollTop = 72; });
  await expect(box).toHaveAttribute("data-held", "");
  const seen = () => box.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const visible = [...element.children].find((row) => row.getBoundingClientRect().bottom > top + 1);
    return visible?.getAttribute("data-price") ?? null;
  });
  const first = await seen();
  expect(first).toBe("70010");
  await emitTrades(scenario, 2, [[70001, 9]]);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(14);
  expect(await seen()).toBe(first);
  await box.evaluate((element) => { element.scrollTop = 0; });
  await expect(box).not.toHaveAttribute("data-held", "");
  await expect(page.getByTestId("ladder-trade")).toHaveCount(15);
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70001");
});

test("창을 열면 지난 체결을 pages=1로 한 번 받아 실시간 없이 보이고 지난 체결 요청에 limit도 싣는다", async ({ page, scenario }) => {
  await open(page, scenario, 70000, 1000, [{ time: "09:30:02", price: 70100, quantity: 7, exchange: "krx" }, { time: "09:30:01", price: 70000, quantity: -3, exchange: "krx" }]);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  await expect(page.getByTestId("ladder-trade").first()).toHaveAttribute("data-price", "70100");
  const asked = scenario.requests.map((r) => new URL(r.url())).filter((url) => url.pathname === `/api/symbols/${CODE}/trades`);
  expect(asked.map((url) => url.searchParams.get("pages"))).toEqual(["1"]);
});

test("10호가창의 좁은 상자에서도 수량은 7자리까지 끝까지 보이고 겹친 가격 위에 놓인다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const trades: [number, number][] = [[70_000, 7], [70_100, 600], [70_200, 9_999], [70_300, 12_345], [1_234_000, 999_999], [9_999_000, 9_999_999]];
  for (const [index, [price, qty]] of trades.entries()) await emitTrade(scenario, index + 1, price, qty);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(trades.length);
  const parts = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => {
    const [price, qty] = [row.children[0]!, row.children[1]!];
    const box = row.parentElement!.getBoundingClientRect();
    const qtyRect = qty.getBoundingClientRect();
    const priceText = document.createRange();
    priceText.selectNodeContents(price.firstChild!);
    const overlaps = priceText.getBoundingClientRect().right > qtyRect.left;
    const probe = overlaps ? document.elementFromPoint(qtyRect.left + 1, qtyRect.top + qtyRect.height / 2) : null;
    return { shown: qty.textContent, fontSize: getComputedStyle(qty).fontSize, scroll: qty.scrollWidth <= qty.clientWidth, inside: qtyRect.left >= box.left && qtyRect.right <= box.right, background: getComputedStyle(qty).backgroundColor, top: probe === null ? null : probe === qty ? "qty" : "other", priceLeft: Math.round(price.getBoundingClientRect().left * 10), qtyRight: Math.round(qtyRect.right * 10) };
  }));
  expect(parts.map((part) => part.shown)).toEqual(["9,999,999", "999,999", "12,345", "9,999", "600", "7"]);
  for (const part of parts) {
    const note = JSON.stringify(part);
    expect(part.fontSize).toBe("11px");
    expect(part.scroll, note).toBe(true);
    expect(part.inside, note).toBe(true);
    expect(part.background, note).toBe("rgb(20, 25, 20)");
    if (part.top !== null) expect(part.top, note).toBe("qty");
  }
  expect(new Set(parts.map((part) => part.priceLeft)).size).toBe(1);
  expect(new Set(parts.map((part) => part.qtyRight)).size).toBe(1);
});

const bookGroup = (page: Page) => page.locator("[data-dock-group]").filter({ has: book(page) });

test("10호가창을 최소 폭 280px까지 줄여도 7자리 가격 옆 7자리 수량이 상자 오른쪽 끝에 붙어 끝까지 보인다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const handle = (await page.getByRole("separator", { name: "좌우 창 경계" }).first().boundingBox())!;
  const at = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await page.keyboard.down("Alt");
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(1440, at.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await bookGroup(page).boundingBox())!.width).toBe(280);
  const trades: [number, number][] = [[70_000, 7], [70_100, 600], [1_234_000, 999_999], [9_999_000, 9_999_999], [70_700, 4_444_444]];
  for (const [index, [price, qty]] of trades.entries()) await emitTrade(scenario, index + 1, price, qty);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(trades.length);
  const parts = await page.getByTestId("ladder-trade").evaluateAll((rows) => rows.map((row) => {
    const qty = row.children[1]!;
    const box = row.parentElement!.getBoundingClientRect();
    const rect = qty.getBoundingClientRect();
    return { shown: qty.textContent, left: rect.left - box.left, right: rect.right - box.right, scroll: qty.scrollWidth <= qty.clientWidth };
  }));
  for (const part of parts) {
    const note = JSON.stringify(part);
    expect(part.left, note).toBeGreaterThanOrEqual(-1);
    expect(part.right, note).toBeLessThanOrEqual(0.01);
    expect(part.scroll, note).toBe(true);
  }
});

test("교차 가격 행 하나에 매도·매수 잔량이 함께 있고 현재가 행은 하나다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  const bookSub = await subOf(scenario, "book");
  scenario.live.emit({ type: "feed_book", sub: bookSub, book: liveOf([[70000, 30], [70100, 20], [70200, 10], [70300, 5]], [[70100, 25], [70000, 15]], [65, 40]) });
  await emitTrade(scenario, 1, 70100, 1);
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  const crossed = ladderRows(page).filter({ has: page.locator(".mw-px-num", { hasText: /^70,100$/ }) });
  await expect(crossed).toHaveCount(1);
  await expect(crossed.locator(".mw-qty[data-side=ask] .mw-qty-value")).toHaveText("20");
  await expect(crossed.locator(".mw-qty[data-side=bid] .mw-qty-value")).toHaveText("25");
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

test("위 막대 거래소를 KRX로 바꾸면 호가·체결을 krx로 다시 구독하고 order-book?venue=krx의 KRX 사다리를 보인다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  venueScene(scenario, { krx: 60000 }, 1000);
  await expect(ladderRows(page).locator(".mw-px-num").first()).toHaveText("71,000");
  await pollSaved(() => feedSubscriptions(scenario, "book", "combined").length).toBe(1);
  await pickDesktopVenue(page, "KRX");
  await pollSaved(() => feedSubscriptions(scenario, "book", "krx").length).toBe(1);
  await pollSaved(() => feedSubscriptions(scenario, "trades", "krx").length).toBe(2);
  await expect(ladderRows(page).locator(".mw-px-num").first()).toHaveText("61,000");
  await expect(page.locator(".mw-lr[data-current]")).toContainText("60,000");
  expect(requestedVenues(scenario, "/api/symbols/005930/order-book")).toEqual(["combined", "krx"]);
  expect(requestedVenues(scenario, "/api/symbols/005930/trades")).toContain("krx");
  const subOfMessage = (m: (typeof scenario.live.messages)[number]) => ("sub" in m ? m.sub : "");
  const unsubscribed = scenario.live.messages.filter((m) => m.type === "unsubscribe").map(subOfMessage);
  expect(unsubscribed).toEqual(expect.arrayContaining([...feedSubscriptions(scenario, "book", "combined"), ...feedSubscriptions(scenario, "trades", "combined")].map(subOfMessage)));
});

test("거래소를 바꾼 뒤 앞 거래소 구독으로 온 호가는 사다리에 반영되지 않는다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  venueScene(scenario, { krx: 60000 }, 1000);
  const combinedSub = await subOf(scenario, "book");
  await pickDesktopVenue(page, "KRX");
  await expect(ladderRows(page).locator(".mw-px-num").first()).toHaveText("61,000");
  scenario.live.emit({ type: "feed_book", sub: combinedSub, book: liveOf([[99_900, 5]], [[99_800, 5]], [5, 5]) });
  const krxSub = feedSubscriptions(scenario, "book", "krx")[0];
  if (krxSub?.type !== "subscribe_feed") throw new Error("KRX 호가 구독이 없습니다");
  scenario.live.emit({ type: "feed_book", sub: krxSub.sub, book: liveOf([[60_100, 11]], [[60_000, 22]], [11, 22]) });
  await expect(ladderRows(page).locator(".mw-qty-value")).toHaveText(["11", "22"]);
  await expect(book(page)).not.toContainText("99,900");
});

async function emitCombinedTrade(scenario: Scenario, price: number, strength: number) {
  await pollSaved(() => feedSubscriptions(scenario, "trades", "combined").length).toBe(2);
  for (const message of feedSubscriptions(scenario, "trades", "combined")) if (message.type === "subscribe_feed") scenario.live.emit({ type: "feed_trades", sub: message.sub, seq: 1, trades: [{ t: scenario.now / 1000, price, qty: 3, venue: "nxt", strength }] });
}

test("거래소를 바꾸면 앞 거래소의 체결강도가 사다리에 남지 않는다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await emitCombinedTrade(scenario, 70000, 150);
  await expect(page.getByTestId("ladder-strength")).toContainText("150.00%");
  await pickDesktopVenue(page, "KRX");
  await pollSaved(() => feedSubscriptions(scenario, "trades", "krx").length).toBe(2);
  await expect(page.getByTestId("ladder-strength")).not.toContainText("150.00%");
});

test("새 거래소의 지난 체결 조회가 실패해도 앞 거래소의 체결이 사다리에 남지 않는다", async ({ page, scenario }) => {
  await open(page, scenario, 70000);
  await emitCombinedTrade(scenario, 70300, 150);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(1);
  scenario.on((url) => url.pathname === "/api/symbols/005930/trades" && url.searchParams.get("venue") === "krx", () => ({ status: 503, body: { error: { code: "internal", message: "지난 체결 조회 실패", reason: null, retryAt: null, manualActionRequired: false } } }));
  await pickDesktopVenue(page, "KRX");
  await pollSaved(() => requestedVenues(scenario, "/api/symbols/005930/trades").filter((venue) => venue === "krx").length).toBe(1);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(0);
});

test("NXT에서 거래되지 않는 종목을 NXT로 보면 통합으로 구독하고 도킹 탭에 통합 표시가 있고 본문에는 없다", async ({ page, scenario }) => {
  nxtTraded(scenario, false);
  await open(page, scenario, 70000);
  const bookTab = windowTabs(page).getByRole("tab", { name: /^10호가/ });
  await expect(bookTab.locator(".mw-integrated")).toHaveCount(0);
  await pickDesktopVenue(page, "NXT");
  await expect(bookTab.locator(".mw-integrated")).toHaveText("통합");
  await expect(book(page).locator(".mw-integrated")).toHaveCount(0);
  expect(feedSubscriptions(scenario, "book", "nxt")).toHaveLength(0);
  expect(feedSubscriptions(scenario, "book", "combined")).toHaveLength(1);
  expect(requestedVenues(scenario, "/api/symbols/005930/order-book")).toEqual(["combined"]);
  const tabBox = (await bookTab.boundingBox())!;
  const badgeBox = (await bookTab.locator(".mw-integrated").boundingBox())!;
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(tabBox.x + tabBox.width);
  await page.screenshot({ path: "../target/ux-screens/dock-tab-integrated.png" });
  const sibling = windowTabs(page).filter({ has: page.getByRole("tab", { name: /^10호가/ }) }).getByRole("tab").filter({ hasNotText: /^10호가/ }).first();
  await sibling.click();
  await expect(bookTab).toHaveAttribute("aria-selected", "false");
  await expect(bookTab.locator(".mw-integrated")).toHaveText("통합");
});

test("NXT에서 거래되는 종목을 KRX로 보면 10호가 도킹 탭에 통합 표시가 없다", async ({ page, scenario }) => {
  nxtTraded(scenario, true);
  await open(page, scenario, 70000);
  const bookTab = windowTabs(page).getByRole("tab", { name: /^10호가/ });
  await pickDesktopVenue(page, "KRX");
  await pollSaved(() => feedSubscriptions(scenario, "book", "krx").length).toBe(1);
  await expect(bookTab.locator(".mw-integrated")).toHaveCount(0);
  await expect(book(page).locator(".mw-integrated")).toHaveCount(0);
});

test("캔버스 배치에서 NXT 불가 종목을 NXT로 보면 10호가 창에 통합 표시가 머리에 하나만 있다", async ({ page, scenario }) => {
  nxtTraded(scenario, false);
  bookWindow(scenario, CODE);
  replyBook(scenario, 70000);
  scenario.documents.saveLayout({ ...scenario.documents.layout(DEFAULT_LAYOUT_ID), placement: { v: 1, dock: null, canvas: null }, revision: scenario.documents.layout(DEFAULT_LAYOUT_ID).revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "canvas" });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await pickDesktopVenue(page, "NXT");
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
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/day-summary`, () => ({ body: daySummaryOf(quote()) }));
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
}

test("10호가창의 당일 요약 조회는 한 번이고 /api/quotes는 부르지 않으며 5초 새로 고침도 한 번이다", async ({ page, scenario }) => {
  await page.clock.install({ time: scenario.now });
  await openWithQuote(page, scenario, 70000, () => quoteAt(scenario, 70000, scenario.now / 1000));
  const summaries = () => scenario.requests.filter((r) => new URL(r.url()).pathname === `/api/symbols/${CODE}/day-summary`).length;
  const quotes = () => scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/quotes").length;
  await pollSaved(summaries).toBe(1);
  const quotesBefore = quotes();
  await page.clock.fastForward(5000);
  await pollSaved(summaries).toBe(2);
  expect(quotes()).toBe(quotesBefore);
});

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
  await pollSaved(() => bookSubs(scenario).length).toBe(before + 1);
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

test.describe("동시호가 예상체결", () => {
  const EXPECTED = { price: 70_000, qty: 300 };
  const info = (page: Page, label: string) => page.getByTestId("ladder-info").and(page.locator(`[data-label="${label}"]`));
  const shape = async (page: Page) => ({
    count: await ladderRows(page).count(),
    firstTop: (await ladderRows(page).first().boundingBox())!.y,
    currentTop: (await page.locator(".mw-lr[data-current]").boundingBox())!.y,
  });
  const frame = (scenario: Scenario, asks: [number, number][], bids: [number, number][], expected: FeedBook["expected"]): FeedBook => ({ ...liveOf(asks, bids, [90, 140]), t: scenario.now / 1000, expected });

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test.describe("수요일 08:55", () => {
    test.use({ clockStart: "20261118085500" });

    test("교차가 없으면 카드 맨 아래 두 줄에 예상체결 두 항목이 경고색으로 보이고 행 강조가 있으며 사다리는 밀리지 않는다", async ({ page, scenario }) => {
      await open(page, scenario, 70000);
      const bookSub = await subOf(scenario, "book");
      scenario.live.emit({ type: "feed_book", sub: bookSub, book: frame(scenario, [[70100, 50], [70200, 40]], [[70000, 80], [69900, 60]], null) });
      await expect(page.getByTestId("book-total-bid")).toHaveText("140");
      await expect(page.locator("[data-expected]")).toHaveCount(0);
      const without = await shape(page);

      scenario.live.emit({ type: "feed_book", sub: bookSub, book: frame(scenario, [[70100, 50], [70200, 40]], [[70000, 80], [69900, 60]], EXPECTED) });
      await expect(info(page, "예상체결가").locator("b")).toHaveText("70,000");
      await expect(info(page, "예상체결량").locator("b")).toHaveText("300");
      await expect(page.getByTestId("ladder-info")).toHaveCount(7);
      await expect(info(page, "예상체결가").locator("b")).toHaveAttribute("data-tone", "warning");
      await expect(page.locator(".mw-lr[data-expected]")).toHaveCount(1);
      await expect(page.locator(".mw-lr[data-expected]")).toContainText("70,000");
      const rowTops = await tops(ladderRows(page));
      expect(await tops(info(page, "예상체결가"))).toEqual([rowTops[7]]);
      expect(await tops(info(page, "예상체결량"))).toEqual([rowTops[8]]);
      expect((await infoCard(page).boundingBox())!.height).toBe(9 * CARD_ROW_HEIGHT);
      expect(await shape(page)).toEqual(without);
    });

    test("9행에 매수 잔량이 있으면 카드가 8행으로 줄고 예상체결 두 항목이 그 끝으로 올라가며 기준가는 남는다", async ({ page, scenario }) => {
      await open(page, scenario, 70000);
      const bookSub = await subOf(scenario, "book");
      scenario.live.emit({ type: "feed_book", sub: bookSub, book: frame(scenario, [[70100, 50], [70200, 40], [70300, 30], [70400, 20]], [[70200, 25], [70000, 80], [69900, 60]], EXPECTED) });
      await expect(info(page, "예상체결가")).toBeVisible();
      await expect(info(page, "예상체결량")).toBeVisible();
      await expect(info(page, "거래량")).toHaveCount(0);
      await expect(info(page, "거래대금")).toHaveCount(0);
      const rowTops = await tops(ladderRows(page));
      await expect(info(page, "기준가")).toBeVisible();
      expect(await tops(info(page, "예상체결가"))).toEqual([rowTops[6]]);
      expect(await tops(info(page, "예상체결량"))).toEqual([rowTops[7]]);
      expect((await infoCard(page).boundingBox())!.height).toBe(8 * CARD_ROW_HEIGHT);
    });

    test("동시호가 예상체결 줄은 시세 쪽에만 붙는다", async ({ page, scenario }) => {
      await open(page, scenario, 70000);
      const bookSub = await subOf(scenario, "book");
      scenario.live.emit({ type: "feed_book", sub: bookSub, book: frame(scenario, [[70100, 50], [70200, 40]], [[70000, 80], [69900, 60]], EXPECTED) });
      await expect(info(page, "예상체결가")).toBeVisible();
      await expect(info(page, "예상체결량")).toBeVisible();
      await infoTab(page, "종목").click();
      await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
      await expect(info(page, "예상체결가")).toHaveCount(0);
      await expect(info(page, "예상체결량")).toHaveCount(0);
      await expect(page.locator(".mw-lr[data-expected]")).toHaveCount(1);
      await infoTab(page, "시세").click();
      await expect(info(page, "예상체결가")).toBeVisible();
      await expect(infoLabels(page)).toHaveText([...INFO_PAGE_1.slice(0, 5), "예상체결가", "예상체결량"]);
    });

    test("실시간 호가가 없고 조회 호가만 있으면 예상체결 항목이 없다", async ({ page, scenario }) => {
      await open(page, scenario, 70000);
      await expect(ladderRows(page)).toHaveCount(20);
      await expect(page.getByTestId("ladder-info")).toHaveCount(7);
      await expect(info(page, "예상체결가")).toHaveCount(0);
      await expect(page.locator("[data-expected]")).toHaveCount(0);
    });
  });

  test.describe("수요일 10:00", () => {
    test.use({ clockStart: "20261118100000" });

    test("같은 예상체결이 와도 보이지 않고 1쪽 일곱 칸이 그대로다", async ({ page, scenario }) => {
      await open(page, scenario, 70000);
      const bookSub = await subOf(scenario, "book");
      scenario.live.emit({ type: "feed_book", sub: bookSub, book: frame(scenario, [[70100, 50], [70200, 40]], [[70000, 80], [69900, 60]], EXPECTED) });
      await expect(page.getByTestId("book-total-bid")).toHaveText("140");
      await expect(info(page, "예상체결가")).toHaveCount(0);
      await expect(info(page, "예상체결량")).toHaveCount(0);
      await expect(page.locator("[data-expected]")).toHaveCount(0);
      await expect(page.getByTestId("ladder-info")).toHaveCount(7);
    });
  });
});

test.describe("시간외 종가 잔량", () => {
  const afterHours = (scenario: Scenario, askQty: number, bidQty: number) => ({ t: scenario.now / 1000, askQty, bidQty });
  const unavailable = { status: 503, body: { error: { code: "internal", message: "호가 없음", reason: null, retryAt: null, manualActionRequired: false } } };
  const strip = (page: Page) => book(page).locator(".mw-strip");

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test.describe("수요일 08:35", () => {
    test.use({ clockStart: "20261118083500" });

    test("사다리가 없어도 빈 상태 아래 띠의 총잔량 자리에 시간외 잔량이 보인다", async ({ page, scenario }) => {
      bookWindow(scenario, CODE);
      replyBook(scenario, 70000);
      scenario.reply((url) => url.pathname === "/api/symbols/005930/order-book", unavailable);
      await page.goto("/");
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
      await expect(book(page).getByText("호가를 불러오지 못했습니다")).toBeVisible();
      await expect(page.getByTestId("book-total-ask")).toHaveText("-");
      const bookSub = await subOf(scenario, "book");
      scenario.live.emit({ type: "feed_after_hours", sub: bookSub, totals: afterHours(scenario, 13_770, 0) });
      await expect(page.getByTestId("book-total-ask")).toHaveAttribute("data-source", "after-hours");
      await expect(page.getByTestId("book-total-ask")).toContainText("시간외");
      await expect(page.getByTestId("book-total-ask")).toContainText("13,770");
      await expect(page.getByTestId("book-total-bid")).toContainText("0");
      await expect(book(page).getByText("호가를 불러오지 못했습니다")).toBeVisible();
    });

    test("조회 값이 먼저 보이고 실시간 값이 오면 실시간 값으로 바뀐다", async ({ page, scenario }) => {
      bookWindow(scenario, CODE);
      replyBook(scenario, 70000);
      scenario.reply((url) => url.pathname === "/api/symbols/005930/order-book", { body: { ...snapshotOf(70000), afterHoursAskQuantity: 5000, afterHoursBidQuantity: 0 } });
      await page.goto("/");
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
      await expect(page.getByTestId("book-total-ask")).toContainText("5,000");
      const bookSub = await subOf(scenario, "book");
      scenario.live.emit({ type: "feed_after_hours", sub: bookSub, totals: afterHours(scenario, 6000, 0) });
      await expect(page.getByTestId("book-total-ask")).toContainText("6,000");
    });

    test("사다리와 함께 와도 숫자는 시간외 잔량이고 정규 총잔량은 title에 있으며 띠 높이는 같다", async ({ page, scenario }) => {
      await open(page, scenario, 70000);
      const bookSub = await subOf(scenario, "book");
      scenario.live.emit({ type: "feed_book", sub: bookSub, book: { ...liveOf([[70100, 50]], [[70000, 80]], [90, 140]), t: scenario.now / 1000 } });
      await expect(page.getByTestId("book-total-ask")).toHaveText("90");
      const before = (await strip(page).boundingBox())!;
      scenario.live.emit({ type: "feed_after_hours", sub: bookSub, totals: afterHours(scenario, 13_770, 0) });
      await expect(page.getByTestId("book-total-ask")).toHaveAttribute("data-source", "after-hours");
      await expect(page.getByTestId("book-total-ask")).toContainText("13,770");
      await expect(page.getByTestId("book-total-ask")).toHaveAttribute("title", /정규 총잔량 매도 90 · 매수 140/);
      await expect(page.getByRole("img", { name: /정규 총잔량 매도 90 · 매수 140/ })).toHaveCount(1);
      const after = (await strip(page).boundingBox())!;
      expect(after.height).toBe(before.height);
    });
  });

  test.describe("수요일 10:00", () => {
    test.use({ clockStart: "20261118100000" });

    test("시간외 시간이 아니면 정규 총잔량이고 시간외 글자가 없다", async ({ page, scenario }) => {
      await open(page, scenario, 70000);
      const bookSub = await subOf(scenario, "book");
      scenario.live.emit({ type: "feed_book", sub: bookSub, book: { ...liveOf([[70100, 50]], [[70000, 80]], [90, 140]), t: scenario.now / 1000 } });
      scenario.live.emit({ type: "feed_after_hours", sub: bookSub, totals: afterHours(scenario, 13_770, 0) });
      await expect(page.getByTestId("book-total-ask")).toHaveAttribute("data-source", "regular");
      await expect(page.getByTestId("book-total-ask")).toHaveText("90");
      await expect(book(page)).not.toContainText("시간외");
    });
  });
});
