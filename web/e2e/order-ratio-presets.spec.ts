import type { Page } from "@playwright/test";
import { expect, pollSaved, test } from "./harness";
import { BASE, cellAt, CODE, openOrder, openOrderWindow, ordersOn, tradingApi, win, writesTo } from "./order-window";

const modeButton = (page: Page, name: "금액" | "매수" | "매도") =>
  page.getByTestId("order-quantity-row").getByRole("group", { name: "프리셋 기준" }).getByRole("button", { name, exact: true });

const presetButtons = (page: Page, groupName: "금액 프리셋" | "매수 비율 프리셋" | "매도 비율 프리셋") =>
  page.getByTestId("order-quantity-row").getByRole("group", { name: groupName }).getByRole("button");

const quantityField = (page: Page) => page.getByRole("textbox", { name: "수량" });

test("매수 비율 모드로 바꾸면 주문가능 금액 기준 25·50·75·전량이 계산되어 입력되고 새로고침해도 모드가 유지된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.orderable = { cashAmount: 7_000_000, cashQuantity: 100 };
  await openOrderWindow(page, scenario);

  await expect(modeButton(page, "금액")).toHaveAttribute("aria-pressed", "true");
  await modeButton(page, "매수").click();
  await expect(modeButton(page, "매수")).toHaveAttribute("aria-pressed", "true");

  const buttons = presetButtons(page, "매수 비율 프리셋");
  await expect(buttons).toHaveText(["25%", "50%", "75%", "전량"]);

  await buttons.nth(0).click();
  await expect(quantityField(page)).toHaveValue("25");
  await buttons.nth(1).click();
  await expect(quantityField(page)).toHaveValue("50");
  await buttons.nth(2).click();
  await expect(quantityField(page)).toHaveValue("75");
  await buttons.nth(3).click();
  await expect(quantityField(page)).toHaveValue("100");

  await cellAt(page, "buy", BASE).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "buy", price: BASE, quantity: 100 });

  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ presetMode: "buy" });
  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(modeButton(page, "매수")).toHaveAttribute("aria-pressed", "true");
  await expect(presetButtons(page, "매수 비율 프리셋")).toHaveText(["25%", "50%", "75%", "전량"]);
});

test("매도 비율은 미체결 매도를 뺀 남은 매도가능 수량 기준으로 계산되고 주문으로 이어진다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "sell", BASE + 500, 50)]);
  api.holdings = [{ code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: BASE, currentPrice: BASE, evaluationProfit: 0, profitRateCenti: 0 }];
  await openOrderWindow(page, scenario);

  await modeButton(page, "매도").click();
  const buttons = presetButtons(page, "매도 비율 프리셋");
  await expect(buttons).toHaveText(["25%", "50%", "75%", "전량"]);

  await buttons.nth(0).click();
  await expect(quantityField(page)).toHaveValue("17");
  await buttons.nth(1).click();
  await expect(quantityField(page)).toHaveValue("35");
  await buttons.nth(2).click();
  await expect(quantityField(page)).toHaveValue("52");
  await buttons.nth(3).click();
  await expect(quantityField(page)).toHaveValue("70");

  await cellAt(page, "sell", BASE + 100).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "sell", price: BASE + 100, quantity: 70 });
});

test("소량 보유 3주에서는 1주 미만인 25%만 비활성이고 나머지는 1·2·3주가 채워진다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [{ code: CODE, name: "삼성전자", quantity: 3, sellableQuantity: 3, averagePrice: BASE, currentPrice: BASE, evaluationProfit: 0, profitRateCenti: 0 }];
  await openOrderWindow(page, scenario);

  await modeButton(page, "매도").click();
  const buttons = presetButtons(page, "매도 비율 프리셋");
  await expect(buttons.nth(0)).toBeDisabled();
  await expect(buttons.nth(1)).toBeEnabled();
  await expect(buttons.nth(2)).toBeEnabled();
  await expect(buttons.nth(3)).toBeEnabled();

  await buttons.nth(1).click();
  await expect(quantityField(page)).toHaveValue("1");
  await buttons.nth(2).click();
  await expect(quantityField(page)).toHaveValue("2");
  await buttons.nth(3).click();
  await expect(quantityField(page)).toHaveValue("3");
});

test("미보유 종목과 예수금 0원에서는 해당 방향의 비율 버튼이 모두 비활성이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [];
  api.orderable = { cashAmount: 0, cashQuantity: 0 };
  await openOrderWindow(page, scenario);

  await modeButton(page, "매도").click();
  for (const button of await presetButtons(page, "매도 비율 프리셋").all()) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", "보유 중인 종목이 아닙니다");
  }

  await modeButton(page, "매수").click();
  for (const button of await presetButtons(page, "매수 비율 프리셋").all()) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", "살 수 있는 수량이 없습니다");
  }
});

test("미수 허용 계좌에서는 매수 비율이 미수 포함 주문가능 금액 기준으로 계산된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.policy = "allow_margin";
  api.orderable = { cashAmount: 7_000_000, cashQuantity: 100, marginAmount: 14_000_000, marginQuantity: 200 };
  await openOrderWindow(page, scenario);

  await modeButton(page, "매수").click();
  const buttons = presetButtons(page, "매수 비율 프리셋");
  await expect(buttons.nth(1)).toHaveAttribute("title", /미수 포함 매수가능 50% · 100주/);
  await buttons.nth(1).click();
  await expect(quantityField(page)).toHaveValue("100");
});
