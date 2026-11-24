import type { Locator, Page } from "@playwright/test";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { ACCOUNT, BASE, CODE, openOrderWindow, ordersOn, otherAccount, tradingApi, win } from "./order-window";

const HYNIX = "000660";
const NAVER = "035420";
const NARROW_PX = 420;
const MIDDLE_PX = 620;
const WIDE_PX = 900;
const ONE_LINE_PX = 28;

const samsung: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };

const priceOf = (scenario: Scenario, code: string): number => scenario.market.quote(code)!.price;

const tenSharesOf = (scenario: Scenario, code: string, name: string): TradingHolding => {
  const price = priceOf(scenario, code);
  return { code, name, quantity: 10, sellableQuantity: 10, averagePrice: price, currentPrice: price, evaluationProfit: 0, profitRateCenti: 0 };
};

const quoteOf = (symbol: string, price: number) => ({ symbol, price, change: 0, changeRate: 0, volume: 1, t: 1, source: "realtime" as const, venue: "combined" as const });

const lastWatch = (scenario: Scenario): readonly string[] | undefined =>
  scenario.live.messages.flatMap((m) => (m.type === "watch" ? [m.symbols] : [])).at(-1);

const tradeSubscriptions = (scenario: Scenario) =>
  scenario.live.messages.flatMap((m) => (m.type === "subscribe_feed" && m.kind === "trades" && m.symbol === CODE ? [m.sub] : []));

async function pushTrade(scenario: Scenario, price: number): Promise<void> {
  await pollSaved(() => tradeSubscriptions(scenario).length).toBeGreaterThan(0);
  for (const sub of tradeSubscriptions(scenario)) {
    scenario.live.emit({ type: "feed_trades", sub, seq: 1, trades: [{ t: scenario.now / 1000 + 1, price, qty: 1_000, venue: "nxt", strength: 101.5 }] });
  }
}

interface Shown {
  readonly holdings: TradingHolding[];
  readonly credit: TradingHolding[];
  readonly totalProfit: number;
  readonly totalPurchase: number;
}

async function openWith(page: Page, scenario: Scenario, shown: Shown, others = false): Promise<void> {
  ordersOn(scenario, others ? [otherAccount()] : []);
  const api = tradingApi(scenario);
  api.policy = "allow_margin";
  scenario.reply("/api/trading/balance", { body: { accountRef: ACCOUNT, holdings: shown.holdings, creditHoldings: shown.credit, totalPurchase: shown.totalPurchase, totalEvaluation: 0, totalProfit: shown.totalProfit } });
  await openOrderWindow(page, scenario);
}

async function openAll(page: Page, scenario: Scenario): Promise<void> {
  await openWith(page, scenario, { holdings: [samsung, tenSharesOf(scenario, HYNIX, "SK하이닉스")], credit: [tenSharesOf(scenario, NAVER, "NAVER")], totalProfit: -4_800, totalPurchase: 10_000_000 });
  await pollSaved(() => lastWatch(scenario)).toEqual([CODE, HYNIX, NAVER]);
}

const total = (page: Page): Locator => page.getByTestId("account-total-profit");
const holdingsTab = (page: Page): Locator => page.getByTestId("account-tab-holdings");
const widthOf = (locator: Locator): Promise<number> => locator.evaluate((element) => element.getBoundingClientRect().width);

const sizeWindow = (page: Page, width: number): Promise<void> =>
  win(page).evaluate((element, size) => {
    const window = element as HTMLElement;
    window.style.flex = "none";
    window.style.width = `${size}px`;
  }, width);

const shows = (locator: Locator, text: string): Promise<void> => expect(locator).toHaveText(text, { useInnerText: true });

test("보유종목 단추에 현금과 신용을 합한 총평가손익이 실시간으로 보인다", async ({ page, scenario }) => {
  await openAll(page, scenario);
  await shows(total(page), "−0.05% −4,800원");
  await expect(total(page)).toHaveAttribute("data-tone", "down");

  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf(HYNIX, priceOf(scenario, HYNIX) + 5_000)] });
  await shows(total(page), "+0.45% +45,200원");
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf(NAVER, priceOf(scenario, NAVER) + 1_000)] });
  await shows(total(page), "+0.55% +55,200원");
  await pushTrade(scenario, 70_500);
  await shows(total(page), "+1.15% +115,200원");
  await expect(total(page)).toHaveAttribute("data-tone", "up");
  await expect(holdingsTab(page)).toHaveAccessibleName("보유종목 2, 총평가손익 +1.15% +115,200원");
});

test("실시간 자리를 잃은 종목의 변동분은 총평가손익에서 빠지고 나머지는 남는다", async ({ page, scenario }) => {
  await openAll(page, scenario);
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf(HYNIX, priceOf(scenario, HYNIX) + 5_000), quoteOf(NAVER, priceOf(scenario, NAVER) + 1_000)] });
  await shows(total(page), "+0.55% +55,200원");

  scenario.live.emit({ type: "watch_limited", symbols: [HYNIX] });

  await shows(total(page), "+0.05% +5,200원");
});

test("보유가 하나도 없으면 단추에 총평가손익이 보이지 않는다", async ({ page, scenario }) => {
  await openWith(page, scenario, { holdings: [], credit: [], totalProfit: 0, totalPurchase: 0 });
  await shows(holdingsTab(page), "보유종목 0");
  await expect(total(page)).toHaveCount(0);
});

test("신용 보유만 있어도 단추에 총평가손익이 보인다", async ({ page, scenario }) => {
  await openWith(page, scenario, { holdings: [], credit: [tenSharesOf(scenario, NAVER, "NAVER")], totalProfit: 30_000, totalPurchase: 2_000_000 });
  await shows(total(page), "+1.50% +30,000원");
});

test("총매입금액이 0이면 수익률 없이 평가손익만 보인다", async ({ page, scenario }) => {
  await openWith(page, scenario, { holdings: [samsung], credit: [], totalProfit: 30_000, totalPurchase: 0 });
  await shows(total(page), "+30,000원");
});

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const boxOf = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;

async function expectTabsWhole(page: Page): Promise<Box[]> {
  const bar = await boxOf(page.locator(".od-account-bar"));
  const boxes: Box[] = [];
  for (const kind of ["open", "holdings", "fills"]) {
    const tab = page.getByTestId(`account-tab-${kind}`);
    const box = await boxOf(tab);
    expect(box.height).toBeLessThanOrEqual(ONE_LINE_PX);
    expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
    expect(await tab.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    boxes.push(box);
  }
  expect(Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y))).toBeLessThan(1);
  return boxes;
}

const bigProfit: Shown = { holdings: [samsung], credit: [], totalProfit: 12_345_678, totalPurchase: 120_000_000 };

test("700px 넘는 창에서는 이름과 수익률과 원 단위 값이 한 줄로 보인다", async ({ page, scenario }) => {
  await openWith(page, scenario, bigProfit, true);
  await sizeWindow(page, WIDE_PX);
  await shows(holdingsTab(page), "보유종목 1 · +10.29% +12,345,678원");
  const [open] = await expectTabsWhole(page);
  const label = await boxOf(page.getByTestId("account-label"));
  expect(Math.abs(label.y + label.height / 2 - (open!.y + open!.height / 2))).toBeLessThan(4);
});

test("560px에서 700px 사이 창에서는 이름과 값을 줄여 한 줄로 보이고 계좌 이름이 남는다", async ({ page, scenario }) => {
  await openWith(page, scenario, bigProfit, true);
  await sizeWindow(page, MIDDLE_PX);
  await shows(holdingsTab(page), "보유 1 · +10.29% +1,234.5만");
  await shows(page.getByTestId("account-tab-open"), "미체결 0");
  await shows(page.getByTestId("account-tab-fills"), "체결 0");
  await expect(holdingsTab(page)).toHaveAccessibleName("보유종목 1, 총평가손익 +10.29% +12,345,678원");
  const [open] = await expectTabsWhole(page);
  const label = await boxOf(page.getByTestId("account-label"));
  expect(label.width).toBeGreaterThan(80);
  expect(Math.abs(label.y + label.height / 2 - (open!.y + open!.height / 2))).toBeLessThan(4);
});

test("420px 창에서는 세 단추가 계좌 이름 아래 줄로 내려가 억 단위 값도 잘리지 않는다", async ({ page, scenario }) => {
  await openWith(page, scenario, { ...bigProfit, totalProfit: 123_456_789, totalPurchase: 1_200_000_000 }, true);
  await sizeWindow(page, NARROW_PX);
  await shows(holdingsTab(page), "보유종목 1 · +10.29% +123,456,789원");
  await shows(page.getByTestId("account-tab-open"), "미체결 주문 0");
  const [open] = await expectTabsWhole(page);
  const label = await boxOf(page.getByTestId("account-label"));
  expect(open!.y).toBeGreaterThanOrEqual(label.y + label.height);
  expect(label.width).toBeGreaterThan(100);
  expect(label.height).toBeLessThanOrEqual(ONE_LINE_PX);
});

test("420px 창의 계좌 띠 높이는 값 길이에 따라 바뀌지 않는다", async ({ page, scenario }) => {
  await openWith(page, scenario, { ...bigProfit, totalProfit: 5, totalPurchase: 0 }, true);
  await sizeWindow(page, NARROW_PX);
  await shows(total(page), "+5원");
  const before = (await boxOf(page.getByTestId("order-account"))).height;

  scenario.reply("/api/trading/balance", { body: { accountRef: ACCOUNT, holdings: [samsung], creditHoldings: [], totalPurchase: 1_200_000_000, totalEvaluation: 0, totalProfit: 123_456_789 } });
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });

  await shows(total(page), "+10.29% +123,456,789원");
  expect((await boxOf(page.getByTestId("order-account"))).height).toBe(before);
});

test("자릿수가 같은 값으로 바뀌어도 단추 폭이 흔들리지 않는다", async ({ page, scenario }) => {
  await openAll(page, scenario);
  const at = async (hynixGain: number, text: string): Promise<number> => {
    scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf(HYNIX, priceOf(scenario, HYNIX) + hynixGain)] });
    await shows(total(page), text);
    return widthOf(holdingsTab(page));
  };
  const widths = [await at(1_591, "+0.11% +11,110원"), await at(9_368, "+0.89% +88,880원"), await at(4_924, "+0.44% +44,440원")];
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.5);
});
