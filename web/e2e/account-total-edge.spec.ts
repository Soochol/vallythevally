import type { Locator, Page } from "@playwright/test";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { ACCOUNT, BASE, CODE, openOrderWindow, ordersOn, otherAccount, tradingApi, win } from "./order-window";

const HYNIX = "000660";
const NARROW_PX = 420;
const ONE_LINE_PX = 28;
const LONG_ALIAS = "가".repeat(20);
const SHORT_ALIAS = "가나";

const samsung: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };

const priceOf = (scenario: Scenario, code: string): number => scenario.market.quote(code)!.price;

const tenSharesOf = (scenario: Scenario, code: string, name: string): TradingHolding => {
  const price = priceOf(scenario, code);
  return { code, name, quantity: 10, sellableQuantity: 10, averagePrice: price, currentPrice: price, evaluationProfit: 0, profitRateCenti: 0 };
};

const quoteOf = (symbol: string, price: number, source: "realtime" | "expected" | "polled" = "realtime") => ({
  symbol,
  price,
  change: 0,
  changeRate: 0,
  volume: 1,
  t: 1,
  source,
  venue: "combined" as const,
});

const lastWatch = (scenario: Scenario): readonly string[] | undefined =>
  scenario.live.messages.flatMap((m) => (m.type === "watch" ? [m.symbols] : [])).at(-1);

const total = (page: Page): Locator => page.getByTestId("account-total-profit");
const shows = (locator: Locator, text: string): Promise<void> => expect(locator).toHaveText(text, { useInnerText: true });

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const boxOf = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;
const centerY = (box: Box): number => box.y + box.height / 2;

const sizeWindow = (page: Page, width: number): Promise<void> =>
  win(page).evaluate((element, size) => {
    const window = element as HTMLElement;
    window.style.flex = "none";
    window.style.width = `${size}px`;
  }, width);

test("560px 미만 창에서 계좌 별칭이 길어도 계좌 띠는 두 줄이다", async ({ page, scenario }) => {
  ordersOn(scenario, [otherAccount({ alias: SHORT_ALIAS })]);
  scenario.live.orders = {
    ...scenario.live.orders,
    accounts: scenario.live.orders.accounts.map((account, index) => (index === 0 ? { ...account, alias: LONG_ALIAS } : account)),
  };
  const api = tradingApi(scenario);
  api.policy = "allow_margin";
  scenario.reply("/api/trading/balance", {
    body: { accountRef: ACCOUNT, holdings: [samsung], creditHoldings: [], totalPurchase: 1_200_000_000, totalEvaluation: 0, totalProfit: 123_456_789 },
  });
  await openOrderWindow(page, scenario);
  await sizeWindow(page, NARROW_PX);
  await shows(total(page), "+10.29% +123,456,789원");

  const bar = await boxOf(page.locator(".od-account-bar"));
  const label = page.getByTestId("account-label");
  const labelBox = await boxOf(label);
  const envBox = await boxOf(page.getByTestId("account-live"));
  const routeBox = await boxOf(page.getByTestId("account-route"));
  const policyBox = await boxOf(page.getByTestId("margin-policy"));

  expect(labelBox.width).toBeGreaterThan(0);
  expect(labelBox.height).toBeLessThanOrEqual(ONE_LINE_PX);
  for (const badge of [envBox, routeBox, policyBox]) {
    expect(Math.abs(centerY(badge) - centerY(labelBox))).toBeLessThan(4);
    expect(badge.x + badge.width).toBeLessThanOrEqual(bar.x + bar.width);
  }
  const ellipsis = await label.locator(".od-account-text").evaluate((element) => ({
    overflow: element.scrollWidth > element.clientWidth,
    textOverflow: getComputedStyle(element).textOverflow,
  }));
  expect(ellipsis).toEqual({ overflow: true, textOverflow: "ellipsis" });

  const tabBoxes: Box[] = [];
  for (const kind of ["open", "holdings", "fills"]) {
    const tab = page.getByTestId(`account-tab-${kind}`);
    const box = await boxOf(tab);
    expect(box.height).toBeLessThanOrEqual(ONE_LINE_PX);
    expect(box.y).toBeGreaterThanOrEqual(labelBox.y + labelBox.height);
    expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
    expect(await tab.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    tabBoxes.push(box);
  }
  expect(Math.max(...tabBoxes.map((box) => box.y)) - Math.min(...tabBoxes.map((box) => box.y))).toBeLessThan(1);

  const longHeight = (await boxOf(page.getByTestId("order-account"))).height;

  await label.click();
  await page.getByTestId("account-option").filter({ hasText: SHORT_ALIAS }).click();
  await expect(label).toContainText(SHORT_ALIAS);
  const shortHeight = (await boxOf(page.getByTestId("order-account"))).height;
  expect(longHeight).toBe(shortHeight);
});

test("예상체결가이거나 실시간이 끊긴 동안 총평가손익은 잔고 값이고 새 시세가 오면 다시 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  const hynixBase = priceOf(scenario, HYNIX);
  scenario.reply("/api/trading/balance", {
    body: {
      accountRef: ACCOUNT,
      holdings: [samsung, tenSharesOf(scenario, HYNIX, "SK하이닉스")],
      creditHoldings: [],
      totalPurchase: 10_000_000,
      totalEvaluation: 0,
      totalProfit: -4_800,
    },
  });
  await openOrderWindow(page, scenario);
  await pollSaved(() => lastWatch(scenario)).toEqual([CODE, HYNIX]);

  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf(HYNIX, hynixBase + 5_000, "realtime")] });
  await shows(total(page), "+0.45% +45,200원");

  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf(HYNIX, hynixBase + 8_000, "expected")] });
  await shows(total(page), "−0.05% −4,800원");

  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quoteOf(HYNIX, hynixBase + 5_000, "realtime")] });
  await shows(total(page), "+0.45% +45,200원");

  scenario.live.status({ realtime: "reconnecting", since: scenario.now / 1000, backfilling: false });
  await shows(total(page), "−0.05% −4,800원");

  scenario.reply("/api/quotes", { body: [quoteOf(HYNIX, hynixBase + 6_000, "polled")] });
  scenario.live.status({ realtime: "live", since: scenario.now / 1000, backfilling: false });
  await shows(total(page), "+0.55% +55,200원");
});
