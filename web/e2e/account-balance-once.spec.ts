import type { Page } from "@playwright/test";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { ACCOUNT, type Api, BASE, CODE, openOrderWindow, ordersOn, tradingApi } from "./order-window";

const SAMSUNG: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };

const PAUSE_AHEAD_MS = 2_000;
const RECONNECT_WINDOW_MS = 3_000;
const SETTLE_MS = 500;

const balances = (api: Api): number => api.seen.filter((seen) => seen.path === "/api/trading/balance").length;

async function openAndFreeze(page: Page, scenario: Scenario): Promise<Api> {
  await page.clock.install({ time: new Date(scenario.now) });
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [SAMSUNG];
  await openOrderWindow(page, scenario);
  await pollSaved(() => balances(api)).toBeGreaterThan(0);
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + PAUSE_AHEAD_MS));
  return api;
}

async function duplicateOrderWindow(page: Page, api: Api): Promise<void> {
  const before = balances(api);
  await page.getByRole("tab", { name: /^호가주문/ }).click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(page.getByRole("tabpanel", { name: "호가주문 2" }).getByTestId("order-window")).toBeVisible();
  await pollSaved(() => balances(api)).toBeGreaterThan(before);
}

test("창 하나에서 계좌 변경 신호 한 번에 잔고 조회가 한 번만 나간다", async ({ page, scenario }) => {
  const api = await openAndFreeze(page, scenario);
  const before = balances(api);

  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await pollSaved(() => balances(api)).toBeGreaterThan(before);
  await page.clock.runFor(SETTLE_MS);

  expect(balances(api)).toBe(before + 1);
});

test("같은 계좌를 보이는 창 둘에서 계좌 변경 신호 한 번에 잔고 조회가 한 번만 나간다", async ({ page, scenario }) => {
  const api = await openAndFreeze(page, scenario);
  await duplicateOrderWindow(page, api);
  const before = balances(api);

  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await pollSaved(() => balances(api)).toBeGreaterThan(before);
  await page.clock.runFor(SETTLE_MS);

  expect(balances(api)).toBe(before + 1);
});

test("같은 계좌를 보이는 창 둘에서 브라우저 연결이 다시 이어지면 잔고 조회가 한 번만 나간다", async ({ page, scenario }) => {
  const api = await openAndFreeze(page, scenario);
  await duplicateOrderWindow(page, api);
  const before = balances(api);

  scenario.live.close();
  await page.clock.runFor(RECONNECT_WINDOW_MS);

  await pollSaved(() => balances(api)).toBeGreaterThan(before);
  expect(balances(api)).toBe(before + 1);
});

test("계좌 변경 신호 전에 시작한 잔고 조회의 늦은 답은 신호 뒤 잔고를 덮지 않는다", async ({ page, scenario }) => {
  await openAndFreeze(page, scenario);
  const preSignal = scenario.hold((url) => url.pathname === "/api/trading/balance");
  await page.getByRole("tab", { name: /^호가주문/ }).click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(page.getByRole("tabpanel", { name: "호가주문 2" }).getByTestId("order-window")).toBeVisible();
  await preSignal.received;

  scenario.reply((url) => url.pathname === "/api/trading/balance", {
    body: { accountRef: ACCOUNT, holdings: [{ ...SAMSUNG, quantity: 200, sellableQuantity: 200 }], totalPurchase: 0, totalEvaluation: 0, totalProfit: 0 },
  });
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await page.clock.runFor(SETTLE_MS);
  await expect(page.getByTestId("summary-quantity").first()).toContainText("200");

  preSignal.reply({ body: { accountRef: ACCOUNT, holdings: [SAMSUNG], totalPurchase: 0, totalEvaluation: 0, totalProfit: 0 } });
  await page.clock.runFor(SETTLE_MS);
  await expect(page.getByTestId("summary-quantity").first()).toContainText("200");
});
