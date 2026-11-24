import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pollSaved, test } from "./harness";
import { BASE, CODE, FUNDAMENTAL_FIGURES, ordersOn, pinQuote, SETTINGS, snapshot, tradingApi } from "./order-window";

const frame = (page: Page, id: string) => page.locator(`[data-canvas-window="${id}"]`);
const head = (page: Page, id: string) => page.locator(`[data-window-header="${id}"]`);
const boxOf = async (locator: Locator) => (await locator.boundingBox())!;

async function openCanvas(page: Page, scenario: Scenario): Promise<void> {
  ordersOn(scenario);
  tradingApi(scenario);
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "order", link: null, kind: "order", venue: "krx" },
    { id: "book", link: null, kind: "book" },
  ];
  const canvas = { rects: { "cell-0": { x: 0, y: 0, w: 0.2, h: 0.2 }, book: { x: 0.22, y: 0.05, w: 0.21, h: 0.5 }, order: { x: 0.5, y: 0.05, w: 0.1, h: 0.6 } }, order: ["cell-0", "book", "order"] };
  scenario.documents.saveLayout({ ...layout, windows, placement: { v: 1, dock: null, canvas }, revision: layout.revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "canvas" });
  pinQuote(scenario, CODE, BASE);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: 91_000, lowerLimit: 49_000, ...FUNDAMENTAL_FIGURES } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: snapshot(BASE) });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, { body: { symbol: CODE, venue: "combined", trades: [], skippedRows: 0 } });
  await page.setViewportSize({ width: 1440, height: 1300 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("price-ladder")).toHaveCount(2);
}

async function dragBy(page: Page, from: { x: number; y: number }, by: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x / 2, from.y + by.y / 2);
  await page.mouse.move(from.x + by.x, from.y + by.y);
  await page.mouse.up();
}

test("등락률을 끈 캔버스에서 호가주문과 10호가 창을 옮겨도 줄어든 폭이 그대로다", async ({ page, scenario }) => {
  await openCanvas(page, scenario);
  const order = frame(page, "order");
  const book = frame(page, "book");
  await page.getByTestId("order-settings-button").click();
  await page.getByRole("checkbox", { name: "등락률 표시" }).uncheck();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await boxOf(order)).width).toBeCloseTo(372, 0);
  const [orderBefore, bookBefore] = [await boxOf(order), await boxOf(book)];
  expect(bookBefore.width).toBeLessThan(280);
  const expectWidths = async () => {
    expect(Math.abs((await boxOf(order)).width - orderBefore.width)).toBeLessThanOrEqual(1);
    expect(Math.abs((await boxOf(book)).width - bookBefore.width)).toBeLessThanOrEqual(1);
  };

  const grip = await boxOf(head(page, "order"));
  await dragBy(page, { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, { x: 20, y: 0 });
  await expect.poll(async () => (await boxOf(order)).x).toBeGreaterThan(orderBefore.x + 10);
  await expectWidths();

  await head(page, "book").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await boxOf(book)).x).toBeGreaterThan(bookBefore.x + 10);
  await expectWidths();

  const edge = await boxOf(order.locator('[data-resize-handle="s"]'));
  const tall = (await boxOf(order)).height;
  await dragBy(page, { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 }, { x: 0, y: 60 });
  await expect.poll(async () => (await boxOf(order)).height).toBeGreaterThan(tall + 30);
  await expectWidths();
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ rate: false });
});
