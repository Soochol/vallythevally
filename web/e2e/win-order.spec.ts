import type { Locator, Page } from "@playwright/test";
import type { FeedBook } from "../src/api/generated/FeedBook";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test, windowTabs, pollSaved } from "./harness";
import { DEFAULT_ORDER_SETTINGS } from "../src/features/order/orderSettings";
import { BASE, CODE, cellAt, center, chipAt, commandOf, dragChip, openOrder, openOrderWindow, ordersOn, snapshot, status, tradingApi, win, writesTo } from "./order-window";

test("더블클릭이 그 가격에 지정가 신규를 내고 실시간 호가를 따른다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("order-gate")).toHaveCount(0);

  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  const book: FeedBook = { t: 1, asks: [{ price: 70_100, qty: 50 }, { price: 70_200, qty: 40 }], bids: [{ price: 70_000, qty: 80 }, { price: 69_900, qty: 60 }], totalAskQty: 90, totalBidQty: 140, expected: null };
  scenario.live.emit({ type: "feed_book", sub, book });
  await expect(page.getByTestId("price-ladder").locator(".mw-lr")).toHaveCount(20);
  await expect(cellAt(page, "buy", 70_000)).toBeVisible();
  await expect(page.getByTestId("price-ladder").locator(".mw-qty-value")).toHaveCount(4);

  await cellAt(page, "buy", 70_000).hover();
  await expect(cellAt(page, "buy", 70_000).locator(".od-preview")).toHaveText("매수 10");

  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  const [place] = writesTo(api, "place");
  expect(place!.header).toBe("1");
  expect(place!.body).toMatchObject({ code: CODE, side: "buy", quantity: 10, price: 70_000, venue: "combined", confirmHighValue: false });
  expect(String(place!.body.commandId)).toMatch(/^cmd-[0-9a-f-]{36}$/);
  await expect(status(page)).toContainText("접수 · 매수 10주 70,000원");
  await expect(status(page).getByRole("button", { name: "되돌리기" })).toBeVisible();
});

test("같은 동작을 중복해서 더블클릭해도 명령은 하나다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const held = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  const target = cellAt(page, "sell", 70_100);
  await target.dblclick();
  await held.received;
  await target.dblclick();
  await expect(page.getByTestId("order-queue")).toHaveText("줄 서는 중 · 1건");
  held.reply({ body: commandOf("sell", { price: 70_100 }) });
  await expect(status(page)).toContainText("접수 · 매도 10주 70,100원");
  expect(api.writes).toHaveLength(0);
  const placed = scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/trading/commands/place");
  expect(placed).toHaveLength(1);
});

const routeButton = (page: Page) => page.getByTestId("order-settings-button");
const NXT_NOT_TRADED = "NXT에서 거래되지 않는 종목입니다";

function nxtSettingOn(scenario: Scenario, nxtEnabled?: boolean): void {
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), orderSettings: { ...DEFAULT_ORDER_SETTINGS, venue: "nxt" } });
  if (nxtEnabled !== undefined) scenario.reply(`/api/symbols/${CODE}`, { body: { code: CODE, name: "삼성전자", kind: "common", market: "kospi", nxtEnabled } });
}

test("기본 주문 경로는 SOR이다: 창에 저장된 KRX는 읽지 않고 입력 줄에 주문 경로 묶음이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx");
  await expect(routeButton(page)).toContainText("SOR");
  await expect(routeButton(page)).toHaveAccessibleName("호가주문 설정 · 주문 경로 SOR");
  await expect(page.getByRole("group", { name: "주문 경로" })).toHaveCount(0);
  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.venue).toBe("combined");
});

test("설정에서 주문 경로를 NXT로 바꾸면 단추와 요청에 실리고 앱 설정으로 저장되며 창 설정은 그대로다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await routeButton(page).click();
  await expect(page.getByTestId("order-settings")).toBeVisible();
  await expect(routeButton(page)).toHaveAttribute("aria-expanded", "true");
  const routes = page.getByTestId("order-settings").getByRole("group", { name: "주문 경로" });
  await expect(routes.getByRole("button", { name: "SOR" })).toHaveAttribute("aria-pressed", "true");
  await routes.getByRole("button", { name: "NXT" }).click();
  await expect(routeButton(page)).toContainText("NXT");
  await expect(routeButton(page)).toHaveAccessibleName("호가주문 설정 · 주문 경로 NXT");
  await page.keyboard.press("Escape");
  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.venue).toBe("nxt");
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ venue: "nxt" });
  await page.reload();
  await expect(win(page)).toBeVisible();
  await expect(routeButton(page)).toContainText("NXT");
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((w) => w.kind === "order")).toEqual({ id: "order", link: null, kind: "order", venue: "krx" });
});

test("NXT에서 거래되지 않는 종목은 경로가 NXT일 때 단추에 경고가 있고 신규를 보내지 않으며 SOR로 바꾸면 보낸다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  nxtSettingOn(scenario, false);
  await openOrderWindow(page, scenario);
  await expect(routeButton(page)).toHaveAttribute("data-warn", "");
  await expect(routeButton(page)).toHaveAttribute("title", NXT_NOT_TRADED);
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText(NXT_NOT_TRADED);
  expect(writesTo(api, "place")).toHaveLength(0);
  await routeButton(page).click();
  await page.getByTestId("order-settings").getByRole("group", { name: "주문 경로" }).getByRole("button", { name: "SOR" }).click();
  await expect(routeButton(page)).not.toHaveAttribute("data-warn", "");
  await page.keyboard.press("Escape");
  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.venue).toBe("combined");
});

test("NXT에서 거래되는 종목은 경로가 NXT여도 경고 없이 신규를 보낸다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  nxtSettingOn(scenario, true);
  await openOrderWindow(page, scenario);
  await expect(routeButton(page)).not.toHaveAttribute("data-warn", "");
  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.venue).toBe("nxt");
});

test("걸린 주문은 같은 가격 합계의 칩이고 사다리 아래 두 칸이 방향별 수량과 건수를 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 70_000, 7), openOrder("0000003", "sell", 70_100, 4)]);
  await openOrderWindow(page, scenario);
  await expect(chipAt(page, "buy", 70_000)).toHaveText("12");
  await expect(chipAt(page, "sell", 70_100)).toHaveText("4");
  await expect(page.getByTestId("order-total-buy")).toHaveText("12 (2)");
  await expect(page.getByTestId("order-total-buy")).toHaveAccessibleName("매수 접수 12주 2건");
  await expect(page.getByTestId("order-total-sell")).toHaveText("4 (1)");
  await expect(page.getByTestId("order-total-sell")).toHaveAccessibleName("매도 접수 4주 1건");
  await expect(page.getByText("매도 접수", { exact: true })).toHaveCount(0);
  await expect(page.getByText("매수 접수", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("order-list")).toHaveCount(0);
  await page.screenshot({ path: "../target/ux-screens/win-order.png" });
});

test("접수 합계 칸은 사다리 주문 칸과 같은 열이고 사다리와 총잔량 띠 사이 줄에 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000003", "sell", 70_100, 4)]);
  await openOrderWindow(page, scenario);
  const box = async (locator: Locator) => (await locator.boundingBox())!;
  const sell = await box(page.getByTestId("order-total-sell"));
  const buy = await box(page.getByTestId("order-total-buy"));
  const sellCell = await box(cellAt(page, "sell", 70_100));
  const buyCell = await box(cellAt(page, "buy", 70_000));
  expect(Math.abs(sell.x - sellCell.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(sell.width - sellCell.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(buy.x - buyCell.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(buy.width - buyCell.width)).toBeLessThanOrEqual(1);
  expect(sell.y).toBe(buy.y);
  const ladder = await box(page.getByTestId("order-ladder"));
  expect(sell.y).toBeGreaterThanOrEqual(ladder.y + ladder.height - 1);
  expect(sell.y + sell.height).toBeLessThanOrEqual((await box(page.getByTestId("order-total-ask"))).y);
});

test("접수 합계 칸을 누르면 주문 메뉴가 열려 주문 하나 또는 그 쪽 전부를 취소한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 70_000, 7), openOrder("0000003", "sell", 70_100, 4)]);
  await openOrderWindow(page, scenario);
  const total = page.getByTestId("order-total-buy");
  await total.click();
  const menu = page.getByRole("menu", { name: "매수 접수 주문" });
  await expect(menu).toContainText("매수 접수 2건");
  await expect(menu.getByRole("menuitem")).toHaveText(["70,000원 · 5주", "70,000원 · 7주", "매수 모두 취소"]);
  await menu.getByRole("menuitem", { name: "70,000원 · 5주" }).click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000001" });
  await total.click();
  await page.getByRole("menuitem", { name: "매수 모두 취소" }).click();
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(1);
  expect(writesTo(api, "cancel-batch")[0]!.body).toMatchObject({ code: CODE, side: "buy", price: 70_000 });
});

test("접수 주문이 없으면 두 칸이 0 (0)이고 메뉴는 안내만 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, []);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("order-total-buy")).toHaveText("0 (0)");
  await expect(page.getByTestId("order-total-sell")).toHaveText("0 (0)");
  await page.getByTestId("order-total-sell").click();
  const menu = page.getByRole("menu", { name: "매도 접수 주문" });
  await expect(menu).toContainText("걸려 있는 주문이 없습니다");
  await expect(menu.getByRole("menuitem")).toHaveCount(0);
});

test("칩을 같은 방향 칸으로 끌면 정정이고 고스트가 새 가격을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5)]);
  await openOrderWindow(page, scenario);
  await dragChip(page, chipAt(page, "buy", 70_000), await center(cellAt(page, "buy", 69_800)), false);
  await expect(page.getByTestId("order-ghost")).toContainText("→ 69,800원");
  await page.mouse.up();
  await pollSaved(() => writesTo(api, "modify")).toHaveLength(1);
  expect(writesTo(api, "modify")[0]!.body).toMatchObject({ orderNo: "0000001", price: 69_800, confirmHighValue: false });
  await expect(status(page)).toContainText("접수 · 정정");
});

test("칩을 사다리 밖으로 끌면 그 가격 일괄 취소이고 Esc는 중단한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 69_900, 3)]);
  await openOrderWindow(page, scenario);

  await dragChip(page, chipAt(page, "buy", 69_900), { x: 5, y: 5 }, false);
  await expect(page.getByTestId("order-ghost")).toContainText("놓으면 취소");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByTestId("order-ghost")).toHaveCount(0);
  expect(scenario.requests.filter((r) => new URL(r.url()).pathname.startsWith("/api/trading/commands/"))).toHaveLength(0);

  await dragChip(page, chipAt(page, "buy", 70_000), { x: 5, y: 5 });
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(1);
  expect(writesTo(api, "cancel-batch")[0]!.body).toMatchObject({ code: CODE, side: "buy", price: 70_000 });
  expect(String(writesTo(api, "cancel-batch")[0]!.body.batchId)).toMatch(/^batch-[0-9a-f-]{36}$/);
  await expect(status(page)).toContainText("취소 접수");
});

test("빈 곳 우클릭의 전체 취소는 가격과 방향마다 새 batchId로 보낸다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 69_900, 3), openOrder("0000003", "sell", 70_100, 4)]);
  await openOrderWindow(page, scenario);
  await page.getByTestId("price-ladder").locator(".mw-px").first().click({ button: "right" });
  await expect(page.getByRole("menu", { name: "주문 취소" })).toBeVisible();
  await page.getByRole("menuitem", { name: "전체 모두 취소" }).click();
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(3);
  const batches = writesTo(api, "cancel-batch").map((w) => w.body);
  expect(batches.map((b) => `${b.side}:${b.price}`).sort()).toEqual(["buy:69900", "buy:70000", "sell:70100"]);
  expect(new Set(batches.map((b) => b.batchId)).size).toBe(3);
});

test("일괄 취소의 batchId는 답을 못 받은 같은 동작의 재전송에만 다시 쓴다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 69_900, 3)]);
  api.batchFailures = 1;
  await openOrderWindow(page, scenario);
  const cancelPrice = async (price: number) => {
    await chipAt(page, "buy", price).click({ button: "right" });
    await page.getByRole("menuitem", { name: "이 가격 모두 취소" }).click();
  };

  await cancelPrice(70_000);
  await expect(status(page)).toContainText("서버의 답을 받지 못했습니다");
  await cancelPrice(70_000);
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(2);
  await expect(status(page)).toContainText("취소 접수");
  await cancelPrice(69_900);
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(3);
  await cancelPrice(70_000);
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(4);

  const [failed, resent, otherPrice, later] = writesTo(api, "cancel-batch").map((w) => w.body);
  expect(resent!.batchId).toBe(failed!.batchId);
  expect(otherPrice!.batchId).not.toBe(failed!.batchId);
  expect(otherPrice).toMatchObject({ side: "buy", price: 69_900 });
  expect(later!.batchId).not.toBe(failed!.batchId);
});

test("1억원 이상 주문은 확인 상자를 눌러야 보내진다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const quantity = page.getByLabel("수량", { exact: true });

  await quantity.fill("1428");
  await cellAt(page, "buy", 70_000).hover();
  await expect(page.getByTestId("order-estimate")).toHaveText("99,960,000원");
  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.confirmHighValue).toBe(false);
  await expect(page.getByTestId("order-confirm")).toHaveCount(0);

  await quantity.fill("1429");
  await cellAt(page, "buy", 70_000).hover();
  await expect(page.getByTestId("order-estimate")).toHaveText("100,030,000원");
  await cellAt(page, "buy", 70_000).dblclick();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("고액 주문 확인");
  const send = dialog.getByRole("button", { name: "주문 보내기" });
  await expect(send).toBeDisabled();
  expect(writesTo(api, "place")).toHaveLength(1);
  await dialog.getByRole("checkbox").check();
  await expect(send).toBeEnabled();
  await send.click();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(2);
  expect(writesTo(api, "place")[1]!.body).toMatchObject({ quantity: 1429, price: 70_000, confirmHighValue: true });
});

test("서버가 거절한 사유를 상태 줄에 그대로 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  api.placeReply = { state: "rejected", reason: "out_of_limit", orderNo: null };
  await cellAt(page, "sell", 70_300).dblclick();
  await expect(status(page)).toContainText("거절 · 상·하한가 범위를 벗어난 가격입니다");
  api.placeReply = { state: "rejected", reason: "off_tick", orderNo: null };
  await cellAt(page, "sell", 70_400).dblclick();
  await expect(status(page)).toContainText("거절 · 호가 단위에 맞지 않는 가격입니다");
});

test("가능 수량·금액을 넘는 주문은 보내기 전에 상태 줄이 막는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await page.getByLabel("수량", { exact: true }).fill("100001");
  await cellAt(page, "sell", 70_100).dblclick();
  await expect(status(page)).toContainText("매도 가능 수량 100,000주를 넘습니다");
  expect(api.writes).toHaveLength(0);
});

test("결과 불명이면 새 주문 칸을 막고 조회로 확인하면 풀린다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  api.placeReply = { state: "unknown", orderNo: null };
  api.blocked = true;
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText("결과를 확인하지 못했습니다");
  await expect(win(page)).not.toHaveAttribute("data-writable", "");
  await expect(cellAt(page, "buy", 69_900)).toHaveAttribute("data-disabled", "");
  await cellAt(page, "buy", 69_900).dblclick();
  expect(writesTo(api, "place")).toHaveLength(1);

  await status(page).getByRole("button", { name: "조회로 확인" }).click();
  await pollSaved(() => writesTo(api, "reconcile")).toHaveLength(1);
  await expect(status(page)).toContainText("조회로 확인했습니다");
  await expect(win(page)).toHaveAttribute("data-writable", "");
  await expect(cellAt(page, "buy", 69_900)).not.toHaveAttribute("data-disabled", "");
});

test("주문 사용이 꺼져 있으면 주문 칸을 막고 이유와 시스템 설정 길을 보인다", async ({ page, scenario }) => {
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("order-gate")).toContainText("주문 사용이 꺼져 있습니다");
  await expect(cellAt(page, "buy", 70_000)).toHaveAttribute("data-disabled", "");
  await cellAt(page, "buy", 70_000).dblclick();
  expect(api.writes).toHaveLength(0);
  await page.getByTestId("order-gate").getByRole("button", { name: "시스템 설정 열기" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("쓰기가 막혀 있으면 접수 합계 메뉴의 취소 항목이 꺼져 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5)]);
  await openOrderWindow(page, scenario);
  api.placeReply = { state: "unknown", orderNo: null };
  api.blocked = true;
  await cellAt(page, "buy", 69_900).dblclick();
  await expect(win(page)).not.toHaveAttribute("data-writable", "");
  const before = api.writes.length;
  await page.getByTestId("order-total-buy").click();
  await expect(page.getByRole("menuitem", { name: "70,000원 · 5주" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "매수 모두 취소" })).toBeDisabled();
  expect(api.writes).toHaveLength(before);
});

test("창 더하기 메뉴에서 호가주문 창이 열리고 하나만 만들어진다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: snapshot(BASE) });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: null, lowerLimit: null } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const add = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" });
  await add.click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^호가주문/ }).click();
  await expect(windowTabs(page).getByRole("tab", { name: /^호가주문/ })).toHaveCount(1);
  await pollSaved(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.filter((w) => w.kind === "order")).toEqual([{ id: "order", link: null, kind: "order", venue: "krx" }]);
  await add.click();
  await expect(page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^호가주문/ })).toContainText("1개 열림");
});

const placeIds = (scenario: Scenario): string[] => scenario.requests
  .filter((r) => new URL(r.url()).pathname === "/api/trading/commands/place" && r.method() === "POST")
  .map((r) => String((r.postDataJSON() as Record<string, unknown>).commandId));

test("답을 못 받은 신규는 다른 종목을 보고 돌아와 다시 해도 같은 commandId로 보낸다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, true);
  const held = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  await cellAt(page, "buy", 70_000).dblclick();
  await held.received;
  held.reply({ status: 503, body: { error: { code: "internal", message: "서버가 응답하지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } } });
  await expect(status(page)).toContainText("같은 동작을 다시 하면 같은 명령으로 보냅니다");
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", "000660");
  await cell(page, 1).click();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expect(page.getByTestId("price-ladder").locator(".mw-lr")).toHaveCount(20);
  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => placeIds(scenario).length).toBe(2);
  const [first, second] = placeIds(scenario);
  expect(second).toBe(first);
});

test("200 응답의 본문이 끊기면 답을 못 받은 것으로 보고 같은 commandId로 다시 보낸다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  let cut = true;
  await page.route("**/api/trading/commands/place", async (route) => {
    if (!cut) return route.fallback();
    cut = false;
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"commandId":"cmd-' });
  });
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText("서버의 답을 받지 못했습니다");
  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => placeIds(scenario).length).toBe(2);
  const [first, second] = placeIds(scenario);
  expect(second).toBe(first);
});

test("앱 거래소가 KRX이면 호가주문 도킹 탭에 통합 표시가 있고 본문에는 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const tab = windowTabs(page).getByRole("tab", { name: /^호가주문/ });
  await expect(tab.locator(".mw-integrated")).toHaveCount(0);
  await pickDesktopVenue(page, "KRX");
  await expect(tab.locator(".mw-integrated")).toHaveText("통합");
  await expect(win(page).locator(".mw-integrated")).toHaveCount(0);
});

const ladderFirstRowTop = (page: Page) => page.getByTestId("price-ladder").locator(".mw-lr").first().evaluate((element) => element.getBoundingClientRect().top);

test("접수 알림은 사다리를 움직이지 않고 4초 뒤 사라진다", async ({ page, scenario }) => {
  await page.clock.install({ time: new Date("2026-11-18T10:00:00+09:00") });
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(status(page)).toHaveCount(0);
  const before = await ladderFirstRowTop(page);
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toHaveAttribute("data-tone", "ok");
  await expect(status(page)).toContainText("접수 · 매수 10주 70,000원");
  expect(await ladderFirstRowTop(page)).toBe(before);
  await page.clock.fastForward(5_000);
  await expect(status(page)).toHaveCount(0);
  expect(await ladderFirstRowTop(page)).toBe(before);
});

test("거절 알림은 시간이 지나도 남고 닫기 단추로 사라진다", async ({ page, scenario }) => {
  await page.clock.install({ time: new Date("2026-11-18T10:00:00+09:00") });
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  api.placeReply = { state: "rejected", reason: "out_of_limit", orderNo: null };
  await cellAt(page, "sell", 70_300).dblclick();
  await expect(status(page)).toContainText("거절 · 상·하한가 범위를 벗어난 가격입니다");
  await page.clock.fastForward(10_000);
  await expect(status(page)).toContainText("거절 · 상·하한가 범위를 벗어난 가격입니다");
  await status(page).getByRole("button", { name: "닫기" }).click();
  await expect(status(page)).toHaveCount(0);
});

test("결과 미확인 알림은 시간이 지나도 남고 조회로 확인하면 풀린다", async ({ page, scenario }) => {
  await page.clock.install({ time: new Date("2026-11-18T10:00:00+09:00") });
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  api.placeReply = { state: "unknown", orderNo: null };
  api.blocked = true;
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText("결과를 확인하지 못했습니다");
  await page.clock.fastForward(10_000);
  await expect(status(page)).toContainText("결과를 확인하지 못했습니다");
  await status(page).getByRole("button", { name: "조회로 확인" }).click();
  await expect(status(page)).toContainText("조회로 확인했습니다");
  await expect(win(page)).toHaveAttribute("data-writable", "");
});
