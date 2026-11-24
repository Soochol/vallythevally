import type { Page } from "@playwright/test";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { ACCOUNT, type Api, BASE, CODE, openOrderWindow, ordersOn, tradingApi } from "./order-window";

const SAMSUNG: TradingHolding = { code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 };

const SHORTER_THAN_POLL_MS = 5_000;
const ONE_MINUTE_MS = 60_000;

const balances = (api: Api): number => api.seen.filter((seen) => seen.path === "/api/trading/balance").length;

async function openAndFreezeAfterBalance(page: Page, scenario: Scenario): Promise<Api> {
  await page.clock.install({ time: new Date(scenario.now) });
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [SAMSUNG];
  await openOrderWindow(page, scenario);
  await pollSaved(() => balances(api)).toBeGreaterThan(0);
  await page.clock.pauseAt(new Date(scenario.now + ONE_MINUTE_MS));
  const beforeSignal = balances(api);
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await pollSaved(() => balances(api)).toBeGreaterThan(beforeSignal);
  return api;
}

test("브라우저 연결이 다시 이어지면 잔고를 다시 조회한다", async ({ page, scenario }) => {
  const api = await openAndFreezeAfterBalance(page, scenario);
  const before = balances(api);

  scenario.live.close();
  await page.clock.runFor(SHORTER_THAN_POLL_MS);

  await pollSaved(() => balances(api)).toBeGreaterThan(before);
});

test("계좌 정보를 보이는 화면을 열면 잔고를 바로 다시 조회한다", async ({ page, scenario }) => {
  const api = await openAndFreezeAfterBalance(page, scenario);
  const before = balances(api);

  await page.getByRole("tab", { name: /^호가주문/ }).click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(page.getByRole("tabpanel", { name: "호가주문 2" }).getByTestId("order-window")).toBeVisible();

  await pollSaved(() => balances(api)).toBeGreaterThan(before);
});
