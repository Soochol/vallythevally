import type { Page } from "@playwright/test";
import type { ClientMessage } from "../src/api/generated/ClientMessage";
import type { FeedBook } from "../src/api/generated/FeedBook";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { TradePrint } from "../src/api/generated/TradePrint";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pollSaved, test } from "./harness";
import { BASE, CODE, cellAt, openOrderWindow, ordersOn, tradingApi } from "./order-window";
import { RenderProbe } from "./render-probe";

const LEVELS = 10;
const FRAMES = 100;
const WATCHED = {
  ladder: "[data-testid=price-ladder]",
  ladderRow: ".mw-lr",
  account: "[data-testid=order-account]",
  summary: "[data-testid=order-summary]",
  quantityRow: "[data-testid=order-quantity-row]",
  totals: "[data-testid=order-totals]",
};

type FeedRequest = Extract<ClientMessage, { type: "subscribe_feed" }>;
const feedSub = (scenario: Scenario, kind: FeedRequest["kind"]): string | undefined =>
  scenario.live.messages.filter((m): m is FeedRequest => m.type === "subscribe_feed" && m.kind === kind && m.symbol === CODE).at(-1)?.sub;

class Book {
  private readonly asks = Array.from({ length: LEVELS }, (_, i) => 10 + i);
  private readonly bids = Array.from({ length: LEVELS }, (_, i) => 20 + i);
  private t = 0;

  setAsk(level: number, quantity: number): this {
    this.asks[level] = quantity;
    return this;
  }

  frame(): FeedBook {
    this.t += 1;
    return {
      t: this.t,
      asks: this.asks.map((qty, i) => ({ price: BASE + 100 * (i + 1), qty })),
      bids: this.bids.map((qty, i) => ({ price: BASE - 100 * i, qty })),
      totalAskQty: this.asks.reduce((sum, qty) => sum + qty, 0),
      totalBidQty: this.bids.reduce((sum, qty) => sum + qty, 0),
      expected: null,
    };
  }
}

const askQuantity = (page: Page, level: number) => page.locator(".mw-lr", { has: page.locator(".mw-px-num", { hasText: new RegExp(`^${(BASE + 100 * (level + 1)).toLocaleString("en-US")}$`) }) }).locator(".mw-qty[data-side=ask] .mw-qty-value");

async function afterFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

async function waitForMessages(page: Page, probe: RenderProbe, received: number): Promise<void> {
  await page.waitForFunction((count) => (window as unknown as { __probe: { messages: number } }).__probe.messages >= count, received, { polling: 10 });
  expect(await probe.messages()).toBeGreaterThanOrEqual(received);
}

async function openLiveOrderWindow(page: Page, scenario: Scenario): Promise<{ probe: RenderProbe; book: Book; sub: string }> {
  const probe = await RenderProbe.install(page);
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await pollSaved(() => feedSub(scenario, "book")).toBeDefined();
  const sub = feedSub(scenario, "book")!;
  const book = new Book();
  scenario.live.emit({ type: "feed_book", sub, book: book.frame() });
  await expect(askQuantity(page, 0)).toHaveText("10");
  await probe.watch(WATCHED);
  await afterFrames(page);
  await probe.reset();
  return { probe, book, sub };
}

test("한 가격의 잔량만 바뀐 호가 프레임은 사다리 줄 하나만 다시 그리고 계좌 띠·보유 요약·수량 줄은 그대로 둔다", async ({ page, scenario }) => {
  const { probe, book, sub } = await openLiveOrderWindow(page, scenario);
  scenario.live.emit({ type: "feed_book", sub, book: book.setAsk(3, 18).frame() });
  await expect(askQuantity(page, 3)).toHaveText("18");
  await afterFrames(page);
  const counts = await probe.counts();
  test.info().annotations.push({ type: "renders", description: JSON.stringify(counts) });
  expect(counts.ladderRow).toBe(1);
  expect(counts.account).toBe(0);
  expect(counts.summary).toBe(0);
  expect(counts.quantityRow).toBe(0);
});

test("같은 프레임 안에 호가 프레임 다섯 개가 오면 사다리를 한 번만 그리고 마지막 값을 보인다", async ({ page, scenario }) => {
  const { probe, book, sub } = await openLiveOrderWindow(page, scenario);
  await probe.holdFrames();
  const before = await probe.messages();
  for (let level = 0; level < 5; level++) scenario.live.emit({ type: "feed_book", sub, book: book.setAsk(level, 14 + level).frame() });
  await waitForMessages(page, probe, before + 5);
  await probe.releaseFrames();
  await expect(askQuantity(page, 4)).toHaveText("18");
  await afterFrames(page);
  const counts = await probe.counts();
  test.info().annotations.push({ type: "renders", description: JSON.stringify(counts) });
  expect(counts.ladder).toBe(1);
  for (let level = 0; level < 5; level++) await expect(askQuantity(page, level)).toHaveText(String(14 + level));
});

test("포인터를 주문 칸 다섯 개 위로 옮겨도 사다리 밖은 다시 그려지지 않는다", async ({ page, scenario }) => {
  const { probe } = await openLiveOrderWindow(page, scenario);
  for (const price of [BASE, BASE - 100, BASE - 200, BASE - 300, BASE - 400]) {
    await cellAt(page, "buy", price).hover();
    await expect(cellAt(page, "buy", price).locator(".od-preview")).toBeVisible();
  }
  await page.mouse.move(2, 2);
  await afterFrames(page);
  const counts = await probe.counts();
  test.info().annotations.push({ type: "renders", description: JSON.stringify(counts) });
  expect(counts.account).toBe(0);
  expect(counts.summary).toBe(0);
  expect(counts.quantityRow).toBe(0);
  expect(counts.totals).toBe(0);
  expect(counts.ladderRow).toBe(0);
});

test("호가 프레임 100개가 한 프레임씩 와도 줄은 값이 바뀐 때만 다시 그려진다", async ({ page, scenario }) => {
  const { probe, book, sub } = await openLiveOrderWindow(page, scenario);
  await probe.holdFrames();
  for (let frame = 0; frame < FRAMES; frame++) {
    const level = frame % LEVELS;
    const quantity = 10 + level + (Math.floor(frame / LEVELS) % 2 === 0 ? 3 : 0);
    const before = await probe.messages();
    scenario.live.emit({ type: "feed_book", sub, book: book.setAsk(level, quantity).frame() });
    await waitForMessages(page, probe, before + 1);
    await probe.stepFrame();
    await expect(askQuantity(page, level)).toHaveText(String(quantity));
  }
  await probe.releaseFrames();
  await afterFrames(page);
  const counts = await probe.counts();
  test.info().annotations.push({ type: "renders", description: JSON.stringify(counts) });
  console.log(`mw-render ${FRAMES} frames ${JSON.stringify(counts)}`);
  expect(counts.ladderRow).toBeLessThanOrEqual(2 * FRAMES);
  expect(counts.account).toBe(0);
  expect(counts.quantityRow).toBe(0);
});

test("잔량 막대와 비율 막대는 폭을 전환하지 않는다", async ({ page, scenario }) => {
  await openLiveOrderWindow(page, scenario);
  const properties = (selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).transitionProperty.split(",").map((name) => name.trim()));
  const quantityBar = await properties(".mw-qty-bar");
  expect(quantityBar).not.toContain("width");
  expect(quantityBar).not.toContain("all");
  const ratioBar = await properties(".mw-ratio i");
  expect(ratioBar).not.toContain("width");
  expect(ratioBar).not.toContain("all");
});

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const TAPE_ROWS = 500;
const DOM_ROW_LIMIT = 80;
const clockOf = (secondsBack: number): string => {
  const second = 10 * 3600 - secondsBack;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(second / 3600))}:${two(Math.floor((second % 3600) / 60))}:${two(second % 60)}`;
};
const history: TradePrint[] = Array.from({ length: TAPE_ROWS }, (_, i) => ({ time: clockOf(i), price: 71_000 + (i % 7) * 100, quantity: 10 + i, exchange: "krx" }));

async function openTradesWindow(page: Page, scenario: Scenario): Promise<string> {
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/trades`, (request) => ({ body: { symbol: CODE, venue: new URL(request.url()).searchParams.get("venue") ?? "combined", trades: history, skippedRows: 0 } }));
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [{ id: "cell-0", link: "a", kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS }, ...layout.windows.filter((w) => w.kind !== "chart")];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^체결/ }).click();
  await expect(page.getByTestId("trades-window")).toBeVisible();
  await page.mouse.move(2, 2);
  await pollSaved(() => feedSub(scenario, "trades")).toBeDefined();
  return feedSub(scenario, "trades")!;
}

test("체결 500건이 쌓여도 DOM 줄은 80개 이하이고 줄 높이는 24px이며 스크롤하면 뒤 줄이 나온다", async ({ page, scenario }) => {
  await openTradesWindow(page, scenario);
  const rows = page.getByTestId("trade-row");
  await expect(rows.first()).toContainText(clockOf(0));
  expect(await rows.count()).toBeLessThanOrEqual(DOM_ROW_LIMIT);
  const heights = await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(new Set(heights)).toEqual(new Set([24]));
  await page.getByTestId("trade-tape").evaluate((tape) => { tape.scrollTop = tape.scrollHeight; });
  await expect(rows.last()).toContainText(clockOf(TAPE_ROWS - 1));
  expect(await rows.count()).toBeLessThanOrEqual(DOM_ROW_LIMIT);
  await expect(page.getByText(clockOf(0))).toHaveCount(0);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`움직임 설정이 ${reducedMotion}여도 잔량 증감 글자는 다음 프레임 없이 사라진다`, async ({ page, scenario }) => {
    await page.emulateMedia({ reducedMotion });
    const { book, sub } = await openLiveOrderWindow(page, scenario);
    scenario.live.emit({ type: "feed_book", sub, book: book.setAsk(3, 40).frame() });
    await expect(askQuantity(page, 3)).toHaveText("40");
    const change = page.locator(".mw-qty-change").first();
    await expect(change).toBeVisible();
    await expect.poll(() => change.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  });
}
