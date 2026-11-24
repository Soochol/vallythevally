import type { Page } from "@playwright/test";
import type { OrdersStatus } from "../src/api/generated/OrdersStatus";
import type { OrdersSwitchInput } from "../src/api/generated/OrdersSwitchInput";
import { CONNECTED_KIWOOM, keyEntry, keyListOf } from "./fixtures/scenario";
import { cell, expect, pollSaved, type Scenario, test } from "./harness";
import { ACCOUNT, accountData, chipAt, cellAt, commandOf, dragChip, openOrder, openOrderWindow, ordersOn, otherAccount, SECOND_ACCOUNT, status, tradingApi, writesTo } from "./order-window";

const CLOCK_START = new Date("2026-11-18T10:00:00+09:00");
const PAUSED_AT = new Date("2026-11-18T10:05:00+09:00");
const OUTSIDE = { x: 5, y: 5 };

const placeRequests = (scenario: Scenario) => scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/trading/commands/place" && r.method() === "POST");

async function arriveAtSamePrice(page: Page, scenario: Scenario, push: () => void): Promise<void> {
  push();
  const listed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/trading/open-orders");
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await listed;
  await page.clock.fastForward(50);
}

async function pressTotal(page: Page): Promise<void> {
  const box = (await page.getByTestId("order-total-buy").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y - 10, { steps: 3 });
  await page.mouse.move(OUTSIDE.x, OUTSIDE.y, { steps: 8 });
}

test.describe("끄는 동안 대상이 바뀐 여러 건 취소", () => {
  test("한 건이던 칩을 끄는 동안 같은 가격에 새 주문이 들어오면 놓는 순간 그 가격 일괄 취소가 바로 나간다", async ({ page, scenario }) => {
    await page.clock.install({ time: CLOCK_START });
    ordersOn(scenario);
    const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5)]);
    await openOrderWindow(page, scenario);
    await page.clock.pauseAt(PAUSED_AT);
    await dragChip(page, chipAt(page, "buy", 70_000), OUTSIDE, false);
    await arriveAtSamePrice(page, scenario, () => api.open.push(openOrder("0000002", "buy", 70_000, 7)));
    await expect(page.getByTestId("order-total-buy")).toContainText("(2)");
    await page.mouse.up();
    await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(1);
    expect(writesTo(api, "cancel-batch")[0]!.body).toMatchObject({ side: "buy", price: 70_000 });
    expect(api.writes).toHaveLength(1);
  });

  test("합계 칸을 끄는 동안 같은 가격에 새 주문이 들어오면 놓는 순간 가격마다 일괄 취소가 바로 나간다", async ({ page, scenario }) => {
    await page.clock.install({ time: CLOCK_START });
    ordersOn(scenario);
    const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 69_900, 3)]);
    await openOrderWindow(page, scenario);
    await page.clock.pauseAt(PAUSED_AT);
    await pressTotal(page);
    await arriveAtSamePrice(page, scenario, () => api.open.push(openOrder("0000003", "buy", 70_000, 9)));
    await expect(page.getByTestId("order-total-buy")).toContainText("(3)");
    await page.mouse.up();
    await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(2);
    expect(writesTo(api, "cancel-batch").map((w) => `${w.body.side}:${w.body.price}`).sort()).toEqual(["buy:69900", "buy:70000"]);
  });

  test("같은 가격에 새 주문이 전송 중이면 합계 칸을 밖에 놓아도 취소가 나가지 않고 전송이 끝나도 나가지 않는다", async ({ page, scenario }) => {
    ordersOn(scenario);
    const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 69_900, 7)]);
    const sending = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
    await openOrderWindow(page, scenario);
    await cellAt(page, "buy", 70_000).dblclick();
    await sending.received;
    await pressTotal(page);
    await page.mouse.up();
    await expect(status(page)).toContainText("보내는 중인 주문");
    expect(writesTo(api, "cancel-batch")).toHaveLength(0);
    sending.reply({ body: commandOf("buy", { orderNo: "0000003", quantity: 1, price: 70_000 }) });
    await expect(status(page)).toContainText("접수");
    expect(writesTo(api, "cancel-batch")).toHaveLength(0);
  });
});

test("답 없음 막대는 계좌를 바꿔도 처음 계좌를 보인다", async ({ page, scenario }) => {
  ordersOn(scenario, [otherAccount()]);
  const api = tradingApi(scenario);
  api.accounts[SECOND_ACCOUNT] = accountData();
  await openOrderWindow(page, scenario);
  let failures = 1;
  await page.route("**/api/trading/commands/place", (route) => {
    if (failures <= 0) return route.fallback();
    failures -= 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "서버가 응답하지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } }) });
  });
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText("서버의 답을 받지 못했습니다");
  await page.locator('button[data-testid="account-label"]').click();
  await page.getByTestId("account-option").nth(1).click();
  await expect(page.locator('button[data-testid="account-label"]')).toHaveText("위탁 2 · 키움 ****-**05");
  await expect(status(page)).toContainText("서버의 답을 받지 못했습니다");
  await expect(status(page)).toContainText("****-**01");
  const resend = status(page).getByRole("button", { name: /다시 보내기/ });
  await expect(resend).toHaveAccessibleName(/\*\*\*\*-\*\*01/);
  await resend.click();
  await pollSaved(() => placeRequests(scenario)).toHaveLength(2);
  const [first, second] = placeRequests(scenario).map((request) => request.postDataJSON() as Record<string, unknown>);
  expect(second!.commandId).toBe(first!.commandId);
  expect(second!.account ?? ACCOUNT).toBe(ACCOUNT);
});

const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const accountList = (page: Page) => settingsDialog(page).getByRole("tabpanel").getByRole("region", { name: "계좌 목록" });
const ordersCalls = (scenario: Scenario) => scenario.requests.filter((r) => r.method() === "PUT" && new URL(r.url()).pathname === "/api/system/orders");

const changedAccountOrders = (): OrdersStatus => ({
  state: "on", accountRef: "ref-k1", accountTail: "12", message: "주문 사용이 켜져 있습니다",
  accounts: [
    { keyId: "k1", broker: "kiwoom", alias: "주계좌", market: true, state: "on", accountRef: "ref-k1", accountTail: "12" },
    { keyId: "k2", broker: "kiwoom", alias: "보조", market: false, state: "account_changed", accountRef: "ref-k2", accountTail: "47" },
  ],
});

test("계좌가 바뀐 주문 사용 스위치는 꺼짐으로 보인다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  scenario.live.kiwoomKeys = keyListOf(keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true }), keyEntry("k2", "보조", { ...CONNECTED_KIWOOM, appKeyTail: "5678" }));
  scenario.live.orders = changedAccountOrders();
  scenario.live.ordersAccountTails = { k2: "47" };
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await accountList(page).getByRole("button", { name: "보조", exact: false }).first().click();
  const orders = accountList(page).getByRole("listitem").nth(1).getByRole("region", { name: "주문 사용" });
  const toggle = orders.getByRole("switch", { name: "주문 사용" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(orders.getByRole("group", { name: "주문 켜기 확인" })).toBeVisible();
  await expect(orders).toContainText("계좌번호(8자리) 끝 2자리: 47");
  expect(ordersCalls(scenario)).toHaveLength(0);
  await orders.getByRole("group", { name: "주문 켜기 확인" }).getByRole("button", { name: "취소", exact: true }).click();
  await orders.getByRole("button", { name: "주문 끄기", exact: true }).click();
  await pollSaved(() => ordersCalls(scenario)).toHaveLength(1);
  expect(ordersCalls(scenario)[0]!.postDataJSON()).toEqual({ enabled: false, confirmAccountTail: null, keyId: "k2" } satisfies OrdersSwitchInput);
});
