import type { Page } from "@playwright/test";
import type { ClientMessage } from "../src/api/generated/ClientMessage";
import type { FeedTrade } from "../src/api/generated/FeedTrade";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { TradePrint } from "../src/api/generated/TradePrint";
import type { Venue } from "../src/api/generated/Venue";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test, pollSaved } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const at = (clock: string): number => Date.parse(`2026-11-09T${clock}+09:00`) / 1000;
const print = (time: string, price: number, quantity: number, exchange: Venue | null): TradePrint => ({ time, price, quantity, exchange });
const live = (clock: string, price: number, qty: number, venue: Venue | null = "krx", strength: number | null = null): FeedTrade => ({ t: at(clock), price, qty, venue, strength });

const TODAY: TradePrint[] = [
  print("10:00:03", 71_300, -20, "nxt"),
  print("10:00:02", 71_200, 15, "krx"),
  print("10:00:01", 71_100, 700, "krx"),
  print("09:59:59", 71_000, -9, "nxt"),
];

const tradesOf = (scenario: Scenario, venue: Venue) => scenario.on(
  (url) => url.pathname === "/api/symbols/005930/trades",
  (request) => {
    const asked = new URL(request.url()).searchParams.get("venue") as Venue;
    const trades = asked === "combined" ? TODAY : TODAY.filter((t) => t.exchange === asked);
    return { body: { symbol: "005930", venue: asked === "nxt" && venue === "combined" ? "combined" : asked, trades, skippedRows: 0 } };
  },
);

const addButton = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" });
const rows = (page: Page) => page.getByTestId("trade-row");
type FeedRequest = Extract<ClientMessage, { type: "subscribe_feed" }>;
const feedRequests = (scenario: Scenario): FeedRequest[] => scenario.live.messages.filter((m): m is FeedRequest => m.type === "subscribe_feed" && m.kind === "trades");
const feedSub = (scenario: Scenario): string | undefined => feedRequests(scenario).at(-1)?.sub;

async function openTradesWindow(page: Page, scenario: Scenario): Promise<string> {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [{ id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS }, ...layout.windows.filter((w) => w.kind !== "chart")];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addButton(page).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^체결/ }).click();
  await expect(page.getByTestId("trades-window")).toBeVisible();
  await page.mouse.move(2, 2);
  await pollSaved(() => feedSub(scenario)).toBeDefined();
  return feedSub(scenario)!;
}

const emit = (scenario: Scenario, sub: string, trades: FeedTrade[]) => scenario.live.emit({ type: "feed_trades", sub, seq: 1, trades });

test("당일 체결을 먼저 구독한 뒤 조회하고 겹치는 행은 실시간만 남기며 새 체결이 맨 위에 붙는다", async ({ page, scenario }) => {
  tradesOf(scenario, "combined");
  const sub = await openTradesWindow(page, scenario);
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByTestId("trade-cumulative")).toHaveText("744");
  await expect(rows(page).first()).toContainText("10:00:03");
  expect(feedRequests(scenario)[0]).toMatchObject({ symbol: "005930", kind: "trades", venue: "combined" });

  emit(scenario, sub, [live("10:00:02", 71_250, 30, "krx", 112.34), live("10:00:04", 71_400, -5, "krx", 113.5)]);
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByTestId("trades-window")).not.toContainText("10:00:03");
  await expect(rows(page).nth(0)).toContainText("10:00:04");
  await expect(rows(page).nth(0)).toContainText("71,400");
  await expect(rows(page).nth(1)).toContainText("10:00:02");
  await expect(rows(page).nth(2)).toContainText("10:00:01");
  await expect(rows(page).nth(3)).toContainText("09:59:59");
  await expect(page.getByTestId("trade-strength")).toHaveText("113.50%");
  await expect(rows(page).nth(0)).toHaveAttribute("data-side", "sell");

  emit(scenario, sub, [live("10:00:05", 71_500, 3_000, "krx")]);
  await expect(rows(page).first()).toContainText("10:00:05");
  await expect(rows(page).first()).not.toContainText("대량");
  await expect(rows(page).first().locator(".tr-qty")).toHaveCSS("font-weight", "700");
  await expect(rows(page).first().locator(".tr-qty")).toHaveText("3,000");
  await expect(page.locator(".tr-qty-bar, .tr-big")).toHaveCount(0);
});

test("KRX를 고르면 NXT 체결이 보이지 않는다", async ({ page, scenario }) => {
  tradesOf(scenario, "combined");
  const sub = await openTradesWindow(page, scenario);
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByText("−20")).toHaveCount(0);

  await pickDesktopVenue(page, "KRX");
  await pollSaved(() => feedRequests(scenario).at(-1)).toMatchObject({ venue: "krx" });
  await expect(rows(page)).toHaveCount(2);
  const krxSub = feedSub(scenario)!;
  expect(krxSub).not.toBe(sub);

  emit(scenario, krxSub, [live("10:00:04", 71_400, 5, "nxt"), live("10:00:05", 71_500, 6, "krx")]);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first()).toContainText("71,500");
  await expect(page.getByTestId("trades-window")).not.toContainText("71,400");
  await expect(page.getByTestId("trade-integrated-only")).toHaveCount(0);
});

test("선택한 거래소로 조회되지 않아 통합으로 왔으면 띠에 알린다", async ({ page, scenario }) => {
  tradesOf(scenario, "combined");
  await openTradesWindow(page, scenario);
  await pickDesktopVenue(page, "NXT");
  await expect(page.getByTestId("trade-integrated-only")).toHaveText("통합 기준");
});

test("끊김과 이어짐은 목록에 구분 줄 하나로 보이고 최소 금액을 고르면 작은 체결을 감춘다", async ({ page, scenario }) => {
  tradesOf(scenario, "combined");
  const sub = await openTradesWindow(page, scenario);
  await expect(rows(page)).toHaveCount(4);

  scenario.live.emit({ type: "feed_link", sub, live: false, at: at("10:00:10") });
  await expect(page.getByTestId("trade-gap")).toHaveCount(1);
  await expect(page.getByTestId("trade-gap")).toContainText("끊김 10:00:10");
  scenario.live.emit({ type: "feed_link", sub, live: true, at: at("10:00:40") });
  await expect(page.getByTestId("trade-gap")).toHaveText("끊김 10:00:10 → 이어짐 10:00:40");
  await expect(page.getByTestId("trade-gap")).toHaveCount(1);

  await page.getByRole("group", { name: "최소 체결 금액" }).getByRole("button", { name: "3천만" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("71,100");
});

const TRADES_PATH = "/api/symbols/005930/trades";
const isFirstPage = (url: URL) => url.pathname === TRADES_PATH && url.searchParams.get("pages") === "1";
const isFullTape = (url: URL) => url.pathname === TRADES_PATH && !url.searchParams.has("pages");
const FIRST_PAGE: TradePrint[] = [print("10:00:03", 71_300, 20, "krx"), print("10:00:02", 71_200, 15, "krx")];
const tradesBody = (trades: TradePrint[]) => ({ body: { symbol: "005930", venue: "combined", trades, skippedRows: 0 } });

test("첫 쪽이 오면 전체 조회를 기다리지 않고 행을 그리고 전체가 오면 그것으로 바꾼다", async ({ page, scenario }) => {
  const full = scenario.hold(isFullTape);
  scenario.reply(isFirstPage, tradesBody(FIRST_PAGE));
  await openTradesWindow(page, scenario);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId("trades-window")).not.toContainText("불러오는 중");

  full.reply(tradesBody(TODAY));
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).last()).toContainText("09:59:59");
});

test("전체 조회가 실패하면 실패 문구를 띄우되 첫 쪽 행은 남긴다", async ({ page, scenario }) => {
  scenario.reply(isFirstPage, tradesBody(FIRST_PAGE));
  scenario.reply(isFullTape, { status: 503, body: { error: { code: "internal", message: "서버가 응답하지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } } });
  await openTradesWindow(page, scenario);
  await expect(page.getByRole("alert").filter({ hasText: "당일 체결을 불러오지 못했습니다" })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
});

test("첫 쪽을 받은 뒤 종목을 바꾸면 앞 종목의 전체 응답이 풀려도 새 종목 체결창에 들어가지 않는다", async ({ page, scenario }) => {
  const full = scenario.hold(isFullTape);
  scenario.reply(isFirstPage, tradesBody(FIRST_PAGE));
  scenario.reply((url) => url.pathname === "/api/symbols/000660/trades", { body: { symbol: "000660", venue: "combined", trades: [print("10:00:01", 190_000, 5, "krx")], skippedRows: 0 } });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart = (id: string, symbol: string): LayoutWindow => ({ id, link: null, kind: "chart", symbol, venue: "combined", period: "D", chartSettings: SETTINGS });
  const windows: LayoutWindow[] = [chart("cell-0", "005930"), chart("cell-1", "000660"), ...layout.windows.filter((w) => w.kind !== "chart")];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addButton(page).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^체결/ }).click();
  await expect(page.getByTestId("trades-window")).toHaveAttribute("data-symbol", "005930");
  await expect(rows(page)).toHaveCount(2);
  await full.received;

  await cell(page, 2).click();
  await expect(page.getByTestId("trades-window")).toHaveAttribute("data-symbol", "000660");
  await expect(rows(page)).toHaveCount(1);
  full.reply(tradesBody(TODAY));
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId("trades-window")).not.toContainText("71,");
});

test("체결창은 /api/quotes 대신 당일 요약을 한 번 읽고 10초가 지나도 다시 부르지 않으며 전일 종가 대비 색을 보인다", async ({ page, scenario }) => {
  tradesOf(scenario, "combined");
  scenario.reply((url) => url.pathname === "/api/symbols/005930/day-summary", { body: { symbol: "005930", venue: "combined", price: 71_300, previousClose: 71_200, open: null, high: null, low: null, volume: null, tradeValueWon: null, t: null } });
  await page.clock.install({ time: scenario.now });
  await openTradesWindow(page, scenario);
  await expect(rows(page)).toHaveCount(4);
  const count = (path: string) => scenario.requests.filter((r) => new URL(r.url()).pathname === path).length;
  await pollSaved(() => count("/api/symbols/005930/day-summary")).toBe(1);
  await expect(rows(page).first().locator(".tr-price")).toHaveAttribute("data-dir", "up");
  await expect(rows(page).nth(3).locator(".tr-price")).toHaveAttribute("data-dir", "down");
  await page.clock.fastForward(10_000);
  expect(count("/api/symbols/005930/day-summary")).toBe(1);
  expect(count("/api/quotes")).toBe(0);
});
