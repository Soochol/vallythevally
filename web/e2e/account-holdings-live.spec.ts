import type { Locator, Page } from "@playwright/test";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { BASE, CODE, openOrderWindow, ordersOn, tradingApi } from "./order-window";

const SAMSUNG: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };
const HYNIX: TradingHolding = { code: "000660", name: "SK하이닉스", quantity: 10, sellableQuantity: 10, averagePrice: 180_000, currentPrice: 180_000, evaluationProfit: 0, profitRateCenti: 0 };

const watches = (scenario: Scenario): readonly (readonly string[])[] => scenario.live.messages.flatMap((m) => (m.type === "watch" ? [m.symbols] : []));

const lastWatch = (scenario: Scenario): readonly string[] | undefined =>
  watches(scenario).at(-1);

const quoteOf = (symbol: string, price: number) => ({ symbol, price, change: 0, changeRate: 0, volume: 1, t: 1, source: "realtime" as const, venue: "combined" as const });

const tradeSubscriptions = (scenario: Scenario) =>
  scenario.live.messages.flatMap((m) => (m.type === "subscribe_feed" && m.kind === "trades" && m.symbol === CODE ? [m.sub] : []));

async function pushTrade(scenario: Scenario, price: number): Promise<void> {
  await pollSaved(() => tradeSubscriptions(scenario).length).toBeGreaterThan(0);
  for (const sub of tradeSubscriptions(scenario)) {
    scenario.live.emit({ type: "feed_trades", sub, seq: 1, trades: [{ t: scenario.now / 1000 + 1, price, qty: 1_000, venue: "nxt", strength: 101.5 }] });
  }
}

function watch(scenario: Scenario, symbols: string[]): void {
  const current = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: current.lists.map((list, i) => (i === 0 ? { ...list, symbols } : list)), revision: current.revision + 1 });
}

const profitOf = (page: Page, name: string): Locator => page.getByTestId("account-holding").filter({ hasText: name }).locator("b.od-figure");

const hynixQuoteRequests = (scenario: Scenario): number =>
  scenario.requests.map((request) => new URL(request.url())).filter((url) => url.pathname === "/api/quotes" && (url.searchParams.get("symbols") ?? "").includes("000660")).length;

function answerHynixQuote(scenario: Scenario, price: number): void {
  scenario.reply("/api/quotes", { body: [{ ...quoteOf("000660", price), source: "polled" }] });
}

async function openOrders(page: Page, scenario: Scenario): Promise<void> {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [SAMSUNG, HYNIX];
  await openOrderWindow(page, scenario);
  await pollSaved(() => lastWatch(scenario)?.slice(0, 2)).toEqual([CODE, "000660"]);
}

async function openHoldings(page: Page): Promise<void> {
  await page.getByTestId("account-tab-holdings").click();
  await expect(page.getByTestId("account-holding")).toHaveCount(2);
}

test("보유종목 팝오버를 열지 않아도 모든 보유종목을 관심종목보다 앞에 구독하고 줄마다 실시간으로 바뀐다", async ({ page, scenario }) => {
  watch(scenario, ["035420"]);
  await openOrders(page, scenario);
  expect(lastWatch(scenario)).toEqual([CODE, "000660", "035420"]);

  await openHoldings(page);
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf("000660", 185_000)] });

  await expect(profitOf(page, "SK하이닉스")).toHaveText("+50,000원");
  await expect(profitOf(page, "SK하이닉스")).toHaveAttribute("data-tone", "up");
});

test("계좌 정보를 보이는 화면이 닫히면 보유종목 구독을 놓고 관심종목 구독은 남긴다", async ({ page, scenario }) => {
  watch(scenario, ["035420"]);
  await openOrders(page, scenario);

  await page.getByRole("button", { name: /^호가주문.*닫기$/ }).first().click();

  await pollSaved(() => lastWatch(scenario)).toEqual(["035420"]);
});

test("호가주문창에 연 종목의 팝오버 줄은 보유 요약과 같은 값을 보인다", async ({ page, scenario }) => {
  await openOrders(page, scenario);
  await openHoldings(page);
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf(CODE, 70_300), quoteOf("000660", 185_000)] });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("+50,000원");

  await pushTrade(scenario, 70_500);

  await expect(page.getByTestId("summary-profit")).toContainText("+55,200원");
  await expect(profitOf(page, "삼성전자")).toHaveText("+55,200원");
});

test("실시간 자리를 잃은 보유종목 줄은 잔고 값을 보이고 되찾으면 시세를 한 번 다시 조회한다", async ({ page, scenario }) => {
  await openOrders(page, scenario);
  await openHoldings(page);
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf("000660", 185_000)] });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("+50,000원");

  scenario.live.emit({ type: "watch_limited", symbols: ["000660"] });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("0원");

  answerHynixQuote(scenario, 187_000);
  const before = hynixQuoteRequests(scenario);
  scenario.live.emit({ type: "watch_limited", symbols: [] });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("+70,000원");
  expect(hynixQuoteRequests(scenario)).toBe(before + 1);
});

test("브라우저 연결이 끊겼다 이어지면 옛 시세 대신 다시 조회한 시세를 보인다", async ({ page, scenario }) => {
  await openOrders(page, scenario);
  await openHoldings(page);
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf("000660", 185_000)] });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("+50,000원");

  answerHynixQuote(scenario, 187_000);
  scenario.live.close();

  await expect(profitOf(page, "SK하이닉스")).toHaveText("+70,000원");
});

test("증권사 실시간이 끊긴 동안 보유종목 줄은 잔고 값을 보이고 이어지면 시세를 다시 조회한다", async ({ page, scenario }) => {
  await openOrders(page, scenario);
  await openHoldings(page);
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf("000660", 185_000)] });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("+50,000원");

  scenario.live.status({ realtime: "reconnecting", since: scenario.now / 1000, backfilling: false });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("0원");

  answerHynixQuote(scenario, 187_000);
  scenario.live.status({ realtime: "live", since: scenario.now / 1000, backfilling: false });
  await expect(profitOf(page, "SK하이닉스")).toHaveText("+70,000원");
});
