import type { Locator, Page } from "@playwright/test";
import { type Scenario, expect, test } from "./harness";
import { ACCOUNT, BASE, cellAt, center, chipAt, commandOf, dragChip, openOrder, openOrderWindow, ordersOn, status, tradingApi, writesTo } from "./order-window";

const holdWrite = (scenario: Scenario, name: string) => scenario.hold((url) => url.pathname === `/api/trading/commands/${name}`);
const holdOpenOrders = (scenario: Scenario) => scenario.hold((url) => url.pathname === "/api/trading/open-orders");
const openOrdersBody = (orders: unknown[]) => ({ body: { accountRef: ACCOUNT, orders } });
const noAnswer = { status: 503, body: { error: { code: "internal", message: "서버가 응답하지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } } };
const notPending = (chip: Locator) => expect(chip).not.toHaveAttribute("data-pending", /.+/);

async function ready(page: Page, scenario: Scenario, open: ReturnType<typeof openOrder>[] = []) {
  ordersOn(scenario);
  const api = tradingApi(scenario, open);
  await openOrderWindow(page, scenario);
  return api;
}

test("더블클릭하면 응답 전에 그 칸에 보내는 중 칩과 상태줄이 보인다", async ({ page, scenario }) => {
  await ready(page, scenario);
  const place = holdWrite(scenario, "place");
  await cellAt(page, "buy", BASE).dblclick();
  await place.received;
  const chip = chipAt(page, "buy", BASE);
  await expect(chip).toHaveAttribute("data-pending", "sending");
  await expect(chip).toHaveText("10 보냄…");
  await expect(chip).toHaveAccessibleName("매수 70,000원 10주 주문 보내는 중");
  await expect(status(page)).toContainText("보내는 중 · 매수 10 · 70,000원");
  place.reply({ body: commandOf("buy") });
  await expect(status(page)).toContainText("접수 · 매수 10 · 70,000원");
});

test("같은 가격에 걸린 주문이 있어도 그 칸을 더블클릭하면 신규가 나가고 칩이 합계가 된다", async ({ page, scenario }) => {
  const api = await ready(page, scenario, [openOrder("0000001", "buy", BASE, 12)]);
  const chip = chipAt(page, "buy", BASE);
  await expect(chip).toHaveText("12");
  const place = holdWrite(scenario, "place");
  await chip.dblclick();
  await place.received;
  await expect(chip).toHaveText("12");
  const refetch = holdOpenOrders(scenario);
  place.reply({ body: commandOf("buy", { orderNo: "0000099" }) });
  await refetch.received;
  await expect(chip).toHaveText("22");
  api.open.push(openOrder("0000099", "buy", BASE, 10));
  refetch.reply(openOrdersBody(api.open));
  await expect(status(page)).toContainText("접수 · 매수 10 · 70,000원");
  await expect(chip).toHaveText("22");
  const placed = scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/trading/commands/place");
  expect(placed).toHaveLength(1);
  expect(placed[0]!.postDataJSON()).toMatchObject({ side: "buy", price: BASE, quantity: 10 });
});

test("보내는 중 칩은 응답 전 두 건의 수량 합계를 보인다", async ({ page, scenario }) => {
  await ready(page, scenario);
  const place = holdWrite(scenario, "place");
  const cell = cellAt(page, "buy", BASE);
  await cell.dblclick();
  await place.received;
  await expect(chipAt(page, "buy", BASE)).toHaveText("10 보냄…");
  await chipAt(page, "buy", BASE).dblclick();
  await expect(chipAt(page, "buy", BASE)).toHaveText("20 보냄…");
  await expect(chipAt(page, "buy", BASE)).toHaveAttribute("data-pending", "sending");
  place.reply({ body: commandOf("buy", { orderNo: "0000098" }) });
  await expect(status(page)).toContainText("접수 · 매수 10 · 70,000원");
});

test("접수 응답이 오면 미체결 재조회 전에 칩이 접수로 바뀌고 재조회 뒤에도 하나다", async ({ page, scenario }) => {
  const api = await ready(page, scenario);
  const place = holdWrite(scenario, "place");
  await cellAt(page, "buy", BASE).dblclick();
  await place.received;
  const refetch = holdOpenOrders(scenario);
  place.reply({ body: commandOf("buy", { orderNo: "0000099" }) });
  await refetch.received;
  const chip = chipAt(page, "buy", BASE);
  await expect(chip).toBeVisible();
  await notPending(chip);
  await expect(chip).toHaveText("10");
  api.open.push(openOrder("0000099", "buy", BASE, 10));
  refetch.reply(openOrdersBody(api.open));
  await expect(status(page)).toContainText("접수 · 매수 10");
  await expect(cellAt(page, "buy", BASE).getByTestId("order-chip")).toHaveCount(1);
  await expect(chip).toHaveText("10");
  await notPending(chip);
});

test("거절·답 없음·결과 불명이면 보내는 중 칩이 사라진다", async ({ page, scenario }) => {
  await ready(page, scenario);
  const cases = [
    { price: BASE, reply: { body: commandOf("buy", { state: "rejected", reason: "invalid_order", orderNo: null }) }, text: "거절 · 주문 내용이 올바르지 않습니다" },
    { price: BASE - 100, reply: noAnswer, text: "서버의 답을 받지 못했습니다" },
    { price: BASE - 200, reply: { body: commandOf("buy", { state: "unknown", orderNo: null }) }, text: "결과를 확인하지 못했습니다" },
  ];
  for (const { price, reply, text } of cases) {
    const place = holdWrite(scenario, "place");
    await cellAt(page, "buy", price).dblclick();
    await place.received;
    await expect(chipAt(page, "buy", price)).toHaveAttribute("data-pending", "sending");
    place.reply(reply);
    await expect(status(page)).toContainText(text);
    await expect(chipAt(page, "buy", price)).toHaveCount(0);
  }
});

test("취소를 누르면 즉시 취소 중이고 접수되면 재조회 전에 칩이 사라진다", async ({ page, scenario }) => {
  await ready(page, scenario, [openOrder("0000001", "buy", BASE, 5), openOrder("0000002", "buy", BASE - 100, 3)]);
  const refetch = holdOpenOrders(scenario);

  const single = holdWrite(scenario, "cancel");
  await chipAt(page, "buy", BASE).click({ button: "right" });
  await page.getByRole("menuitem", { name: "5 취소" }).click();
  await single.received;
  await expect(chipAt(page, "buy", BASE)).toHaveAttribute("data-pending", "canceling");
  await expect(chipAt(page, "buy", BASE)).toHaveAccessibleName("매수 70,000원 5주 주문 취소 중");
  await expect(status(page)).toContainText("취소 중");
  single.reply({ body: commandOf("cancel", { targetOrderNo: "0000001" }) });
  await expect(chipAt(page, "buy", BASE)).toHaveCount(0);

  const batch = holdWrite(scenario, "cancel-batch");
  await chipAt(page, "buy", BASE - 100).click({ button: "right" });
  await page.getByRole("menuitem", { name: "이 가격 모두 취소" }).click();
  await batch.received;
  await expect(chipAt(page, "buy", BASE - 100)).toHaveAttribute("data-pending", "canceling");
  await expect(status(page)).toContainText("취소 중 · 매수 69,900원");
  batch.reply({ body: { accountRef: ACCOUNT, blocked: false, commands: [commandOf("cancel", { targetOrderNo: "0000002" })] } });
  await expect(chipAt(page, "buy", BASE - 100)).toHaveCount(0);
  refetch.reply(openOrdersBody([openOrder("0000001", "buy", BASE, 5), openOrder("0000002", "buy", BASE - 100, 3)]));
  await expect(chipAt(page, "buy", BASE)).toHaveCount(0);
});

test("일괄 취소에서 일부가 거절되면 그 주문만 칩에 남는다", async ({ page, scenario }) => {
  await ready(page, scenario, [openOrder("0000001", "buy", BASE, 5), openOrder("0000002", "buy", BASE, 7)]);
  const refetch = holdOpenOrders(scenario);
  const batch = holdWrite(scenario, "cancel-batch");
  await chipAt(page, "buy", BASE).click({ button: "right" });
  await page.getByRole("menuitem", { name: "이 가격 모두 취소" }).click();
  await page.getByRole("menuitem", { name: "이 가격 2건 취소 · 한 번 더 누르기" }).click();
  await batch.received;
  await expect(chipAt(page, "buy", BASE)).toHaveAttribute("data-pending", "canceling");
  batch.reply({ body: { accountRef: ACCOUNT, blocked: false, commands: [
    commandOf("cancel", { targetOrderNo: "0000001" }),
    commandOf("cancel", { targetOrderNo: "0000002", state: "rejected", reason: "order_not_found", orderNo: null }),
  ] } });
  await expect(chipAt(page, "buy", BASE)).toHaveText("7");
  await notPending(chipAt(page, "buy", BASE));
  await expect(status(page)).toContainText("거절");
  refetch.reply(openOrdersBody([openOrder("0000002", "buy", BASE, 7)]));
  await expect(chipAt(page, "buy", BASE)).toHaveText("7");
});

test("취소가 거절되면 칩이 원래대로 돌아온다", async ({ page, scenario }) => {
  await ready(page, scenario, [openOrder("0000001", "buy", BASE, 5)]);
  const cancel = holdWrite(scenario, "cancel");
  await chipAt(page, "buy", BASE).click({ button: "right" });
  await page.getByRole("menuitem", { name: "5 취소" }).click();
  await cancel.received;
  await expect(chipAt(page, "buy", BASE)).toHaveAttribute("data-pending", "canceling");
  cancel.reply({ body: commandOf("cancel", { targetOrderNo: "0000001", state: "rejected", reason: "order_not_found", orderNo: null }) });
  await expect(status(page)).toContainText("거절 · 정정·취소할 주문을 찾지 못했습니다");
  await expect(chipAt(page, "buy", BASE)).toHaveText("5");
  await notPending(chipAt(page, "buy", BASE));
});

test("끌어서 정정하면 원래 칩이 정정 중이고 접수되면 새 칸에 칩이 생긴다", async ({ page, scenario }) => {
  await ready(page, scenario, [openOrder("0000001", "buy", BASE, 5)]);
  const modify = holdWrite(scenario, "modify");
  await dragChip(page, chipAt(page, "buy", BASE), await center(cellAt(page, "buy", BASE - 200)));
  await modify.received;
  await expect(chipAt(page, "buy", BASE)).toHaveAttribute("data-pending", "modifying");
  await expect(chipAt(page, "buy", BASE)).toHaveAccessibleName("매수 70,000원 5주 주문 정정 중");
  await expect(status(page)).toContainText("정정 중 · 70,000원 → 69,800원");
  const refetch = holdOpenOrders(scenario);
  modify.reply({ body: commandOf("modify", { price: BASE - 200, targetOrderNo: "0000001", orderNo: "0000050" }) });
  await refetch.received;
  await expect(chipAt(page, "buy", BASE)).toHaveCount(0);
  const moved = chipAt(page, "buy", BASE - 200);
  await expect(moved).toHaveText("5");
  await notPending(moved);
});

test("보내는 중 칩은 끌거나 우클릭으로 취소할 수 없다", async ({ page, scenario }) => {
  const api = await ready(page, scenario);
  const place = holdWrite(scenario, "place");
  await cellAt(page, "buy", BASE).dblclick();
  await place.received;
  const chip = chipAt(page, "buy", BASE);
  await expect(chip).toHaveAttribute("data-pending", "sending");
  await chip.click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await dragChip(page, chip, { x: 5, y: 5 }, false);
  await expect(page.getByTestId("order-ghost")).toHaveCount(0);
  await page.mouse.up();
  await page.getByTestId("price-ladder").locator(".mw-px").first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "전체 모두 취소" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(chip).toHaveAttribute("data-pending", "sending");
  expect(writesTo(api, "cancel-batch")).toHaveLength(0);
  expect(writesTo(api, "cancel")).toHaveLength(0);
  place.reply({ body: commandOf("buy") });
  await expect(status(page)).toContainText("접수 · 매수 10 · 70,000원");
});

test("접수한 신규를 곧바로 취소하면 취소 접수에서 재조회 전에 칩이 사라진다", async ({ page, scenario }) => {
  await ready(page, scenario);
  const place = holdWrite(scenario, "place");
  await cellAt(page, "buy", BASE).dblclick();
  await place.received;
  const refetch = holdOpenOrders(scenario);
  place.reply({ body: commandOf("buy", { orderNo: "0000099" }) });
  await expect(chipAt(page, "buy", BASE)).toHaveText("10");
  await notPending(chipAt(page, "buy", BASE));
  const cancel = holdWrite(scenario, "cancel");
  await chipAt(page, "buy", BASE).click({ button: "right" });
  await page.getByRole("menuitem", { name: "10 취소" }).click();
  await cancel.received;
  await expect(chipAt(page, "buy", BASE)).toHaveAttribute("data-pending", "canceling");
  cancel.reply({ body: commandOf("cancel", { targetOrderNo: "0000099" }) });
  await expect(chipAt(page, "buy", BASE)).toHaveCount(0);
  refetch.reply(openOrdersBody([]));
});

test("정정이 접수된 뒤 재조회가 원래 주문을 아직 돌려줘도 새 칸에 칩이 남는다", async ({ page, scenario }) => {
  await ready(page, scenario, [openOrder("0000001", "buy", BASE, 5)]);
  const modify = holdWrite(scenario, "modify");
  await dragChip(page, chipAt(page, "buy", BASE), await center(cellAt(page, "buy", BASE - 200)));
  await modify.received;
  const refetch = holdOpenOrders(scenario);
  modify.reply({ body: commandOf("modify", { price: BASE - 200, targetOrderNo: "0000001", orderNo: "0000050" }) });
  await refetch.received;
  await expect(chipAt(page, "buy", BASE - 200)).toHaveText("5");
  refetch.reply(openOrdersBody([openOrder("0000001", "buy", BASE, 5)]));
  await expect(status(page)).toContainText("접수 · 정정");
  await expect(chipAt(page, "buy", BASE - 200)).toHaveText("5");
  await expect(chipAt(page, "buy", BASE)).toHaveCount(0);
});

const placeIds = (scenario: Scenario): string[] => scenario.requests
  .filter((r) => new URL(r.url()).pathname === "/api/trading/commands/place" && r.method() === "POST")
  .map((r) => String((r.postDataJSON() as Record<string, unknown>).commandId));

test("두 신규가 연달아 응답 없음이면 다음 두 신규가 두 id를 차례로 다시 쓴다", async ({ page, scenario }) => {
  await ready(page, scenario);
  const target = cellAt(page, "buy", BASE);
  const firstRound = holdWrite(scenario, "place");
  await target.dblclick();
  await firstRound.received;
  await target.dblclick();
  await expect(page.getByTestId("order-queue")).toHaveText("줄 서는 중 · 2건");
  firstRound.reply(noAnswer);
  await expect.poll(() => placeIds(scenario).length).toBe(2);
  await expect(page.getByTestId("order-queue")).toHaveCount(0);
  const [first, second] = placeIds(scenario);
  expect(second).not.toBe(first);

  const secondRound = holdWrite(scenario, "place");
  await target.dblclick();
  await secondRound.received;
  await target.dblclick();
  await expect(page.getByTestId("order-queue")).toHaveText("줄 서는 중 · 2건");
  secondRound.reply({ body: commandOf("buy") });
  await expect.poll(() => placeIds(scenario).length).toBe(4);
  expect(placeIds(scenario).slice(2)).toEqual([first, second]);
});

test("같은 종목 호가주문창 둘에서 한 창의 신규가 응답 없음이면 다른 창의 같은 신규는 새 id로 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const orderTab = (id: string) => page.locator(`[role=tab][data-window-id="${id}"]`);
  await orderTab("order").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(orderTab("order-2")).toHaveAttribute("aria-selected", "true");
  await orderTab("order").click();
  const noReply = holdWrite(scenario, "place");
  await cellAt(page, "buy", BASE).dblclick();
  await noReply.received;
  noReply.reply(noAnswer);
  await expect.poll(() => placeIds(scenario).length).toBe(1);
  await expect(status(page)).toContainText("다시 보내면 같은 명령으로 보냅니다");

  await orderTab("order-2").click();
  await expect(orderTab("order-2")).toHaveAttribute("aria-selected", "true");
  await cellAt(page, "buy", BASE).dblclick();
  await expect.poll(() => placeIds(scenario).length).toBe(2);
  const [inFirst, inSecond] = placeIds(scenario);
  expect(inSecond).not.toBe(inFirst);

  await orderTab("order").click();
  await cellAt(page, "buy", BASE).dblclick();
  await expect.poll(() => placeIds(scenario).length).toBe(3);
  expect(placeIds(scenario)[2]).toBe(inFirst);
});
