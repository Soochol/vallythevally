import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderBook } from "../src/api/generated/OrderBook";
import type { RankingPage } from "../src/api/generated/RankingPage";
import type { RankingRow } from "../src/api/generated/RankingRow";
import type { EtfFundDetail } from "../src/api/generated/EtfFundDetail";
import { ETF_DETAILS } from "./fixtures/etf-data";
import { marketOverviewBaseline, RANKING_ROWS } from "./fixtures/market-data";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test, windowTabs } from "./harness";
import type { TradePrint } from "../src/api/generated/TradePrint";
import { CODE, FUNDAMENTAL_FIGURES, pinQuote, SETTINGS } from "./order-window";

const main = (page: Page) => page.getByRole("main", { name: "시장 종합", exact: true });
const OVERVIEW_ROUTES = ["index", "sectors", "flow", "flow/intraday", "turnover"] as const;

const ROWS_OF_A_LONG_RANKING = 14;
const longRanking = (): RankingRow[] => Array.from({ length: ROWS_OF_A_LONG_RANKING }, (_, index) => ({ ...RANKING_ROWS.kospi.tradeAmount[0]!, rank: index + 1, code: `00${1000 + index}`, name: `종목${index + 1}` }));

const rankingPage = (scenario: Scenario, rows: RankingRow[]): RankingPage => ({ rows, pages: 1, end: true, limited: false, hidden: 0, fetchedAt: Math.floor(scenario.now / 1000), source: "kiwoom" });

const heightsOfCards = (page: Page) => page.locator(".mk-grid > [data-card]").evaluateAll((cards) => Object.fromEntries(cards.map((card) => [card.getAttribute("data-card")!, card.getBoundingClientRect().height])));

test("시장 종합 1024px 카드 높이는 불러오기 전후가 같다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  const overview = OVERVIEW_ROUTES.map((route) => ({ route, held: scenario.hold((url) => url.pathname === `/api/market-overview/${route}`) }));
  const ranking = scenario.hold((url, request) => url.pathname === "/api/rankings" && request.method() === "POST");
  await page.goto("/market");
  await Promise.all([...overview.map(({ held }) => held.received), ranking.received]);
  await expect(main(page).getByRole("status").first()).toBeVisible();
  const loading = await heightsOfCards(page);

  for (const { route, held } of overview) held.reply(marketOverviewBaseline(new URL(`http://host/api/market-overview/${route}?market=kospi`), "GET")!);
  ranking.reply({ body: rankingPage(scenario, longRanking()) });
  const stocks = main(page).getByRole("region", { name: "종목", exact: true });
  await expect(stocks.getByRole("button", { name: "종목1", exact: true })).toBeVisible();
  await expect(main(page).getByRole("region", { name: "지수·폭" }).getByText("코스피", { exact: true })).toBeVisible();
  await expect(main(page).getByRole("region", { name: "업종 지도" }).getByRole("button").first()).toBeVisible();
  await expect(main(page).getByRole("region", { name: "거래대금 추이" }).locator(".mk-turnover li").first()).toBeVisible();
  await expect(main(page).getByRole("region", { name: "누가 사고 파나" }).locator(".mk-line").first()).toBeVisible();
  const loaded = await heightsOfCards(page);

  expect(Object.keys(loaded).sort()).toEqual(Object.keys(loading).sort());
  const drift = Object.fromEntries(Object.keys(loaded).map((card) => [card, `${Math.round(loading[card]!)} → ${Math.round(loaded[card]!)}`]));
  for (const card of Object.keys(loaded)) expect(Math.abs(loaded[card]! - loading[card]!), JSON.stringify(drift)).toBeLessThanOrEqual(1);
});

test("390px 시장 종합 조작 묶음은 묶음 안에서 줄을 바꾸지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/market");
  const controls = page.locator(".mk-controls");
  await expect(controls.getByRole("group", { name: "시장" })).toBeVisible();
  const layout = await controls.evaluate((row) => {
    const rowBox = row.getBoundingClientRect();
    const bundles = [...row.children].map((bundle) => {
      const bundleBox = bundle.getBoundingClientRect();
      const tops = [...bundle.querySelectorAll("button")].map((button) => button.getBoundingClientRect().top);
      return { label: bundle.getAttribute("aria-label"), spread: Math.max(...tops) - Math.min(...tops), overflowRight: bundleBox.right - rowBox.right, overflowLeft: rowBox.left - bundleBox.left };
    });
    return { bundles, rowOverflow: row.scrollWidth - row.clientWidth };
  });
  expect(layout.bundles.map((bundle) => bundle.label)).toEqual(["시장", "기간"]);
  for (const bundle of layout.bundles) {
    expect(bundle.spread, JSON.stringify(layout)).toBeLessThanOrEqual(1);
    expect(bundle.overflowRight, JSON.stringify(layout)).toBeLessThanOrEqual(1);
    expect(bundle.overflowLeft, JSON.stringify(layout)).toBeLessThanOrEqual(1);
  }
  expect(layout.rowOverflow, JSON.stringify(layout)).toBeLessThanOrEqual(0);
  const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(documentOverflow).toBeLessThanOrEqual(0);
});

test("시장 종합 종목 표의 더 보기는 남은 종목을 모두 펼친다", async ({ page, scenario }) => {
  scenario.reply((url, request) => url.pathname === "/api/rankings" && request.method() === "POST", { body: rankingPage(scenario, longRanking()) });
  await page.goto("/market");
  const stocks = main(page).getByRole("region", { name: "종목", exact: true });
  await expect(stocks.locator(".mk-stock-row")).toHaveCount(10);
  await stocks.getByRole("button", { name: `더 보기 (${ROWS_OF_A_LONG_RANKING - 10})` }).click();
  await expect(stocks.locator(".mk-stock-row")).toHaveCount(ROWS_OF_A_LONG_RANKING);
  await expect(stocks.getByRole("button", { name: /^더 보기/ })).toHaveCount(0);
});

const LONG_NAME_SUFFIX = " 글로벌 반도체 소부장 액티브 커버드콜 합성";
const longNamedEtfs = (): EtfFundDetail[] => [
  ...ETF_DETAILS,
  { ...ETF_DETAILS[0]!, fund: { ...ETF_DETAILS[0]!.fund, code: "069500", name: "KODEX 200" } },
].map((detail) => ({ ...detail, fund: { ...detail.fund, name: `${detail.fund.name}${LONG_NAME_SUFFIX}` } }));

const serveLongNamedEtfs = (scenario: Scenario) => {
  const details = longNamedEtfs();
  scenario.reply((url) => url.pathname === "/api/etf/funds", { body: { funds: details.map((detail) => detail.fund) } });
  for (const detail of details) scenario.reply((url) => url.pathname === `/api/etf/funds/${detail.fund.code}`, { body: detail });
  return details.map((detail) => detail.fund.code);
};

const NARROW_WIDTHS = [390, 320];

const overflowOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((element) => {
    const container = element.parentElement!;
    const right = container.getBoundingClientRect().right;
    const farthest = Math.max(...[element, ...element.querySelectorAll("*")].map((node) => node.getBoundingClientRect().right));
    return { scrollWidth: element.scrollWidth, parentClientWidth: container.clientWidth, spill: farthest - right };
  });

test("ETF 좁은 화면에서 겹침 행렬과 목록 칩이 가로로 넘치지 않는다", async ({ page, scenario }) => {
  const basket = serveLongNamedEtfs(scenario).join(",");
  for (const width of NARROW_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/etf?tab=overlap&basket=${basket}`);
    await expect(page.getByRole("table", { name: "겹침 행렬" }).locator(".etf-matrix-cell")).toHaveCount(16);
    const matrix = await overflowOf(page, ".etf-matrix");
    expect(matrix.scrollWidth, `${width}px 행렬 ${JSON.stringify(matrix)}`).toBeLessThanOrEqual(matrix.parentClientWidth);
    expect(matrix.spill, `${width}px 행렬 ${JSON.stringify(matrix)}`).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}px 문서`).toBeLessThanOrEqual(0);

    await page.goto(`/etf?basket=${basket}`);
    await expect(page.getByRole("list", { name: "비교 바구니" }).getByRole("listitem")).toHaveCount(4);
    const chips = await overflowOf(page, ".etf-basket-chips");
    expect(chips.scrollWidth, `${width}px 칩 ${JSON.stringify(chips)}`).toBeLessThanOrEqual(chips.parentClientWidth);
    expect(chips.spill, `${width}px 칩 ${JSON.stringify(chips)}`).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}px 문서`).toBeLessThanOrEqual(0);
  }
});

const BOOK_BASE = 70_000;
const LADDER_ROW_HEIGHT = 24;
const FULL_LADDER_ROWS = 20;

const bookSnapshot = (): OrderBook => ({
  symbol: CODE,
  asks: Array.from({ length: 10 }, (_, index) => ({ price: BOOK_BASE + 100 * (index + 1), quantity: 10 + index })),
  bids: Array.from({ length: 10 }, (_, index) => ({ price: BOOK_BASE - 100 * index, quantity: 20 + index })),
  totalAskQuantity: 1000,
  totalBidQuantity: 3000,
  afterHoursAskQuantity: null,
  afterHoursBidQuantity: null,
  bookTime: null,
});

async function openBookWindow(page: Page, scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart: LayoutWindow = { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS };
  const windows: LayoutWindow[] = [chart, ...layout.windows.filter((window) => window.kind !== "chart"), { id: "book", link: null, kind: "book" }];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: 91000, lowerLimit: 49000, ...FUNDAMENTAL_FIGURES } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: bookSnapshot() });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, { body: { symbol: CODE, venue: "combined", trades: [], skippedRows: 0 } });
  pinQuote(scenario, CODE, BOOK_BASE, 1000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  await expect(page.getByTestId("price-ladder").locator(".mw-lr")).toHaveCount(FULL_LADDER_ROWS);
}

const bookGroup = (page: Page) => page.locator("[data-dock-group]").filter({ has: page.getByTestId("book-window") });
const setBookGroupHeight = (page: Page, height: number | null) =>
  bookGroup(page).evaluate((group, value) => {
    group.dataset.originalStyle ??= group.getAttribute("style") ?? "";
    group.setAttribute("style", value === null ? group.dataset.originalStyle : `${group.dataset.originalStyle};flex:none;height:${value}px`);
  }, height);

const ladderFit = (page: Page) =>
  page.getByTestId("book-window").evaluate((book) => {
    const frame = book.getBoundingClientRect();
    const rows = [...book.querySelectorAll<HTMLElement>(".mw-lr")];
    const outside = rows.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.top < frame.top - 0.5 || box.bottom > frame.bottom + 0.5 || box.bottom > book.querySelector(".bk-ladder")!.getBoundingClientRect().bottom + 0.5;
    }).length;
    return { total: rows.length, asks: rows.filter((row) => row.dataset.side === "ask").length, bids: rows.filter((row) => row.dataset.side === "bid").length, outside };
  });

test("10호가 창 높이가 모자라면 매도·매수 단수를 같이 줄인다", async ({ page, scenario }) => {
  await openBookWindow(page, scenario);
  await setBookGroupHeight(page, FULL_LADDER_ROWS * LADDER_ROW_HEIGHT - 3 * LADDER_ROW_HEIGHT);
  await expect.poll(async () => (await ladderFit(page)).total).toBeLessThan(FULL_LADDER_ROWS);
  for (const height of [420, 360, 300]) {
    await setBookGroupHeight(page, height);
    await expect.poll(async () => { const fit = await ladderFit(page); return fit.outside === 0 && fit.asks === fit.bids; }, { message: `${height}px` }).toBe(true);
    const fit = await ladderFit(page);
    expect(fit.total, `${height}px`).toBeLessThan(FULL_LADDER_ROWS);
    expect(fit.asks, `${height}px`).toBeGreaterThan(0);
  }

  await setBookGroupHeight(page, null);
  await expect(page.getByTestId("price-ladder").locator(".mw-lr")).toHaveCount(FULL_LADDER_ROWS);
  expect(await ladderFit(page)).toEqual({ total: FULL_LADDER_ROWS, asks: 10, bids: 10, outside: 0 });
});

const TRADES_STRIP_ROW_HEIGHT = 24;
const SHORT_WINDOW_HEIGHT = 250;
const TALL_WINDOW_HEIGHT = 320;

const printOf = (second: number): TradePrint => ({ time: `10:00:${String(second).padStart(2, "0")}`, price: 71_000 + 100 * second, quantity: 10 + second, exchange: "krx" });

async function openTradesWindow(page: Page, scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart: LayoutWindow = { id: "cell-0", link: "a", kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS };
  const windows: LayoutWindow[] = [chart, ...layout.windows.filter((window) => window.kind !== "chart"), { id: "trades", link: null, kind: "trades" }];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, { body: { symbol: CODE, venue: "combined", trades: Array.from({ length: 12 }, (_, index) => printOf(index + 1)), skippedRows: 0 } });
  pinQuote(scenario, CODE, BOOK_BASE, 1000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^체결/ }).click();
  await expect(page.getByTestId("trade-row").first()).toBeVisible();
}

const tradesLayout = (page: Page) =>
  page.getByTestId("trades-window").evaluate((window) => {
    const strips = window.querySelector<HTMLElement>(".tr-strips")!.getBoundingClientRect();
    const body = window.querySelector<HTMLElement>(".tr-body")!.getBoundingClientRect();
    const visibleRows = [...window.querySelectorAll<HTMLElement>("[data-testid=trade-row]")].filter((row) => {
      const box = row.getBoundingClientRect();
      return box.height > 0 && box.bottom <= body.bottom + 0.5 && box.top >= body.top - 0.5;
    }).length;
    return { strips: Math.round(strips.height * 10) / 10, body: Math.round(body.height * 10) / 10, windowHeight: window.getBoundingClientRect().height, visibleRows };
  });

async function expectStripsAt(page: Page, resize: (height: number) => Promise<void>, where: string) {
  await resize(SHORT_WINDOW_HEIGHT);
  await expect.poll(async () => (await tradesLayout(page)).strips, { message: `${where} ${SHORT_WINDOW_HEIGHT}px` }).toBe(TRADES_STRIP_ROW_HEIGHT);
  const short = await tradesLayout(page);
  expect(short.body, `${where} ${JSON.stringify(short)}`).toBeGreaterThan(0);
  expect(short.visibleRows, `${where} ${JSON.stringify(short)}`).toBeGreaterThan(0);
  await resize(TALL_WINDOW_HEIGHT);
  await expect.poll(async () => (await tradesLayout(page)).strips, { message: `${where} ${TALL_WINDOW_HEIGHT}px` }).toBeGreaterThanOrEqual(2 * TRADES_STRIP_ROW_HEIGHT);
}

test("체결 창 높이 260px 아래에서는 띠가 한 줄이다", async ({ page, scenario }) => {
  await openTradesWindow(page, scenario);
  const group = page.locator("[data-dock-group]").filter({ has: page.getByTestId("trades-window") });
  await expectStripsAt(page, (height) => group.evaluate((element, value) => {
    element.dataset.originalStyle ??= element.getAttribute("style") ?? "";
    element.setAttribute("style", `${element.dataset.originalStyle};flex:none;height:${value}px`);
  }, height), "도킹");

  await page.getByRole("tab", { name: /^체결/ }).press("Shift+F10");
  await page.getByRole("menuitem", { name: "띄우기", exact: true }).click();
  const floating = page.locator('[data-dock-float="trades"]');
  await expect(floating).toBeVisible();
  await expectStripsAt(page, (height) => floating.evaluate((element, value) => { element.style.height = `${value}px`; }, height), "떠 있는 창");
});
