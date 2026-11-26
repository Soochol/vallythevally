import type { Locator, Page } from "@playwright/test";
import type { FeedBook } from "../src/api/generated/FeedBook";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test, windowTabs, pollSaved } from "./harness";
import { DEFAULT_ORDER_SETTINGS } from "../src/features/order/orderSettings";
import { ACCOUNT, accountData, BASE, CODE, HELD, cellAt, center, chipAt, commandOf, dragChip, feedSubscriptions, nxtTraded, openOrder, openOrderWindow, ordersOn, otherAccount, requestedVenues, SECOND_ACCOUNT, snapshot, status, tradingApi, venueScene, win, writesTo } from "./order-window";

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
  await expect(status(page)).toContainText("접수 · 매수 10 · 70,000원");
  await expect(status(page).getByRole("button", { name: "되돌리기" })).toBeVisible();
});

test("잔량이 바뀌면 증감 글자가 잔량 칸 바깥 끝에 서고 주문 칸과 겹치지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  const first: FeedBook = { t: 1, asks: [{ price: 70_100, qty: 50 }], bids: [{ price: 70_000, qty: 80 }], totalAskQty: 50, totalBidQty: 80, expected: null };
  scenario.live.emit({ type: "feed_book", sub, book: first });
  await expect(page.getByTestId("price-ladder").locator(".mw-qty-value")).toHaveCount(2);
  scenario.live.emit({ type: "feed_book", sub, book: { ...first, t: 2, asks: [{ price: 70_100, qty: 70 }], bids: [{ price: 70_000, qty: 30 }] } });
  const ladder = page.getByTestId("price-ladder");
  const ask = ladder.locator(".mw-qty[data-side=ask]").filter({ has: page.locator(".mw-qty-change") });
  const bid = ladder.locator(".mw-qty[data-side=bid]").filter({ has: page.locator(".mw-qty-change") });
  await expect(ask.locator(".mw-qty-change")).toHaveText("+20");
  await expect(bid.locator(".mw-qty-change")).toHaveText("−50");
  const askCell = (await ask.boundingBox())!;
  const askChange = (await ask.locator(".mw-qty-change").boundingBox())!;
  expect(askChange.x - askCell.x).toBeLessThanOrEqual(6);
  const bidCell = (await bid.boundingBox())!;
  const bidChange = (await bid.locator(".mw-qty-change").boundingBox())!;
  expect(bidCell.x + bidCell.width - (bidChange.x + bidChange.width)).toBeLessThanOrEqual(6);
  const overlaps = (a: { x: number; width: number }, b: { x: number; width: number }) => a.x < b.x + b.width && b.x < a.x + a.width;
  expect(overlaps(askChange, (await cellAt(page, "sell", 70_100).boundingBox())!)).toBe(false);
  expect(overlaps(bidChange, (await cellAt(page, "buy", 70_000).boundingBox())!)).toBe(false);
});

test("가격이 빈 단이 낀 0D 프레임이 와도 호가주문 사다리의 잔량 칸이 비지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  const full: FeedBook = {
    t: 1,
    asks: Array.from({ length: 10 }, (_, i) => ({ price: 70_100 + 100 * i, qty: 10 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: 70_000 - 100 * i, qty: 20 + i })),
    totalAskQty: 1_000,
    totalBidQty: 3_000,
    expected: null,
  };
  const quantities = page.getByTestId("price-ladder").locator(".mw-qty-value");
  scenario.live.emit({ type: "feed_book", sub, book: full });
  await expect(quantities).toHaveCount(20);
  const shown = await quantities.allTextContents();
  scenario.live.emit({ type: "feed_book", sub, book: { ...full, t: 2, asks: full.asks.map((level, i) => (i === 2 ? null : level)), bids: full.bids.map((level, i) => (i === 4 || i === 5 ? null : level)) } });
  await expect(page.getByTestId("price-ladder").locator(".mw-lr")).toHaveCount(20);
  await expect(quantities).toHaveText(shown);
});

test("같은 칸을 응답 전에 두 번 더블클릭하면 신규가 두 건 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const held = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  const target = cellAt(page, "sell", 70_100);
  await target.dblclick();
  await held.received;
  await target.dblclick();
  await expect(page.getByTestId("order-queue")).toHaveText("줄 서는 중 · 2건");
  held.reply({ body: commandOf("sell", { price: 70_100 }) });
  await expect(status(page)).toContainText("접수 · 매도 10 · 70,100원");
  await expect(page.getByTestId("order-queue")).toHaveCount(0);
  const placed = scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/trading/commands/place");
  expect(placed).toHaveLength(2);
  const ids = placed.map((r) => (r.postDataJSON() as { commandId: string }).commandId);
  expect(new Set(ids).size).toBe(2);
});

test("칩 위에 올려도 더해질 수량을 덧붙이지 않고 칩 숫자만 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 12)]);
  await openOrderWindow(page, scenario);
  await cellAt(page, "sell", 70_200).hover();
  await expect(cellAt(page, "sell", 70_200).getByTestId("order-preview")).toHaveText("매도 10");
  const chip = chipAt(page, "buy", 70_000);
  await chip.hover();
  await expect(cellAt(page, "sell", 70_200).getByTestId("order-preview")).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(chip).not.toHaveAttribute("data-add", /.*/);
  await expect(chip).not.toHaveAttribute("data-add-over", /.*/);
  await expect(chip).not.toHaveAttribute("data-add-margin", /.*/);
  expect(await chip.evaluate((element) => getComputedStyle(element, "::after").content)).toBe("none");
  await expect(chip).toHaveText("12");
  await expect(cellAt(page, "buy", 70_000).getByTestId("order-preview")).toHaveCount(0);
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
  if (process.env.VALLY_E2E_SCREENSHOTS === "1") await page.screenshot({ path: "../target/ux-screens/win-order.png" });
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
  await expect(menu.getByRole("menuitem")).toHaveText(["취소", "취소", "매수 모두 취소"]);
  await expect(menu.getByTestId("order-list-row")).toHaveText(["70,000원 · 5취소", "70,000원 · 7취소"]);
  await menu.getByRole("menuitem", { name: "70,000원 · 5 취소" }).click();
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
  await expect(page.getByTestId("order-ghost")).toContainText("놓으면 69,900원 매수 1건 취소");
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
  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.confirmHighValue).toBe(false);
  await expect(page.getByTestId("order-confirm")).toHaveCount(0);

  await quantity.fill("1429");
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
  api.holdings = [{ ...HELD, quantity: 120, sellableQuantity: 100 }];
  await openOrderWindow(page, scenario);
  await page.getByLabel("수량", { exact: true }).fill("101");
  await cellAt(page, "sell", 70_100).dblclick();
  await expect(status(page)).toContainText("매도 가능 수량(100)을 넘습니다");
  expect(api.writes).toHaveLength(0);
  await page.getByLabel("수량", { exact: true }).fill("100");
  await cellAt(page, "sell", 70_100).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "sell", quantity: 100 });

  await page.getByLabel("수량", { exact: true }).fill("10000");
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText("현금 주문가능 500,000,000원을 넘습니다 (미수 막음) · 최대 7,142");
  expect(writesTo(api, "place")).toHaveLength(1);
});

test("보유가 없는 종목의 매도는 매도 가능 수량 0으로 막히고 매도 가능 조회를 보내지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.holdings = [];
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("summary-buyable")).toContainText("원");
  expect(api.orderableQueries).toContain("buy");
  expect(api.orderableQueries).not.toContain("sell");
  await page.getByLabel("수량", { exact: true }).fill("1");
  await cellAt(page, "sell", 70_100).dblclick();
  await expect(status(page)).toContainText("매도 가능 수량(0)을 넘습니다");
  expect(api.writes).toHaveLength(0);
});

test("매수 가능 조회가 거절되면 칸이 -로 남고 거절 문장을 title로 보이며 상태 막대는 조용하다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  const message = "키움이 이 조회를 거절했습니다(kt00010, HTTP 200, return_code 20, 상세 [2000](571489)): 장이 열리지 않는 날입니다";
  api.buyableFailure = { status: 503, body: { error: { code: "kiwoom_unavailable", message, reason: "business_rejected", retryAt: null, manualActionRequired: false } } };
  await openOrderWindow(page, scenario);
  const buyable = page.getByTestId("summary-buyable");
  await expect(buyable).toHaveAttribute("title", message);
  await expect(buyable.locator("b")).toHaveText("-");
  await expect(page.getByText("키움 조회 멈춤")).toHaveCount(0);
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
  await expect(page.getByRole("menuitem", { name: "70,000원 · 5" })).toBeDisabled();
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
  await expect(status(page)).toContainText("다시 보내면 같은 명령으로 보냅니다");
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

test("답을 못 받은 첫 신규 뒤에 줄 서 있던 두 번째 신규는 새 commandId로 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const held = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  const target = cellAt(page, "buy", 70_000);
  await target.dblclick();
  await held.received;
  await target.dblclick();
  await expect(page.getByTestId("order-queue")).toHaveText("줄 서는 중 · 2건");
  held.reply({ status: 503, body: { error: { code: "internal", message: "서버가 응답하지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } } });
  await pollSaved(() => placeIds(scenario).length).toBe(2);
  const [first, second] = placeIds(scenario);
  expect(second).not.toBe(first);
});

test("답을 못 받은 신규를 다시 보내는 동안 또 누른 신규는 새 commandId로 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const noAnswer = { status: 503, body: { error: { code: "internal", message: "서버가 응답하지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } } };
  const target = cellAt(page, "buy", 70_000);
  const firstHold = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  await target.dblclick();
  await firstHold.received;
  firstHold.reply(noAnswer);
  await expect(status(page)).toContainText("다시 보내면 같은 명령으로 보냅니다");
  const retryHold = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");
  await target.dblclick();
  await retryHold.received;
  await target.dblclick();
  await expect(page.getByTestId("order-queue")).toHaveText("줄 서는 중 · 2건");
  retryHold.reply({ body: commandOf("buy", { price: 70_000 }) });
  await pollSaved(() => placeIds(scenario).length).toBe(3);
  const [first, retried, fresh] = placeIds(scenario);
  expect(retried).toBe(first);
  expect(fresh).not.toBe(first);
});

const daySummaryRequests = (scenario: Scenario, symbol: string) => scenario.requests.filter((r) => new URL(r.url()).pathname === `/api/symbols/${symbol}/day-summary`).length;
const quotesRequests = (scenario: Scenario) => scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/quotes").length;

test("종목을 바꾸면 호가주문창의 당일 요약 조회는 한 번이고 /api/quotes는 부르지 않는다", async ({ page, scenario }) => {
  await page.clock.install({ time: new Date("2026-11-18T10:00:00+09:00") });
  await openOrderWindow(page, scenario, true);
  const quotesBefore = quotesRequests(scenario);
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", "000660");
  await pollSaved(() => daySummaryRequests(scenario, "000660")).toBe(1);
  expect(quotesRequests(scenario)).toBe(quotesBefore);
  await page.clock.fastForward(5_000);
  await pollSaved(() => daySummaryRequests(scenario, "000660")).toBe(2);
  expect(quotesRequests(scenario)).toBe(quotesBefore);
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

test("위 막대를 NXT로 바꾸면 호가주문창의 호가·체결 구독이 nxt이고 사다리가 NXT 장면이며 주문 경로 SOR은 그대로다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  nxtTraded(scenario, true);
  await openOrderWindow(page, scenario);
  venueScene(scenario, { nxt: 65_000 });
  await expect(win(page)).toHaveAttribute("data-quote-venue", "combined");
  await pickDesktopVenue(page, "NXT");
  await pollSaved(() => feedSubscriptions(scenario, "book", "nxt").length).toBe(1);
  await pollSaved(() => feedSubscriptions(scenario, "trades", "nxt").length).toBe(1);
  await expect(win(page)).toHaveAttribute("data-quote-venue", "nxt");
  await expect(page.getByTestId("price-ladder").locator(".mw-px-num").first()).toHaveText("66,000");
  await expect(page.locator(".mw-lr[data-current]")).toContainText("65,000");
  await expect(routeButton(page)).toContainText("SOR");
  await expect(win(page)).toHaveAttribute("data-venue", "combined");
  await cellAt(page, "buy", 65_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.venue).toBe("combined");
});

test("⚙에서 주문 경로를 KRX로 바꿔도 호가·체결 구독은 다시 일어나지 않고 주문은 KRX 경로로 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await pollSaved(() => feedSubscriptions(scenario, "book", "combined").length).toBe(1);
  const messagesBefore = scenario.live.messages.length;
  const quoteVenuesBefore = requestedVenues(scenario, `/api/symbols/${CODE}/order-book`);
  await routeButton(page).click();
  await page.getByTestId("order-settings").getByRole("group", { name: "주문 경로" }).getByRole("button", { name: "KRX" }).click();
  await expect(routeButton(page)).toContainText("KRX");
  await page.keyboard.press("Escape");
  await expect(win(page)).toHaveAttribute("data-venue", "krx");
  await expect(win(page)).toHaveAttribute("data-quote-venue", "combined");
  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.venue).toBe("krx");
  expect(scenario.live.messages.slice(messagesBefore).filter((m) => m.type === "subscribe_feed" || m.type === "unsubscribe")).toEqual([]);
  expect(requestedVenues(scenario, `/api/symbols/${CODE}/order-book`)).toEqual(quoteVenuesBefore);
});

test("NXT에서 거래되지 않는 종목을 NXT로 보면 호가주문창은 통합으로 구독하고 도킹 탭에 통합 표시가 있고 본문에는 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  nxtTraded(scenario, false);
  await openOrderWindow(page, scenario);
  const tab = windowTabs(page).getByRole("tab", { name: /^호가주문/ });
  await expect(tab.locator(".mw-integrated")).toHaveCount(0);
  await pickDesktopVenue(page, "NXT");
  await expect(tab.locator(".mw-integrated")).toHaveText("통합");
  await expect(win(page).locator(".mw-integrated")).toHaveCount(0);
  await expect(win(page)).toHaveAttribute("data-quote-venue", "combined");
  expect(feedSubscriptions(scenario, "book", "nxt")).toHaveLength(0);
  expect(feedSubscriptions(scenario, "trades", "nxt")).toHaveLength(0);
});

test("NXT에서 거래되는 종목을 KRX로 보면 호가주문 도킹 탭에 통합 표시가 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  nxtTraded(scenario, true);
  await openOrderWindow(page, scenario);
  const tab = windowTabs(page).getByRole("tab", { name: /^호가주문/ });
  await pickDesktopVenue(page, "KRX");
  await pollSaved(() => feedSubscriptions(scenario, "book", "krx").length).toBe(1);
  await expect(tab.locator(".mw-integrated")).toHaveCount(0);
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
  await expect(status(page)).toContainText("접수 · 매수 10 · 70,000원");
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

const commandRequests = (scenario: { requests: { url(): string }[] }) => scenario.requests.filter((r) => new URL(r.url()).pathname.startsWith("/api/trading/commands/"));
const SAMPLE = () => [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 70_000, 7), openOrder("0000003", "buy", 69_900, 3), openOrder("0000004", "sell", 70_100, 4)];

test("같은 가격 두 건의 칩을 사다리 밖에 놓으면 고스트가 건수를 알리고 그 가격 일괄 취소가 한 번 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  await dragChip(page, chipAt(page, "buy", 70_000), { x: 5, y: 5 }, false);
  await expect(page.getByTestId("order-ghost")).toContainText("놓으면 70,000원 매수 2건 취소");
  await page.mouse.up();
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(1);
  expect(writesTo(api, "cancel-batch")[0]!.body).toMatchObject({ code: CODE, side: "buy", price: 70_000 });
  expect(writesTo(api, "cancel")).toHaveLength(0);
});

test("칩 우클릭 목록의 주문 항목을 사다리 밖으로 끌면 목록이 닫히고 그 주문 하나만 취소한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 목록" });
  await dragChip(page, menu.getByRole("menuitem", { name: "7 취소" }), { x: 5, y: 5 }, false);
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("order-ghost")).toContainText("놓으면 이 주문 취소");
  await page.mouse.up();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000002" });
  expect(writesTo(api, "cancel-batch")).toHaveLength(0);
  await expect(menu).toHaveCount(0);
});

test("칩 우클릭 목록의 주문 항목을 같은 방향 다른 가격 칸에 놓으면 그 주문만 정정한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  await dragChip(page, page.getByRole("menu", { name: "주문 목록" }).getByRole("menuitem", { name: "7 취소" }), await center(cellAt(page, "buy", 70_300)), false);
  await expect(page.getByTestId("order-ghost")).toContainText("→ 70,300원");
  await page.mouse.up();
  await pollSaved(() => writesTo(api, "modify")).toHaveLength(1);
  expect(writesTo(api, "modify")[0]!.body).toMatchObject({ orderNo: "0000002", price: 70_300 });
  expect(writesTo(api, "cancel")).toHaveLength(0);
});

test("목록 항목을 누르기만 하면 지금처럼 그 주문 하나를 취소한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  await page.getByRole("menu", { name: "주문 목록" }).getByRole("menuitem", { name: "5 취소" }).click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000001" });
});

test("매수 합계 칸을 사다리 밖으로 끌면 매수 가격마다 일괄 취소가 하나씩 나가고 매도는 나가지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  await dragChip(page, page.getByTestId("order-total-buy"), { x: 5, y: 5 }, false);
  await expect(page.getByTestId("order-ghost")).toContainText("놓으면 매수 3건 모두 취소");
  await page.mouse.up();
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(2);
  expect(writesTo(api, "cancel-batch").map((w) => `${w.body.side}:${w.body.price}`).sort()).toEqual(["buy:69900", "buy:70000"]);
  await expect(page.getByRole("menu", { name: "매수 접수 주문" })).toHaveCount(0);
});

test("합계 칸을 조금 끌었다가 그 칸 위나 사다리 칸 위에서 놓으면 요청이 없고 목록도 열리지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  const total = page.getByTestId("order-total-buy");
  await dragChip(page, total, await center(total));
  await dragChip(page, total, await center(cellAt(page, "buy", 69_800)));
  await dragChip(page, total, await center(cellAt(page, "sell", 70_200)));
  expect(commandRequests(scenario)).toHaveLength(0);
  await expect(page.getByRole("menu", { name: "매수 접수 주문" })).toHaveCount(0);
  await expect(page.getByTestId("order-ghost")).toHaveCount(0);
});

test("합계 칸 목록의 주문 항목을 사다리 밖으로 끌면 그 주문 하나만 취소한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  await page.getByTestId("order-total-buy").click();
  const menu = page.getByRole("menu", { name: "매수 접수 주문" });
  await dragChip(page, menu.getByRole("menuitem", { name: "70,000원 · 7" }), { x: 5, y: 5 });
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000002" });
  expect(writesTo(api, "cancel-batch")).toHaveLength(0);
  await expect(menu).toHaveCount(0);
});

test("합계 칸이나 목록 항목을 끄는 중 Esc를 누르면 고스트가 사라지고 요청이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  await dragChip(page, page.getByTestId("order-total-buy"), { x: 5, y: 5 }, false);
  await expect(page.getByTestId("order-ghost")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByTestId("order-ghost")).toHaveCount(0);

  await chipAt(page, "buy", 70_000).click({ button: "right" });
  await dragChip(page, page.getByRole("menu", { name: "주문 목록" }).getByRole("menuitem", { name: "7 취소" }), { x: 5, y: 5 }, false);
  await expect(page.getByTestId("order-ghost")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByTestId("order-ghost")).toHaveCount(0);
  expect(commandRequests(scenario)).toHaveLength(0);
});

test("주문 사용이 막혀 있으면 합계 칸과 목록 항목을 끌어도 요청이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  api.placeReply = { state: "unknown", orderNo: null };
  api.blocked = true;
  await cellAt(page, "buy", 69_800).dblclick();
  await expect(win(page)).not.toHaveAttribute("data-writable", "");
  const before = api.writes.length;
  await dragChip(page, page.getByTestId("order-total-buy"), { x: 5, y: 5 });
  await page.getByTestId("order-total-buy").click();
  await dragChip(page, page.getByRole("menu", { name: "매수 접수 주문" }).getByRole("menuitem", { name: "70,000원 · 7" }), { x: 5, y: 5 });
  await expect(page.getByTestId("order-ghost")).toHaveCount(0);
  expect(api.writes).toHaveLength(before);
});

test("목록이 열린 채 항목이나 합계 칸을 누르고 Esc를 누르면 끌기가 중단되어 이어 끌어도 요청이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const item = page.getByRole("menu", { name: "주문 목록" }).getByRole("menuitem", { name: "7 취소" });
  const from = await center(item);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("order-ghost")).toHaveCount(0);

  const total = page.getByTestId("order-total-buy");
  await total.click();
  const at = await center(total);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5, { steps: 6 });
  await expect(page.getByTestId("order-ghost")).toHaveCount(0);
  await page.mouse.up();
  expect(commandRequests(scenario)).toHaveLength(0);
});

test("합계 칸을 끌다가 Esc로 중단하고 그 칸 위에서 놓아도 목록이 열리지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  const total = page.getByTestId("order-total-buy");
  await dragChip(page, total, { x: 5, y: 5 }, false);
  await expect(page.getByTestId("order-ghost")).toBeVisible();
  await page.keyboard.press("Escape");
  const at = await center(total);
  await page.mouse.move(at.x, at.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole("menu", { name: "매수 접수 주문" })).toHaveCount(0);
  expect(commandRequests(scenario)).toHaveLength(0);
});

test("주문 목록에서 글자 키로 항목을 찾아 이동한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, SAMPLE());
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 목록" });
  await menu.getByRole("menuitem", { name: "5 취소" }).focus();
  await page.keyboard.press("7");
  await expect(menu.getByRole("menuitem", { name: "7 취소" })).toBeFocused();
});

test.describe("주문 후속", () => {
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
});
