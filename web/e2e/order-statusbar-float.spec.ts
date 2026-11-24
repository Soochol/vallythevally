import type { Locator, Page } from "@playwright/test";
import { DEFAULT_LAYOUT_ID, type Scenario, expect, test } from "./harness";
import { BASE, cellAt, openOrderWindow, ordersOn, status, tradingApi, win } from "./order-window";

const CORNER_INSET = 4;

interface Box { readonly top: number; readonly bottom: number; readonly height: number }

const boxOf = (locator: Locator): Promise<Box> =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: box.height };
  });

async function floatOrderWindow(page: Page, scenario: Scenario): Promise<void> {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const root = { kind: "group" as const, id: "g1", tabs: ["cell-0"], active: "cell-0" };
  const floats = [{ window: "order", rect: { x: .1, y: .05, w: .4, h: .8 } }];
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, placement: { v: 1, canvas: null, dock: { root, floats } } });
  await page.goto("/");
  await expect(win(page)).toBeVisible();
  await expect(page.getByTestId("price-ladder").locator(".mw-lr")).toHaveCount(20);
}

test("떠 있는 호가주문 창에서 맨 아래 상태 막대 단추는 창 크기 조절 손잡이에 가리지 않고 닫아도 호가판이 그대로다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.orderable = { cashAmount: 50_000, cashQuantity: 0 };
  api.policy = "cash_only";
  await openOrderWindow(page, scenario);
  await floatOrderWindow(page, scenario);
  await expect(page.locator(".window-resize-s")).toHaveCount(1);
  await page.getByLabel("수량", { exact: true }).fill("1");
  await expect(status(page)).toHaveCount(0);
  const ladderBefore = await boxOf(page.getByTestId("order-ladder"));
  await cellAt(page, "buy", BASE).dblclick();
  await expect(status(page)).toContainText("미수 막음");
  const bar = await boxOf(page.getByTestId("order-status-slot"));
  const windowBox = await boxOf(win(page));
  expect(Math.abs(bar.bottom - windowBox.bottom)).toBeLessThanOrEqual(1);
  const close = status(page).getByRole("button", { name: "닫기" });
  const button = await close.boundingBox();
  if (!button) throw new Error("닫기 단추가 보이지 않습니다");
  const left = button.x + CORNER_INSET, right = button.x + button.width - CORNER_INSET, top = button.y + 1, bottom = button.y + button.height - 1;
  for (const [x, y] of [[left, top], [right, top], [left, bottom], [right, bottom]] as const) {
    const hit = await close.evaluate((element, point) => {
      const found = document.elementFromPoint(point.x, point.y);
      return found !== null && element.contains(found);
    }, { x, y });
    expect(hit, `단추 모서리 (${x}, ${y})`).toBe(true);
  }
  await page.mouse.click(button.x + button.width / 2, button.y + button.height - 2);
  await expect(status(page)).toHaveCount(0);
  const ladderAfter = await boxOf(page.getByTestId("order-ladder"));
  expect(Math.abs(ladderAfter.top - ladderBefore.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(ladderAfter.height - ladderBefore.height)).toBeLessThanOrEqual(1);
});
