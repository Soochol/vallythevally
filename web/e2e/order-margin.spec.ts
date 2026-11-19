import type { Page } from "@playwright/test";
import type { TradingOrderable } from "../src/api/generated/TradingOrderable";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { BASE, cellAt, center, chipAt, dragChip, openOrder, openOrderWindow, ordersOn, status, tradingApi, writesTo } from "./order-window";

const buyable = (page: Page) => page.getByTestId("summary-buyable");
const quantity = (page: Page) => page.getByLabel("수량", { exact: true });
const rejection = (message: string) => ({ status: 400, body: { error: { code: "bad_request", message, reason: null, retryAt: null, manualActionRequired: false } } });

async function ready(page: Page, scenario: Scenario, orderable: Partial<TradingOrderable> = {}, policy: "cash_only" | "allow_margin" = "cash_only", open: ReturnType<typeof openOrder>[] = []) {
  ordersOn(scenario);
  const api = tradingApi(scenario, open);
  api.orderable = orderable;
  api.policy = policy;
  await openOrderWindow(page, scenario);
  return api;
}

async function openFunds(page: Page) {
  await buyable(page).click();
  await expect(page.getByTestId("funds-panel")).toBeVisible();
}

async function allowMargin(page: Page) {
  await page.getByRole("button", { name: "미수 허용", exact: true }).click();
  await page.getByRole("button", { name: "허용으로 바꾸기" }).click();
}

const CASH_700K = { cashAmount: 700_000, cashQuantity: 10 };

test("매수 가능 칸이 정책에 따라 현금이나 미수 포함 값을 보이고 계좌 줄에 정책 표시가 있다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await expect(buyable(page)).toHaveAttribute("data-policy", "cash_only");
  await expect(buyable(page)).toContainText("매수 가능 · 현금");
  await expect(buyable(page).locator("b")).toHaveText("500,000,000원");
  await expect(page.getByTestId("margin-policy")).toHaveText("현금");
  await openFunds(page);
  await allowMargin(page);
  await expect(buyable(page)).toHaveAttribute("data-policy", "allow_margin");
  await expect(buyable(page)).toContainText("매수 가능 · 미수 포함");
  await expect(buyable(page).locator("b")).toHaveText("1,500,000,000원");
  await expect(page.getByTestId("margin-policy")).toHaveText("미수 허용");
});

test("정책을 알 수 없으면 계좌 줄에 정책 표시가 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.buyableFailure = { status: 503, body: { error: { code: "internal", message: "조회 실패", reason: null, retryAt: null, manualActionRequired: false } } };
  await openOrderWindow(page, scenario);
  await expect(buyable(page).locator("b")).toHaveText("-");
  await expect(page.getByTestId("margin-policy")).toHaveCount(0);
});

test("매수 가능 칸을 누르면 예수금·현금·미수 포함·증거금률·미수금이 보인다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await expect(buyable(page)).not.toHaveAttribute("data-unpaid", /.+/);
  await openFunds(page);
  await expect(page.getByTestId("funds-title")).toHaveText("자금 · 기준 70,000원");
  await expect(page.getByTestId("funds-deposit")).toHaveText("예수금520,000,000원");
  await expect(page.getByTestId("funds-cash")).toHaveText("현금 주문가능 (미수불가)500,000,000원 · 100,000주");
  await expect(page.getByTestId("funds-margin")).toHaveText("미수 포함 주문가능1,500,000,000원 · 300,000주");
  await expect(page.getByTestId("funds-rates")).toHaveText("증거금률종목 100% · 계좌 40% · 적용 100%");
  await expect(page.getByTestId("funds-unpaid")).toHaveText("미수금0원");
  await expect(page.getByTestId("funds-unpaid")).not.toHaveAttribute("data-danger", /.*/);
  await expect(page.getByTestId("order-window").getByTestId("funds-panel")).toBeVisible();
});

test("미수 허용은 확인을 거쳐야 바뀌고 막기로는 바로 돌아간다", async ({ page, scenario }) => {
  const api = await ready(page, scenario);
  await openFunds(page);
  await page.getByRole("button", { name: "미수 허용", exact: true }).click();
  await expect(page.getByTestId("margin-confirm")).toContainText("결제일(D+2)까지 입금하지 않으면 반대매매되고, 다음 날부터 30일간 미수동결됩니다.");
  expect(api.policyWrites).toHaveLength(0);
  await page.getByRole("button", { name: "그대로 두기" }).click();
  await expect(page.getByTestId("margin-confirm")).toHaveCount(0);
  expect(api.policyWrites).toHaveLength(0);
  await expect(page.getByTestId("margin-toggle")).toHaveAttribute("data-policy", "cash_only");

  await page.getByRole("button", { name: "미수 허용", exact: true }).click();
  await page.getByRole("button", { name: "허용으로 바꾸기" }).click();
  await pollSaved(() => api.policyWrites).toEqual([{ policy: "allow_margin" }]);
  await expect(page.getByTestId("margin-toggle")).toHaveAttribute("data-policy", "allow_margin");
  await expect(buyable(page)).toHaveAttribute("data-policy", "allow_margin");

  await page.getByRole("button", { name: "미수 막기" }).click();
  await expect(page.getByTestId("margin-confirm")).toHaveCount(0);
  await pollSaved(() => api.policyWrites).toEqual([{ policy: "allow_margin" }, { policy: "cash_only" }]);
  await expect(buyable(page)).toHaveAttribute("data-policy", "cash_only");
});

test("정책 저장이 실패하면 토글이 되돌아가고 이유가 보인다", async ({ page, scenario }) => {
  const api = await ready(page, scenario);
  api.policyFailure = rejection("주문 사용이 꺼져 있어 미수 정책을 바꿀 수 없습니다");
  await openFunds(page);
  await allowMargin(page);
  await expect(page.getByTestId("margin-failure")).toHaveText("주문 사용이 꺼져 있어 미수 정책을 바꿀 수 없습니다");
  await expect(page.getByTestId("margin-toggle")).toHaveAttribute("data-policy", "cash_only");
  await expect(buyable(page)).toHaveAttribute("data-policy", "cash_only");
  expect(api.policyWrites).toEqual([{ policy: "allow_margin" }]);
});

test("계좌 증거금률이 100%면 미수 허용을 고를 수 없다", async ({ page, scenario }) => {
  const api = await ready(page, scenario, { accountRate: 100 });
  await openFunds(page);
  await expect(page.getByRole("button", { name: "미수 허용", exact: true })).toBeDisabled();
  await expect(page.getByTestId("margin-locked")).toHaveText("계좌가 미수 불가(100%)입니다");
  await expect(page.getByRole("button", { name: "미수 막기" })).toBeEnabled();
  expect(api.policyWrites).toHaveLength(0);
});

test("미수금이 있으면 매수 가능 칸에 표시가 있다", async ({ page, scenario }) => {
  await ready(page, scenario, { unpaid: 120_000 });
  await expect(buyable(page)).toHaveAttribute("data-unpaid", "120000");
  await expect(buyable(page).getByLabel("미수금 있음")).toBeVisible();
  await openFunds(page);
  await expect(page.getByTestId("funds-unpaid")).toHaveText("미수금120,000원");
  await expect(page.getByTestId("funds-unpaid")).toHaveAttribute("data-danger", "");
});

test("미수 막기에서 현금을 넘는 매수는 보내지 않고 최대 수량으로 보내기를 준다", async ({ page, scenario }) => {
  const api = await ready(page, scenario, CASH_700K);
  await expect(buyable(page).locator("b")).toHaveText("700,000원");
  await quantity(page).fill("11");
  await cellAt(page, "buy", BASE).dblclick();
  await expect(status(page)).toContainText("현금 주문가능 700,000원을 넘습니다 (미수 막음) · 최대 10주");
  expect(api.writes).toHaveLength(0);
  await page.getByTestId("order-status-action").click();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "buy", quantity: 10, price: BASE });
  expect(api.writes).toHaveLength(1);
});

test("현금이 0이면 살 수 있는 수량이 없다고 보인다", async ({ page, scenario }) => {
  const api = await ready(page, scenario, { cashAmount: 0, cashQuantity: 0 });
  await expect(buyable(page).locator("b")).toHaveText("0원");
  await quantity(page).fill("1");
  await cellAt(page, "buy", BASE).dblclick();
  await expect(status(page)).toContainText("살 수 있는 수량이 없습니다");
  await expect(page.getByTestId("order-status-action")).toHaveCount(0);
  expect(api.writes).toHaveLength(0);
});

test("미수 허용에서 미수가 생기는 매수는 바로 나가고 미수 금액이 보인다", async ({ page, scenario }) => {
  const api = await ready(page, scenario, { ...CASH_700K, marginAmount: 3_000_000, marginQuantity: 42 }, "allow_margin");
  await expect(buyable(page).locator("b")).toHaveText("3,000,000원");
  await quantity(page).fill("20");
  await cellAt(page, "buy", BASE).hover();
  await expect(page.getByTestId("order-preview")).toHaveAttribute("data-margin", "");
  await expect(page.getByTestId("order-estimate-note")).toHaveText(" · 미수 약 700,000원 생김");
  await cellAt(page, "buy", BASE).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "buy", quantity: 20, price: BASE });
  await expect(status(page)).toHaveText(/접수 · 매수 20 · 70,000원 · 미수 약 700,000원, 결제일\(D\+2\)까지 입금/);
  await expect(status(page)).toHaveAttribute("data-tone", "warn");
});

test("미수 포함 한도를 넘으면 허용에서도 막는다", async ({ page, scenario }) => {
  const api = await ready(page, scenario, { ...CASH_700K, marginAmount: 3_000_000, marginQuantity: 42 }, "allow_margin");
  await expect(buyable(page).locator("b")).toHaveText("3,000,000원");
  await quantity(page).fill("43");
  await cellAt(page, "buy", BASE).dblclick();
  await expect(status(page)).toContainText("미수 포함 주문가능 3,000,000원을 넘습니다 · 최대 42주");
  expect(api.writes).toHaveLength(0);
  await page.getByTestId("order-status-action").click();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ quantity: 42 });
});

test("한도를 넘는 수량이면 매수 칸 미리보기와 예상 금액 줄이 미리 알린다", async ({ page, scenario }) => {
  await ready(page, scenario, CASH_700K);
  await expect(buyable(page).locator("b")).toHaveText("700,000원");
  await quantity(page).fill("10");
  await cellAt(page, "buy", BASE).hover();
  await expect(page.getByTestId("order-preview")).toHaveText("매수 10");
  await expect(page.getByTestId("order-preview")).not.toHaveAttribute("data-over", /.*/);
  await expect(page.getByTestId("order-estimate-note")).toHaveCount(0);
  await quantity(page).fill("11");
  await expect(page.getByTestId("order-preview")).toHaveAttribute("data-over", "");
  await expect(page.getByTestId("order-estimate-note")).toHaveText(" · 현금 70,000원 초과");
  await expect(page.getByTestId("order-estimate-note")).toHaveAttribute("data-tone", "over");
  await cellAt(page, "sell", BASE + 100).hover();
  await expect(page.getByTestId("order-preview")).not.toHaveAttribute("data-over", /.*/);
});

test("매수 칩을 더 높은 가격으로 끌어 늘어난 금액이 한도를 넘으면 정정을 보내지 않는다", async ({ page, scenario }) => {
  const api = await ready(page, scenario, { cashAmount: 500, cashQuantity: 0 }, "cash_only", [openOrder("0000001", "buy", BASE, 10)]);
  await expect(buyable(page).locator("b")).toHaveText("500원");
  await dragChip(page, chipAt(page, "buy", BASE), await center(cellAt(page, "buy", BASE + 100)));
  await expect(status(page)).toContainText("정정으로 늘어난 1,000원이 현금 주문가능 500원을 넘습니다 (미수 막음)");
  expect(api.writes).toHaveLength(0);
});
