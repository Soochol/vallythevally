import type { Page } from "@playwright/test";
import { type Scenario, DEFAULT_LAYOUT_ID, expect, pollSaved, test } from "./harness";
import { BASE, CODE, openOrderWindow, ordersOn, tradingApi, writesTo } from "./order-window";

const orderTab = (page: Page, id: string) => page.locator(`[role=tab][data-window-id="${id}"]`);
const keptEntries = (scenario: Scenario) => scenario.documents.uiState()["orderEntries"];
const entryKeyOf = (windowId: string) => `${DEFAULT_LAYOUT_ID}|${windowId}|${CODE}`;
const secondOrderPanel = (page: Page) => page.getByRole("tabpanel", { name: "호가주문 2" });
const quantityField = (page: Page) => secondOrderPanel(page).getByRole("textbox", { name: "수량" });
const layoutMenu = (page: Page) => page.getByRole("menu", { name: "창 배치" });

async function expectStart(page: Page, quantity: string) {
  await expect(quantityField(page)).toHaveValue(quantity);
}

async function placeKept(page: Page, api: ReturnType<typeof tradingApi>, quantity: string, count: number) {
  await quantityField(page).fill(quantity);
  await secondOrderPanel(page).locator(`[data-order-cell][data-side="buy"][data-price="${BASE}"]`).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(count);
}

async function duplicateOrder(page: Page) {
  await orderTab(page, "order").click({ button: "right" });
  await layoutMenu(page).getByRole("menuitem", { name: "복제" }).click();
  await expect(orderTab(page, "order-2")).toHaveAttribute("aria-selected", "true");
  await expect(secondOrderPanel(page).getByTestId("order-window")).toBeVisible();
}

async function addOrderWindow(page: Page) {
  await page.getByRole("button", { name: "창 더하기", exact: true }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^호가주문/ }).click();
  await expect(orderTab(page, "order-2")).toHaveAttribute("aria-selected", "true");
  await expect(secondOrderPanel(page).getByTestId("order-window")).toBeVisible();
}

async function rememberThenCloseSecondOrder(page: Page, scenario: Scenario) {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await duplicateOrder(page);
  await placeKept(page, api, "37", 1);
  await pollSaved(() => keptEntries(scenario)).toMatchObject({ [entryKeyOf("order-2")]: { quantity: 37 } });
  await orderTab(page, "order-2").click({ button: "right" });
  await layoutMenu(page).getByRole("menuitem", { name: "닫기" }).click();
  await expect(orderTab(page, "order-2")).toHaveCount(0);
  expect(keptEntries(scenario)).toMatchObject({ [entryKeyOf("order-2")]: { quantity: 37 } });
}

test("닫은 창 id를 다시 받은 복제 창은 10으로 시작한다", async ({ page, scenario }) => {
  await rememberThenCloseSecondOrder(page, scenario);
  await duplicateOrder(page);
  await expectStart(page, "10");
  await pollSaved(() => keptEntries(scenario)).not.toHaveProperty([entryKeyOf("order-2")]);
});

test("닫은 창 id를 다시 받은 새 호가주문창은 10으로 시작한다", async ({ page, scenario }) => {
  await rememberThenCloseSecondOrder(page, scenario);
  await addOrderWindow(page);
  await expectStart(page, "10");
  await pollSaved(() => keptEntries(scenario)).not.toHaveProperty([entryKeyOf("order-2")]);
});
