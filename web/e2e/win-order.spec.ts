import type { Locator, Page } from "@playwright/test";
import type { FeedBook } from "../src/api/generated/FeedBook";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderCommand } from "../src/api/generated/OrderCommand";
import type { OrderSide } from "../src/api/generated/OrderSide";
import type { TradingOpenOrder } from "../src/api/generated/TradingOpenOrder";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test, windowTabs } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const CODE = "005930";
const ACCOUNT = "synthetic-account";
const BASE = 70_000;

type Write = { path: string; body: Record<string, unknown>; header: string | undefined };

interface Api {
  open: TradingOpenOrder[];
  blocked: boolean;
  writes: Write[];
  placeReply: Partial<OrderCommand>;
  batchFailures: number;
}

const win = (page: Page) => page.getByTestId("order-window");
const status = (page: Page) => page.getByTestId("order-status");
const cellAt = (page: Page, side: OrderSide, price: number): Locator => page.locator(`[data-order-cell][data-side="${side}"][data-price="${price}"]`);
const chipAt = (page: Page, side: OrderSide, price: number): Locator => cellAt(page, side, price).getByTestId("order-chip");
const writesTo = (api: Api, name: string): Write[] => api.writes.filter((w) => w.path === `/api/trading/commands/${name}`);

const openOrder = (orderNo: string, side: OrderSide, price: number, openQuantity: number): TradingOpenOrder => ({
  orderNo, code: CODE, name: "삼성전자", side, quantity: openQuantity, price, openQuantity, status: "접수", orderedAt: "100000", originalOrderNo: null, venue: "krx",
});

const commandOf = (kind: OrderCommand["kind"], patch: Partial<OrderCommand> = {}): OrderCommand => ({
  commandId: "cmd-synthetic-0001", accountRef: ACCOUNT, kind, code: CODE, venue: "krx", quantity: 10, price: BASE, targetOrderNo: null, state: "accepted", reason: null, orderNo: "0000099", reconciled: false, createdAt: 1, updatedAt: 1, ...patch,
});

function ordersOn(scenario: Scenario): void {
  scenario.live.orders = { state: "on", accountRef: ACCOUNT, accountTail: "01", message: "주문 사용이 켜져 있습니다" };
}

function tradingApi(scenario: Scenario, open: TradingOpenOrder[] = []): Api {
  const api: Api = { open, blocked: false, writes: [], placeReply: {}, batchFailures: 0 };
  const apiError = (message: string) => ({ status: 503, body: { error: { code: "internal", message, reason: null, retryAt: null, manualActionRequired: false } } });
  scenario.on((url) => url.pathname === "/api/trading/open-orders", () => ({ body: { accountRef: ACCOUNT, orders: api.open } }));
  scenario.on((url) => url.pathname === "/api/trading/commands", () => ({ body: { accountRef: ACCOUNT, blocked: api.blocked, commands: [] } }));
  scenario.on((url) => url.pathname === "/api/trading/orderable", (request) => ({ body: { accountRef: ACCOUNT, code: CODE, side: new URL(request.url()).searchParams.get("side"), price: BASE, amount: 500_000_000, quantity: 100_000 } }));
  scenario.on((url, request) => url.pathname.startsWith("/api/trading/commands/") && request.method() === "POST", (request) => {
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as Record<string, unknown>;
    api.writes.push({ path, body, header: request.headers()["x-vally-order"] });
    if (path.endsWith("/place")) return { body: commandOf(body.side === "sell" ? "sell" : "buy", { quantity: Number(body.quantity), price: Number(body.price), ...api.placeReply }) };
    if (path.endsWith("/modify")) return { body: commandOf("modify", { price: Number(body.price), targetOrderNo: String(body.orderNo) }) };
    if (path.endsWith("/cancel")) return { body: commandOf("cancel", { targetOrderNo: String(body.orderNo) }) };
    if (path.endsWith("/reconcile")) { api.blocked = false; return { body: { accountRef: ACCOUNT, cleared: 1, openOrders: api.open, executions: [] } }; }
    if (api.batchFailures > 0) { api.batchFailures -= 1; return apiError("서버가 응답하지 못했습니다"); }
    return { body: { accountRef: ACCOUNT, blocked: false, commands: [commandOf("cancel")] } };
  });
  return api;
}

function snapshot(base: number) {
  return {
    symbol: CODE,
    asks: Array.from({ length: 10 }, (_, i) => ({ price: base + 100 * (i + 1), quantity: 10 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: base - 100 * i, quantity: 20 + i })),
    totalAskQuantity: 1000,
    totalBidQuantity: 3000,
    bookTime: null,
  };
}

async function openOrderWindow(page: Page, scenario: Scenario): Promise<void> {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
    { id: "order", link: null, kind: "order", venue: "krx" },
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: 91_000, lowerLimit: 49_000, marketCap: null, listedShares: null, per: null, pbr: null, roe: null, eps: null, bps: null, foreignExhaustionRate: null, high52w: null, low52w: null } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: snapshot(BASE) });
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^호가주문/ }).click();
  await expect(win(page)).toBeVisible();
  await expect(page.getByTestId("price-ladder").locator(".mw-lr")).toHaveCount(20);
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 보이지 않는 요소입니다");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragChip(page: Page, chip: Locator, to: { x: number; y: number }, release = true): Promise<void> {
  const from = await center(chip);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  if (release) await page.mouse.up();
}

test("더블클릭이 그 가격에 지정가 신규를 내고 실시간 호가를 따른다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("order-gate")).toHaveCount(0);

  let sub = "";
  await expect.poll(() => {
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
  await expect.poll(() => writesTo(api, "place")).toHaveLength(1);
  const [place] = writesTo(api, "place");
  expect(place!.header).toBe("1");
  expect(place!.body).toMatchObject({ code: CODE, side: "buy", quantity: 10, price: 70_000, venue: "krx", confirmHighValue: false });
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

test("주문 경로를 고르면 요청에 실리고 창 설정으로 저장된다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(page.getByRole("group", { name: "주문 경로" }).getByRole("button", { name: "KRX" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "주문 경로" }).getByRole("button", { name: "NXT" }).click();
  await cellAt(page, "buy", 70_000).dblclick();
  await expect.poll(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.venue).toBe("nxt");
  await expect.poll(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((w) => w.kind === "order")).toEqual({ id: "order", link: null, kind: "order", venue: "nxt" });
});

test("걸린 주문은 같은 가격 합계의 칩이고 총 접수 행이 방향별 수량과 건수를 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 70_000, 7), openOrder("0000003", "sell", 70_100, 4)]);
  await openOrderWindow(page, scenario);
  await expect(chipAt(page, "buy", 70_000)).toHaveText("12");
  await expect(chipAt(page, "sell", 70_100)).toHaveText("4");
  await expect(page.getByTestId("order-total-buy")).toContainText("매수 접수 12주 (2건)");
  await expect(page.getByTestId("order-total-sell")).toContainText("매도 접수 4주 (1건)");
  await page.getByTestId("order-total-buy").click();
  await expect(page.getByTestId("order-list").locator("li")).toHaveCount(3);
  await page.screenshot({ path: "../target/ux-screens/win-order.png" });
});

test("칩을 같은 방향 칸으로 끌면 정정이고 고스트가 새 가격을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5)]);
  await openOrderWindow(page, scenario);
  await dragChip(page, chipAt(page, "buy", 70_000), await center(cellAt(page, "buy", 69_800)), false);
  await expect(page.getByTestId("order-ghost")).toContainText("→ 69,800원");
  await page.mouse.up();
  await expect.poll(() => writesTo(api, "modify")).toHaveLength(1);
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
  await expect.poll(() => writesTo(api, "cancel-batch")).toHaveLength(1);
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
  await expect.poll(() => writesTo(api, "cancel-batch")).toHaveLength(3);
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
  await expect.poll(() => writesTo(api, "cancel-batch")).toHaveLength(2);
  await expect(status(page)).toContainText("취소 접수");
  await cancelPrice(69_900);
  await expect.poll(() => writesTo(api, "cancel-batch")).toHaveLength(3);
  await cancelPrice(70_000);
  await expect.poll(() => writesTo(api, "cancel-batch")).toHaveLength(4);

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
  await expect.poll(() => writesTo(api, "place")).toHaveLength(1);
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
  await expect.poll(() => writesTo(api, "place")).toHaveLength(2);
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
  await expect.poll(() => writesTo(api, "reconcile")).toHaveLength(1);
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
  await expect.poll(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.filter((w) => w.kind === "order")).toEqual([{ id: "order", link: null, kind: "order", venue: "krx" }]);
  await add.click();
  await expect(page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^호가주문/ })).toContainText("열려 있음");
});
