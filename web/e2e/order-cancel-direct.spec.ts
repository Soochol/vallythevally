import type { Page } from "@playwright/test";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { ACCOUNT, type Api, BASE, chipAt, CODE, commandOf, dragChip, openOrder, openOrderWindow, ordersOn, status, tradingApi, writesTo } from "./order-window";

const OUTSIDE = { x: 5, y: 5 };
const LOWER = BASE - 100;
const UPPER = BASE + 100;
const TWO_AT_BASE = () => [openOrder("0000001", "buy", BASE, 5), openOrder("0000002", "buy", BASE, 7)];
const ACROSS_PRICES = () => [...TWO_AT_BASE(), openOrder("0000003", "buy", LOWER, 3), openOrder("0000004", "sell", UPPER, 4)];

async function open(page: Page, scenario: Scenario, orders: ReturnType<typeof openOrder>[]): Promise<Api> {
  ordersOn(scenario);
  const api = tradingApi(scenario, orders);
  await openOrderWindow(page, scenario);
  return api;
}

const batchesOf = (api: Api): string[] => writesTo(api, "cancel-batch").map((write) => `${write.body.side}:${write.body.price}`).sort();
const batchWrites = (scenario: Scenario) => scenario.requests.filter((request) => new URL(request.url()).pathname === "/api/trading/commands/cancel-batch" && request.method() === "POST");
const batchIdOf = (request: { postDataJSON(): unknown }): unknown => (request.postDataJSON() as Record<string, unknown>).batchId;

async function expectNoConfirm(page: Page): Promise<void> {
  await expect(page.getByTestId("order-cancel-confirm")).toHaveCount(0);
  await expect(page.getByText("한 번 더 누르기")).toHaveCount(0);
}

test("두 건이 걸린 칩을 사다리 밖에 놓으면 확인 없이 그 가격 일괄 취소가 바로 나간다", async ({ page, scenario }) => {
  const api = await open(page, scenario, TWO_AT_BASE());
  await dragChip(page, chipAt(page, "buy", BASE), OUTSIDE);
  await pollSaved(() => batchesOf(api)).toEqual([`buy:${BASE}`]);
  expect(writesTo(api, "cancel-batch")[0]!.body).toMatchObject({ code: CODE, side: "buy", price: BASE });
  await expect(status(page)).toContainText("취소 접수");
  await expectNoConfirm(page);
  expect(api.writes).toHaveLength(1);
});

test("합계 칸을 사다리 밖에 놓으면 확인 없이 가격마다 일괄 취소가 나간다", async ({ page, scenario }) => {
  const api = await open(page, scenario, ACROSS_PRICES());
  await dragChip(page, page.getByTestId("order-total-buy"), OUTSIDE);
  await pollSaved(() => batchesOf(api)).toEqual([`buy:${LOWER}`, `buy:${BASE}`]);
  await expect(status(page)).toContainText("취소 접수");
  await expectNoConfirm(page);
  expect(api.writes).toHaveLength(2);
});

test("빈 곳 우클릭의 전체 모두 취소는 한 번 눌러 가격과 방향마다 나간다", async ({ page, scenario }) => {
  const api = await open(page, scenario, ACROSS_PRICES());
  await page.getByTestId("price-ladder").locator(".mw-px").first().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 취소" });
  await menu.getByRole("menuitem", { name: "전체 모두 취소" }).click();
  await pollSaved(() => batchesOf(api)).toEqual([`buy:${LOWER}`, `buy:${BASE}`, `sell:${UPPER}`]);
  await expect(menu).toHaveCount(0);
  await expectNoConfirm(page);
  expect(api.writes).toHaveLength(3);
});

test("칩 우클릭의 이 가격 모두 취소는 두 건이어도 한 번 눌러 나간다", async ({ page, scenario }) => {
  const api = await open(page, scenario, TWO_AT_BASE());
  await chipAt(page, "buy", BASE).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 목록" });
  await menu.getByRole("menuitem", { name: "이 가격 모두 취소" }).click();
  await pollSaved(() => batchesOf(api)).toEqual([`buy:${BASE}`]);
  await expect(menu).toHaveCount(0);
  await expectNoConfirm(page);
});

test("접수 합계 목록의 매수 모두 취소도 한 번 눌러 나간다", async ({ page, scenario }) => {
  const api = await open(page, scenario, ACROSS_PRICES());
  await page.getByTestId("order-total-buy").click();
  const menu = page.getByRole("menu", { name: "매수 접수 주문" });
  await menu.getByRole("menuitem", { name: "매수 모두 취소" }).click();
  await pollSaved(() => batchesOf(api)).toEqual([`buy:${LOWER}`, `buy:${BASE}`]);
  await expect(menu).toHaveCount(0);
  await expectNoConfirm(page);
});

test("칩을 끄는 동안 같은 가격에 새 주문이 걸리면 놓는 순간 그 가격을 모두 취소한다", async ({ page, scenario }) => {
  const api = await open(page, scenario, [openOrder("0000001", "buy", BASE, 5)]);
  await dragChip(page, chipAt(page, "buy", BASE), OUTSIDE, false);
  api.open.push(openOrder("0000002", "buy", BASE, 7));
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await expect(page.getByTestId("order-total-buy")).toHaveText("12 (2)");
  expect(api.writes).toHaveLength(0);
  await page.mouse.up();
  await pollSaved(() => batchesOf(api)).toEqual([`buy:${BASE}`]);
  await expectNoConfirm(page);
  expect(api.writes).toHaveLength(1);
});

test("끌어서 취소한 주문이 거절되면 상태 막대가 이유를 알리고 칩이 돌아온다", async ({ page, scenario }) => {
  await open(page, scenario, TWO_AT_BASE());
  const batch = scenario.hold((url) => url.pathname === "/api/trading/commands/cancel-batch");
  await dragChip(page, chipAt(page, "buy", BASE), OUTSIDE);
  await batch.received;
  await expect(chipAt(page, "buy", BASE)).toHaveAttribute("data-pending", "canceling");
  const rejected = (targetOrderNo: string) => commandOf("cancel", { targetOrderNo, state: "rejected", reason: "order_not_found", orderNo: null });
  batch.reply({ body: { accountRef: ACCOUNT, blocked: false, commands: [rejected("0000001"), rejected("0000002")] } });
  await expect(status(page)).toContainText("거절");
  await expect(status(page)).toContainText("정정·취소할 주문을 찾지 못했습니다");
  await expect(status(page)).toHaveAttribute("data-tone", "error");
  await expect(chipAt(page, "buy", BASE)).toHaveText("12");
  await expect(chipAt(page, "buy", BASE)).not.toHaveAttribute("data-pending", /.+/);
});

test("메뉴로 취소한 주문의 답이 없으면 상태 막대가 알리고 다시 보내기를 준다", async ({ page, scenario }) => {
  const api = await open(page, scenario, TWO_AT_BASE());
  api.batchFailures = 1;
  await chipAt(page, "buy", BASE).click({ button: "right" });
  await page.getByRole("menuitem", { name: "이 가격 모두 취소" }).click();
  await expect(status(page)).toContainText("서버의 답을 받지 못했습니다");
  await expect(status(page)).toHaveAttribute("data-tone", "error");
  expect(batchWrites(scenario)).toHaveLength(1);
  await page.getByTestId("order-status-action").click();
  await pollSaved(() => batchWrites(scenario).length).toBe(2);
  await expect(status(page)).toContainText("취소 접수");
  const [first, second] = batchWrites(scenario);
  expect(batchIdOf(second!)).toBe(batchIdOf(first!));
});
