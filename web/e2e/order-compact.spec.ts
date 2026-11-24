import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./harness";
import { BASE, cellAt, openOrderWindow, ordersOn, tradingApi, win } from "./order-window";

const box = async (locator: Locator) => (await locator.boundingBox())!;
const middleY = (rect: { y: number; height: number }) => rect.y + rect.height / 2;
const ladderRows = (page: Page) => page.getByTestId("price-ladder").locator(".mw-lr");

test("예상 주문금액 줄이 없고 매수 칸에 올려도 금액·초과 문구가 뜨지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario).orderable = { cashAmount: 100_000, cashQuantity: 1 };
  await openOrderWindow(page, scenario);
  await page.getByLabel("수량", { exact: true }).fill("10");
  await cellAt(page, "buy", BASE).hover();
  await expect(page.getByTestId("order-preview")).toHaveText("매수 10");
  await expect(page.getByTestId("order-preview")).toHaveAttribute("data-over", "");
  await expect(win(page)).not.toContainText("예상 주문금액");
  await expect(page.getByTestId("order-estimate")).toHaveCount(0);
  await expect(page.getByTestId("order-estimate-note")).toHaveCount(0);
});

test("열 머리 가운데 칸이 전체호가 단추이고 누르면 전체 호가가 켜지고 다시 누르면 20행으로 돌아온다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const head = page.getByTestId("order-colhead");
  await expect(head.locator(":scope > span")).toHaveText(["매도주문", "매도잔량", "매수잔량", "매수주문"]);
  const explorer = head.getByRole("button", { name: /^전체 ?호가$/ });
  await expect(explorer).toHaveCount(1);
  await expect(explorer).toHaveAttribute("data-testid", "order-explorer");
  const askHead = await box(head.locator(":scope > span").nth(1));
  const bidHead = await box(head.locator(":scope > span").nth(2));
  const button = await box(explorer);
  expect(button.x).toBeGreaterThanOrEqual(askHead.x + askHead.width - 1);
  expect(button.x + button.width).toBeLessThanOrEqual(bidHead.x + 1);
  expect(button.y).toBeGreaterThanOrEqual((await box(head)).y - 1);
  await expect(explorer).toHaveAttribute("aria-pressed", "false");
  await expect(ladderRows(page)).toHaveCount(20);
  await explorer.click();
  await expect(explorer).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => ladderRows(page).count()).toBeGreaterThan(20);
  await explorer.click();
  await expect(explorer).toHaveAttribute("aria-pressed", "false");
  await expect(ladderRows(page)).toHaveCount(20);
});

test("현재가 단추가 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("order-colhead")).toBeVisible();
  await expect(page.getByTestId("order-current")).toHaveCount(0);
  await expect(win(page).getByRole("button", { name: "현재가", exact: true })).toHaveCount(0);
});

test("설정 단추는 수량 방식마다 프리셋 줄 맨 오른쪽에 있고 그 줄 바로 아래가 열 머리다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await win(page).evaluate((element) => { element.style.flex = "none"; element.style.width = "421px"; });
  const row = page.getByTestId("order-quantity-row");
  const settings = row.getByTestId("order-settings-button");
  await expect(settings).toHaveCount(1);
  for (const kind of ["수량", "금액"] as const) {
    await page.getByRole("group", { name: "수량 방식" }).getByRole("button", { name: kind }).click();
    await expect(page.getByRole("group", { name: "수량 방식" }).getByRole("button", { name: kind })).toHaveAttribute("aria-pressed", "true");
    const input = await box(page.getByRole("textbox", { name: "수량" }));
    const gear = await box(settings);
    const lastPreset = await box(page.getByRole("group", { name: "수량 프리셋" }).getByRole("button").last());
    const area = await box(win(page));
    expect(Math.abs(middleY(gear) - middleY(input))).toBeLessThanOrEqual(3);
    expect(gear.x).toBeGreaterThanOrEqual(lastPreset.x + lastPreset.width);
    expect(gear.x + gear.width).toBeLessThanOrEqual(area.x + area.width);
    const head = await box(page.getByTestId("order-colhead"));
    expect(head.y - (gear.y + gear.height)).toBeLessThan(16);
    expect(head.y - (input.y + input.height)).toBeLessThan(16);
  }
});
