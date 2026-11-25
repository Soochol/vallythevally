import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test, windowTabs } from "./harness";
import { BASE, CODE, FUNDAMENTAL_FIGURES, openOrderWindow, ordersOn, pinQuote, SETTINGS, snapshot, tradingApi, win } from "./order-window";

const RATE_WIDTH = 48;
const LIMITS = { upper: 91_000, lower: 49_000 };
const book = (page: Page) => page.getByTestId("book-window");
const rows = (area: Locator) => area.getByTestId("price-ladder").locator(".mw-lr");
const rates = (area: Locator) => rows(area).locator(".mw-px small");
const frame = (page: Page, id: string) => page.locator(`[data-canvas-window="${id}"]`);
const width = async (locator: Locator) => (await locator.boundingBox())!.width;
const left = async (locator: Locator) => (await locator.boundingBox())!.x;
const withBook = (windows: LayoutWindow[]): LayoutWindow[] => [...windows, { id: "book", link: null, kind: "book" }];

async function start(page: Page, scenario: Scenario): Promise<void> {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", LIMITS, false, undefined, withBook);
}

async function canvasWith(page: Page, scenario: Scenario, rects: Record<string, { x: number; y: number; w: number; h: number }>, afterPin?: () => void): Promise<void> {
  ordersOn(scenario);
  tradingApi(scenario);
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "order", link: null, kind: "order", venue: "krx" },
    { id: "book", link: null, kind: "book" },
  ];
  const canvas = { rects: { "cell-0": { x: 0, y: 0, w: 0.2, h: 0.3 }, ...rects }, order: ["cell-0", "book", "order"] };
  scenario.documents.saveLayout({ ...layout, windows, placement: { v: 1, dock: null, canvas }, revision: layout.revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "canvas" });
  pinQuote(scenario, CODE, BASE);
  afterPin?.();
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: LIMITS.upper, lowerLimit: LIMITS.lower, ...FUNDAMENTAL_FIGURES } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: snapshot(BASE) });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, { body: { symbol: CODE, venue: "combined", trades: [], skippedRows: 0 } });
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(rows(win(page))).toHaveCount(20);
  await expect(rows(book(page))).toHaveCount(20);
}

async function dockSideBySide(page: Page, scenario: Scenario): Promise<void> {
  await start(page, scenario);
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows = layout.windows.filter((w) => w.kind === "chart" || w.kind === "order");
  const dock = { root: { kind: "split", dir: "row", ratio: 0.6, first: { kind: "group", id: "g1", tabs: ["cell-0"], active: "cell-0" }, second: { kind: "group", id: "g2", tabs: ["order"], active: "order" } }, floats: [] };
  scenario.documents.saveLayout({ ...layout, windows, placement: { v: 1, dock, canvas: null }, revision: layout.revision + 1 });
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(rows(win(page))).toHaveCount(20);
}

async function setRate(page: Page, on: boolean): Promise<void> {
  await page.getByTestId("order-settings-button").click();
  await page.getByRole("checkbox", { name: "등락률 표시" }).setChecked(on);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("order-settings")).toHaveCount(0);
}

const rowColors = (area: Locator) => rows(area).evaluateAll((lines) => lines.flatMap((line) => {
  const price = line.querySelector(".mw-px-num");
  const rate = line.querySelector(".mw-px small");
  if (price === null || rate === null) return [];
  return [{ price: getComputedStyle(price).color, rate: getComputedStyle(rate).color }];
}));

test("사다리의 등락률 글자색은 같은 행의 호가 가격 글자색과 같다", async ({ page, scenario }) => {
  await start(page, scenario);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  for (const area of [book(page), win(page)]) {
    await expect(rows(area)).toHaveCount(20);
    const colors = await rowColors(area);
    expect(colors).toHaveLength(20);
    expect(new Set(colors.map(({ price }) => price)).size).toBe(3);
    for (const { price, rate } of colors) expect(rate).toBe(price);
  }
});

test("자유 배치에서 등락률을 끄면 10호가와 호가주문 창이 48px 좁아지고 켜면 되돌아온다", async ({ page, scenario }) => {
  await canvasWith(page, scenario, { book: { x: 0.22, y: 0.01, w: 0.25, h: 0.6 }, order: { x: 0.5, y: 0.01, w: 0.35, h: 0.7 } });
  const targets = [frame(page, "book"), frame(page, "order")];
  const quantities = [book(page), win(page)].map((area) => rows(area).first().locator(".mw-qty").first());
  const before = await Promise.all(targets.map(width));
  const lefts = await Promise.all(targets.map(left));
  const quantityWidths = await Promise.all(quantities.map(width));
  await expect(rates(book(page))).toHaveCount(20);
  await setRate(page, false);
  for (const area of [book(page), win(page)]) await expect(rates(area)).toHaveCount(0);
  await expect.poll(() => Promise.all(targets.map(width))).toEqual(before.map((w) => expect.closeTo(w - RATE_WIDTH, 0)));
  expect(await Promise.all(targets.map(left))).toEqual(lefts.map((x) => expect.closeTo(x, 0)));
  expect(await Promise.all(quantities.map(width))).toEqual(quantityWidths.map((w) => expect.closeTo(w, 0)));
  await setRate(page, true);
  await expect.poll(() => Promise.all(targets.map(width))).toEqual(before.map((w) => expect.closeTo(w, 0)));
  for (const area of [book(page), win(page)]) await expect(rates(area)).toHaveCount(20);
});

test("등락률을 끈 동안 호가주문 창 최소 폭은 372px이고 켜면 420px이다", async ({ page, scenario }) => {
  await canvasWith(page, scenario, { book: { x: 0.02, y: 0.35, w: 0.25, h: 0.6 }, order: { x: 0.5, y: 0.01, w: 0.1, h: 0.7 } });
  const order = frame(page, "order");
  await expect.poll(() => width(order)).toBeCloseTo(420, 0);
  await setRate(page, false);
  await expect.poll(() => width(order)).toBeCloseTo(372, 0);
  await setRate(page, true);
  await expect.poll(() => width(order)).toBeCloseTo(420, 0);
});

test("도킹에서 등락률을 끄면 호가주문 칸이 48px 좁아지고 옆 차트 칸이 그만큼 넓어진다", async ({ page, scenario }) => {
  await dockSideBySide(page, scenario);
  const order = win(page);
  const chart = cell(page);
  const before = { order: await width(order), chart: await width(chart) };
  await setRate(page, false);
  await expect(rates(order)).toHaveCount(0);
  await expect.poll(() => width(order)).toBeCloseTo(before.order - RATE_WIDTH, 0);
  await expect.poll(() => width(chart)).toBeCloseTo(before.chart + RATE_WIDTH, 0);
  await setRate(page, true);
  await expect.poll(() => width(order)).toBeCloseTo(before.order, 0);
  await expect.poll(() => width(chart)).toBeCloseTo(before.chart, 0);
});

test("등락률을 끈 10호가 창은 좁은 폭 경계도 48px 낮아져 정보란이 남는다", async ({ page, scenario }) => {
  await canvasWith(page, scenario, { book: { x: 0.22, y: 0.01, w: 0.262, h: 0.6 }, order: { x: 0.5, y: 0.01, w: 0.35, h: 0.7 } });
  const before = await width(book(page));
  expect(before).toBeGreaterThanOrEqual(320);
  expect(before).toBeLessThan(368);
  await expect(book(page).getByTestId("ladder-info-card")).toBeVisible();
  await setRate(page, false);
  await expect.poll(() => width(book(page))).toBeLessThan(320);
  await expect(book(page).getByTestId("ladder-info-card")).toBeVisible();
});

test("10호가와 호가주문 창 모두 거래소에 맞는 시·고·저 뱃지를 가격 왼쪽에 보이고 같은 가격이면 나란히 둔다", async ({ page, scenario }) => {
  await canvasWith(page, scenario, { book: { x: 0.22, y: 0.01, w: 0.25, h: 0.6 }, order: { x: 0.5, y: 0.01, w: 0.35, h: 0.7 } }, () => {
    scenario.on((url) => url.pathname === `/api/symbols/${CODE}/day-summary`, (request) => {
      const venue = new URL(request.url()).searchParams.get("venue") ?? "combined";
      const prices = venue === "krx"
        ? { open: 70_100, high: 70_400, low: 69_900 }
        : { open: 69_900, high: 70_300, low: 69_900 };
      return {
        body: { symbol: CODE, venue, price: BASE, previousClose: BASE, ...prices, volume: 100_000, tradeValueWon: 7_000_000_000, t: 1_700_000_000 },
      };
    });
  });
  const rowOf = (area: Locator, price: string) => rows(area).filter({ has: page.locator(".mw-px-num", { hasText: new RegExp(`^${price}$`) }) });
  for (const area of [book(page), win(page)]) {
    const highRow = rowOf(area, "70,300");
    await expect(highRow.getByTestId("ladder-day-tag-high")).toHaveText("고");
    const overlapRow = rowOf(area, "69,900");
    await expect(overlapRow.getByTestId("ladder-day-tags")).toHaveText("시저");
    const tagsBox = (await overlapRow.getByTestId("ladder-day-tags").boundingBox())!;
    const numBox = (await overlapRow.locator(".mw-px-num").boundingBox())!;
    expect(tagsBox.x + tagsBox.width).toBeLessThanOrEqual(numBox.x + 1);
  }
  await pickDesktopVenue(page, "KRX");
  for (const area of [book(page), win(page)]) {
    await expect(rowOf(area, "70,400").getByTestId("ladder-day-tag-high")).toHaveText("고");
    await expect(rowOf(area, "70,100").getByTestId("ladder-day-tag-open")).toHaveText("시");
    await expect(rowOf(area, "69,900").getByTestId("ladder-day-tag-low")).toHaveText("저");
    await expect(rowOf(area, "69,900").getByTestId("ladder-day-tag-open")).toHaveCount(0);
  }
});
