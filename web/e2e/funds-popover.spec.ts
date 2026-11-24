import type { Locator, Page } from "@playwright/test";
import type { TradingOrderable } from "../src/api/generated/TradingOrderable";
import { type Scenario, expect, test } from "./harness";
import { type Api, openOrderWindow, ordersOn, tradingApi, win } from "./order-window";

async function openFunds(page: Page, scenario: Scenario, orderable: Partial<TradingOrderable>): Promise<Api> {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.orderable = orderable;
  await openOrderWindow(page, scenario);
  await page.getByTestId("summary-buyable").click();
  await expect(page.getByTestId("funds-panel")).toBeVisible();
  return api;
}

const cashCard = (page: Page): Locator => page.getByRole("button", { name: "미수 막기", exact: true });
const marginCard = (page: Page): Locator => page.getByRole("button", { name: "미수 허용", exact: true });
const SMALL = { cashAmount: 117_462, cashQuantity: 0, marginAmount: 124_389, marginQuantity: 1 };

test("자금 팝업은 두 한도를 금액과 N주로 보이고 고른 쪽만 눌려 있다", async ({ page, scenario }) => {
  await openFunds(page, scenario, SMALL);
  await expect(page.getByTestId("funds-title")).toContainText("매수 가능 자금");
  await expect(page.getByTestId("funds-title")).toContainText("70,000원 기준");
  await expect(cashCard(page)).toHaveAttribute("data-testid", "funds-cash");
  await expect(cashCard(page)).toContainText("현금만");
  await expect(page.getByTestId("funds-cash-amount")).toHaveText("117,462원");
  await expect(page.getByTestId("funds-cash-quantity")).toHaveText("0주");
  await expect(page.getByTestId("funds-cash-quantity")).toHaveAttribute("data-zero", "");
  await expect(cashCard(page)).toHaveAttribute("aria-pressed", "true");
  await expect(marginCard(page)).toHaveAttribute("data-testid", "funds-margin");
  await expect(marginCard(page)).toContainText("미수 포함");
  await expect(page.getByTestId("funds-margin-amount")).toHaveText("124,389원");
  await expect(page.getByTestId("funds-margin-quantity")).toHaveText("1주");
  await expect(page.getByTestId("funds-margin-quantity")).not.toHaveAttribute("data-zero", /.*/);
  await expect(marginCard(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("funds-panel")).not.toContainText("117,462원 · 0");
  const [cash, margin] = [(await cashCard(page).boundingBox())!, (await marginCard(page).boundingBox())!];
  expect(margin.y).toBeCloseTo(cash.y, 0);
  expect(margin.x).toBeGreaterThanOrEqual(cash.x + cash.width);
});

test("미수금이 없으면 미수금 줄이 없고 있으면 빨간 줄로 보인다", async ({ page, scenario }) => {
  const api = await openFunds(page, scenario, { ...SMALL, unpaid: 0 });
  await expect(page.getByTestId("funds-deposit")).toHaveText("예수금520,000,000원");
  await expect(page.getByTestId("funds-unpaid")).toHaveCount(0);
  await page.keyboard.press("Escape");

  api.orderable = { ...SMALL, unpaid: 120_000 };
  await page.reload();
  await page.getByTestId("summary-buyable").click();
  await expect(page.getByTestId("funds-unpaid")).toHaveText("미수금120,000원");
  await expect(page.getByTestId("funds-unpaid")).toHaveAttribute("data-danger", "");
});

test("증거금률을 모르면 증거금률 줄이 없고 일부만 모르면 그 값만 -다", async ({ page, scenario }) => {
  const api = await openFunds(page, scenario, { ...SMALL, stockRate: null, accountRate: null, appliedRate: null });
  await expect(page.getByTestId("funds-deposit")).toBeVisible();
  await expect(page.getByTestId("funds-rates")).toHaveCount(0);

  api.orderable = { ...SMALL, stockRate: null, accountRate: 40, appliedRate: 100 };
  await page.reload();
  await page.getByTestId("summary-buyable").click();
  await expect(page.getByTestId("funds-rates")).toContainText("적용 100%");
  await expect(page.getByTestId("funds-rates")).toContainText("종목 - · 계좌 40");
});

test("미수 포함 값이 없으면 그 카드의 금액은 -이고 수량이 없다", async ({ page, scenario }) => {
  await openFunds(page, scenario, { ...SMALL, marginAmount: null, marginQuantity: null });
  await expect(page.getByTestId("funds-margin-amount")).toHaveText("-");
  await expect(page.getByTestId("funds-margin-quantity")).toHaveCount(0);
  await expect(page.getByTestId("funds-cash-quantity")).toHaveText("0주");
});

test("420px 창에서 백억 원대 금액도 카드 안에서 잘리지 않는다", async ({ page, scenario }) => {
  await openFunds(page, scenario, { cashAmount: 12_345_678_900, cashQuantity: 176_366, marginAmount: 98_765_432_100, marginQuantity: 1_410_934 });
  await page.keyboard.press("Escape");
  await win(page).evaluate((element) => {
    const window = element as HTMLElement;
    window.style.flex = "none";
    window.style.width = "420px";
  });
  await page.getByTestId("summary-buyable").click();
  await expect(page.getByTestId("funds-cash-amount")).toHaveText("12,345,678,900원");
  for (const key of ["cash", "margin"]) {
    const card = (await page.getByTestId(`funds-${key}`).boundingBox())!;
    const fit = await page.getByTestId(`funds-${key}-amount`).evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      return { left: text.left, right: text.right, lines: range.getClientRects().length, cut: element.scrollWidth - element.clientWidth };
    });
    expect(fit.lines).toBe(1);
    expect(fit.cut).toBeLessThanOrEqual(0);
    expect(fit.left).toBeGreaterThanOrEqual(card.x);
    expect(fit.right).toBeLessThanOrEqual(card.x + card.width);
  }
  const panel = (await page.getByTestId("funds-panel").boundingBox())!;
  const window = (await win(page).boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(window.x);
  expect(panel.x + panel.width).toBeLessThanOrEqual(window.x + window.width);
  expect(await page.getByTestId("funds-panel").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
});
