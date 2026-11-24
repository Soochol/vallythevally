import { expect, test } from "./harness";
import { openOrderWindow, ordersOn, tradingApi } from "./order-window";

test("수량 줄 전환 단추는 여백 1px이고 설정 팝오버의 주문 경로 단추는 여백 3px, 높이 26px 그대로다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await page.getByTestId("order-settings-button").click();
  const settings = page.getByTestId("order-settings");
  await expect(settings).toBeVisible();

  const readMetrics = (elements: Element[]) => elements.map((element) => {
    const style = getComputedStyle(element);
    return { paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, height: style.height };
  });

  const modeButtons = page.getByTestId("order-quantity-row").getByRole("group", { name: "수량 방식" }).getByRole("button");
  const routeButtons = settings.getByRole("group", { name: "주문 경로" }).getByRole("button");
  await expect(modeButtons).toHaveCount(2);
  await expect(routeButtons).toHaveCount(3);

  expect(await modeButtons.evaluateAll(readMetrics)).toEqual([
    { paddingLeft: "1px", paddingRight: "1px", height: "26px" },
    { paddingLeft: "1px", paddingRight: "1px", height: "26px" },
  ]);
  expect(await routeButtons.evaluateAll(readMetrics)).toEqual([
    { paddingLeft: "3px", paddingRight: "3px", height: "26px" },
    { paddingLeft: "3px", paddingRight: "3px", height: "26px" },
    { paddingLeft: "3px", paddingRight: "3px", height: "26px" },
  ]);
});
