import type { Page } from "@playwright/test";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import { expect, test } from "./harness";
import { BASE, CODE, openOrderWindow, ordersOn, tradingApi } from "./order-window";

const WIDE_PROFIT: TradingHolding = { code: CODE, name: "삼성전자", quantity: 12_000, sellableQuantity: 12_000, averagePrice: 70_102, currentPrice: BASE, evaluationProfit: -1_234_800, profitRateCenti: -57 };
const CELLS = ["summary-quantity", "summary-average", "summary-profit", "summary-buyable"];

type Box = { left: number; right: number; top: number };

const labelBoxes = (page: Page): Promise<Box[]> =>
  page.getByTestId("order-summary").evaluate((summary, ids) => ids.map((id) => {
    const rect = summary.querySelector(`[data-testid="${id}"] small`)!.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top };
  }), CELLS);

const cellBoxes = (page: Page): Promise<Box[]> =>
  page.getByTestId("order-summary").evaluate((summary, ids) => ids.map((id) => {
    const rect = summary.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top };
  }), CELLS);

const clippedInProfit = (page: Page): Promise<string[]> =>
  page.getByTestId("summary-profit").evaluate((cell) => [cell, ...Array.from(cell.querySelectorAll<HTMLElement>("*"))]
    .filter((element) => getComputedStyle(element).visibility !== "hidden" && element.scrollWidth > element.clientWidth + 1)
    .map((element) => `${element.tagName} ${element.scrollWidth}>${element.clientWidth}`));

async function expectLaidOutInOneRow(page: Page): Promise<void> {
  const cells = await cellBoxes(page);
  for (const cell of cells) expect(Math.abs(cell.top - cells[0]!.top)).toBeLessThan(0.5);
  for (let i = 1; i < cells.length; i += 1) expect(cells[i]!.left).toBeGreaterThanOrEqual(cells[i - 1]!.right - 0.5);
  expect(await clippedInProfit(page)).toEqual([]);
}

function expectSameLefts(actual: Box[], expected: Box[]): void {
  expect(actual.map((box) => box.left)).toHaveLength(expected.length);
  actual.forEach((box, i) => expect(Math.abs(box.left - expected[i]!.left), `${CELLS[i]} 라벨이 ${box.left - expected[i]!.left}px 움직였다`).toBeLessThan(0.5));
}

test("평가손익을 원과 퍼센트로 바꿔도 보유 요약 라벨이 제자리에 있고 값이 잘리지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).holdings = [WIDE_PROFIT];
  await openOrderWindow(page, scenario);
  const profit = page.getByTestId("summary-profit");
  await expect(profit).toContainText("−1,234,800원");
  await expect(profit).not.toContainText("%");
  await expectLaidOutInOneRow(page);
  const inWon = await labelBoxes(page);

  await profit.click();
  await expect(profit).toContainText("−0.57%");
  await expect(profit).not.toContainText("원");
  await expectLaidOutInOneRow(page);
  expectSameLefts(await labelBoxes(page), inWon);

  await profit.click();
  await expect(profit).toContainText("−1,234,800원");
  await expectLaidOutInOneRow(page);
  expectSameLefts(await labelBoxes(page), inWon);
});
