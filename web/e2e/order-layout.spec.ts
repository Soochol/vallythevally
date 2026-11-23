import type { Page } from "@playwright/test";
import type { FeedBook } from "../src/api/generated/FeedBook";
import type { KiwoomEnvironment } from "../src/api/generated/KiwoomEnvironment";
import { CONNECTED_KIWOOM, DEFAULT_SYSTEM_SETTINGS } from "./fixtures/scenario";
import { type Scenario, cell, expect, pollSaved, test } from "./harness";
import { BASE, CODE, chipAt, openOrder, openOrderWindow, ordersOn, tradingApi, win } from "./order-window";

const ladder = (page: Page) => page.getByTestId("order-ladder");
const rows = (page: Page) => page.getByTestId("price-ladder").locator(".mw-lr");

function environmentIs(scenario: Scenario, environment: KiwoomEnvironment): void {
  scenario.live.kiwoomLink = { ...CONNECTED_KIWOOM, environment };
  scenario.reply((url) => url.pathname === "/api/system/settings", { body: { ...DEFAULT_SYSTEM_SETTINGS, environment } });
}

async function bookSub(scenario: Scenario): Promise<string> {
  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  return sub;
}

function pushTrades(scenario: Scenario, prices: readonly number[]): void {
  const requests = scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "trades" && m.symbol === CODE);
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    if (request.type !== "subscribe_feed") continue;
    prices.forEach((price, index) => scenario.live.emit({ type: "feed_trades", sub: request.sub, seq: index + 1, trades: [{ t: scenario.now / 1000 + index + 1, price, qty: 1_234_567, venue: "krx", strength: 101.5 }] }));
  }
}

const sizeWindow = (page: Page, width: number, height?: number) =>
  win(page).evaluate((element, size) => {
    element.style.flex = "none";
    element.style.width = `${size.width}px`;
    if (size.height !== undefined) element.style.height = `${size.height}px`;
  }, { width, height });

test("창 머리에 종목 이름과 코드가 보이고 연동된 종목이 바뀌면 따라 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, true);
  const head = win(page).getByTestId("order-symbol-head");
  await expect(head.getByTestId("order-symbol-name")).toHaveText("삼성전자");
  await expect(head.getByTestId("order-symbol-code")).toHaveText(CODE);
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", "000660");
  await expect(head.getByTestId("order-symbol-code")).toHaveText("000660");
  await expect(head.getByTestId("order-symbol-name")).not.toHaveText("삼성전자");
});

test("실전 계좌에는 실전 배지가, 모의 계좌에는 모의 배지가 계좌 옆에 보인다", async ({ page, scenario }) => {
  environmentIs(scenario, "real");
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const bar = win(page).getByTestId("order-account");
  await expect(bar.getByTestId("account-live")).toHaveText("실전");
  await expect(bar.getByTestId("account-mock")).toHaveCount(0);
  const label = (await bar.getByTestId("account-label").boundingBox())!;
  const badge = (await bar.getByTestId("account-live").boundingBox())!;
  expect(badge.x).toBeGreaterThanOrEqual(label.x + label.width - 1);
  expect(Math.abs(badge.y + badge.height / 2 - (label.y + label.height / 2))).toBeLessThan(label.height);
});

test("모의 계좌에는 모의 배지가 보이고 머리 줄에 경고색 바탕이 깔린다", async ({ page, scenario }) => {
  environmentIs(scenario, "mock");
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const bar = win(page).getByTestId("order-account");
  await expect(bar.getByTestId("account-mock")).toHaveText("모의");
  await expect(bar.getByTestId("account-live")).toHaveCount(0);
  const label = (await bar.getByTestId("account-label").boundingBox())!;
  const badge = (await bar.getByTestId("account-mock").boundingBox())!;
  expect(badge.x).toBeGreaterThanOrEqual(label.x + label.width - 1);
  await expect(win(page).getByTestId("order-symbol-head")).toHaveAttribute("data-mock", "");
  await expect(win(page).getByTestId("account-route")).toHaveText("KRX");
});

test("사다리 위에 열 머리 다섯 개가 있고 사다리를 스크롤해도 남는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await sizeWindow(page, 436, 480);
  const head = page.getByTestId("order-colhead");
  await expect(head.locator("span")).toHaveText(["매도주문", "매도잔량", "호가", "매수잔량", "매수주문"]);
  await ladder(page).evaluate((element) => { element.scrollTop = 0; });
  const firstRow = (await rows(page).first().boundingBox())!;
  const before = (await head.boundingBox())!;
  expect(before.y + before.height).toBeLessThanOrEqual(firstRow.y + 1);
  expect(await ladder(page).evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(40);
  await ladder(page).evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(async () => ladder(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(40);
  const area = (await ladder(page).boundingBox())!;
  const after = (await head.boundingBox())!;
  expect(after.y).toBeGreaterThanOrEqual(area.y - 1);
  expect(after.y + after.height).toBeLessThanOrEqual(area.y + area.height);
  await expect(head.locator("span").first()).toBeVisible();
});

test("주문 칸을 더블클릭해도 글자가 선택되지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const target = page.locator(`[data-order-cell][data-side="buy"][data-price="${BASE}"]`);
  await target.dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  await page.locator(".mw-px-num").first().dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("실시간이 끊기면 창 안에 실시간 끊김 띠가 뜨고 다시 이어지면 사라진다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const sub = await bookSub(scenario);
  const strip = win(page).getByTestId("feed-down");
  await expect(strip).toHaveCount(0);
  scenario.live.emit({ type: "feed_link", sub, live: false, at: 2 });
  await expect(strip).toContainText("실시간 끊김");
  await expect(strip).toContainText("다시 잇는 중");
  await expect(strip).toContainText(/\d{2}:\d{2}:\d{2}부터/);
  await expect(page.locator(".od-ladder-wrap")).toHaveAttribute("data-stale", "");
  await expect(page.locator(`[data-order-cell][data-side="buy"][data-price="${BASE}"]`)).not.toHaveAttribute("data-disabled", "");
  scenario.live.emit({ type: "feed_subscribed", sub, kind: "book" });
  await expect(strip).toHaveCount(0);
  await expect(page.locator(".od-ladder-wrap")).not.toHaveAttribute("data-stale", "");
});

test("최소 크기 420x520에서도 현재가 줄과 매도·매수 호가가 각각 세 단 이상 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const sub = await bookSub(scenario);
  const book: FeedBook = { t: 1, asks: Array.from({ length: 10 }, (_, i) => ({ price: BASE + 100 * (i + 1), qty: 10 + i })), bids: Array.from({ length: 10 }, (_, i) => ({ price: BASE - 100 * i, qty: 20 + i })), totalAskQty: 1000, totalBidQty: 3000, expected: null };
  scenario.live.emit({ type: "feed_book", sub, book });
  pushTrades(scenario, [BASE]);
  await expect(rows(page).locator(".mw-qty-value")).toHaveCount(20);
  await sizeWindow(page, 420, 480);
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await page.getByTestId("order-current").click();
  const visible = async () => ladder(page).evaluate((element) => {
    const area = element.getBoundingClientRect();
    const head = element.querySelector(".od-colhead")!.getBoundingClientRect();
    const top = Math.max(area.top, head.bottom);
    const shown = (row: Element) => { const box = row.getBoundingClientRect(); return box.top >= top - 1 && box.bottom <= area.bottom + 1; };
    const all = Array.from(element.querySelectorAll(".mw-lr"));
    const current = all.findIndex((row) => row.hasAttribute("data-current"));
    return { current: shown(all[current]!), asks: all.filter((row, index) => index < current && row.getAttribute("data-side") === "ask" && shown(row)).length, bids: all.filter((row, index) => index > current && row.getAttribute("data-side") === "bid" && shown(row)).length };
  });
  const seen = await visible();
  expect(seen.current).toBe(true);
  expect(seen.asks).toBeGreaterThanOrEqual(3);
  expect(seen.bids).toBeGreaterThanOrEqual(3);
});

test("현재가 버튼은 스크롤해 간 사다리에서 현재가 줄을 보이는 영역 안으로 되돌린다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  pushTrades(scenario, [BASE]);
  await sizeWindow(page, 436, 480);
  await expect(page.locator(".mw-lr[data-current]")).toHaveCount(1);
  await expect(page.getByTestId("order-current")).toBeEnabled();
  const inside = () => ladder(page).evaluate((element) => {
    const area = element.getBoundingClientRect();
    const box = element.querySelector(".mw-lr[data-current]")!.getBoundingClientRect();
    return box.top >= area.top && box.bottom <= area.bottom;
  });
  await ladder(page).evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(inside).toBe(false);
  await page.getByTestId("order-current").click();
  await expect.poll(inside).toBe(true);
  await ladder(page).evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(inside).toBe(false);
  await page.getByTestId("order-current").click();
  await expect.poll(inside).toBe(true);
});

test("폭 436px 창에서 체결 상자와 종목 정보 카드에 잘린 숫자가 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await sizeWindow(page, 436);
  pushTrades(scenario, [70_000, 70_100, 70_200]);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(3);
  const clipped = () => page.evaluate(() => Array.from(document.querySelectorAll(".mw-tbox *, .mw-card *, .mw-tbox, .mw-card"))
    .filter((element) => Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "") && element.scrollWidth > element.clientWidth)
    .map((element) => `${element.className}:${element.textContent}`));
  expect(await clipped()).toEqual([]);
  await expect(page.getByTestId("ladder-info-card")).toBeHidden();
  await expect(page.locator(".mw-trade-price").first()).toBeHidden();
  await expect(page.locator(".mw-trade-qty").first()).toBeVisible();
  await sizeWindow(page, 900);
  await expect(page.getByTestId("ladder-info-card")).toBeVisible();
  await expect(page.locator(".mw-trade-price").first()).toBeVisible();
  expect(await clipped()).toEqual([]);
});

test("창 안의 모든 글자는 11px 이상이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 12), openOrder("0000002", "sell", 70_100, 7)]);
  await openOrderWindow(page, scenario);
  await sizeWindow(page, 436);
  pushTrades(scenario, [70_000]);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(1);
  await chipAt(page, "buy", 70_000).hover();
  await expect(chipAt(page, "buy", 70_000)).toHaveAttribute("data-add", /.+/);
  const small = () => win(page).evaluate((root) => {
    const found: string[] = [];
    for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
      const own = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
      if (own && getComputedStyle(element).display !== "none" && parseFloat(getComputedStyle(element).fontSize) < 11) found.push(`${element.className}:${getComputedStyle(element).fontSize}`);
      const after = getComputedStyle(element, "::after");
      if (after.content !== "none" && after.content !== "normal" && parseFloat(after.fontSize) < 11) found.push(`${element.className}::after:${after.fontSize}`);
    }
    return found;
  });
  expect(await small()).toEqual([]);
  await page.locator(`[data-order-cell][data-side="sell"][data-price="70200"]`).hover();
  await expect(page.getByTestId("order-preview")).toBeVisible();
  expect(await small()).toEqual([]);
});

test("내 주문 칩의 글자와 바탕 대비가 4.5대 1 이상이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 12), openOrder("0000002", "sell", 70_100, 7)]);
  await openOrderWindow(page, scenario);
  const ratioOf = (chip: ReturnType<typeof chipAt>) => chip.evaluate((element) => {
    const parse = (color: string): number[] => {
      const match = color.match(/rgba?\(([^)]+)\)/);
      if (match === null) throw new Error(`rgb 아닌 색: ${color}`);
      return match[1]!.split(",").map((part) => parseFloat(part));
    };
    const luminance = ([r, g, b]: number[]) => [r!, g!, b!].map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const style = getComputedStyle(element);
    const background = parse(style.backgroundColor);
    if (background.length === 4 && background[3]! < 1) throw new Error(`투명한 바탕: ${style.backgroundColor}`);
    const [light, dark] = [luminance(parse(style.color)), luminance(background)].sort((a, b) => b - a);
    return (light! + 0.05) / (dark! + 0.05);
  });
  expect(await ratioOf(chipAt(page, "buy", 70_000))).toBeGreaterThanOrEqual(4.5);
  expect(await ratioOf(chipAt(page, "sell", 70_100))).toBeGreaterThanOrEqual(4.5);
});
