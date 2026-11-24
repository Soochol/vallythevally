import type { Locator, Page } from "@playwright/test";
import type { TradingOrderable } from "../src/api/generated/TradingOrderable";
import { type Scenario, expect, test } from "./harness";
import { BASE, cellAt, openOrderWindow, ordersOn, status, tradingApi, win } from "./order-window";

const ladder = (page: Page) => page.getByTestId("order-ladder");
const totalAsk = (page: Page) => page.getByTestId("order-total-ask");
const slot = (page: Page) => page.getByTestId("order-status-slot");
const quantity = (page: Page) => page.getByLabel("수량", { exact: true });

interface Box { readonly top: number; readonly bottom: number; readonly height: number }

const boxOf = (locator: Locator): Promise<Box> =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: box.height };
  });

function expectSameBox(after: Box, before: Box): void {
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
}

async function ready(page: Page, scenario: Scenario, orderable: Partial<TradingOrderable> = {}) {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.orderable = orderable;
  api.policy = "cash_only";
  await openOrderWindow(page, scenario);
  return api;
}

test("매수가 현금 한도에 막혀 문구가 떠도 호가판은 움직이지 않고 문구는 창 맨 아래 상태 막대에 뜬다", async ({ page, scenario }) => {
  const api = await ready(page, scenario, { cashAmount: 50_000, cashQuantity: 0 });
  await expect(page.getByTestId("summary-buyable").locator("b")).toHaveText("50,000원");
  await quantity(page).fill("1");
  await expect(status(page)).toHaveCount(0);
  const ladderBefore = await boxOf(ladder(page));
  const totalsBefore = await boxOf(totalAsk(page));
  await cellAt(page, "buy", BASE).dblclick();
  await expect(status(page)).toContainText("현금 주문가능 50,000원을 넘습니다 (미수 막음) · 살 수 있는 수량이 없습니다");
  expect(api.writes).toHaveLength(0);
  expectSameBox(await boxOf(ladder(page)), ladderBefore);
  expectSameBox(await boxOf(totalAsk(page)), totalsBefore);
  const bar = await boxOf(slot(page));
  const windowBox = await boxOf(win(page));
  expect(bar.top).toBeGreaterThanOrEqual(totalsBefore.bottom - 1);
  expect(Math.abs(bar.bottom - windowBox.bottom)).toBeLessThanOrEqual(1);
});

test("주문이 접수돼 결과 문구가 떠도 호가판은 움직이지 않는다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await quantity(page).fill("1");
  await expect(status(page)).toHaveCount(0);
  const ladderBefore = await boxOf(ladder(page));
  await cellAt(page, "buy", BASE).dblclick();
  await expect(status(page)).toContainText("접수");
  expectSameBox(await boxOf(ladder(page)), ladderBefore);
});
