import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pollSaved, test, windowTabs } from "./harness";
import { BASE, CODE, FUNDAMENTAL_FIGURES, openOrderWindow, ordersOn, pinQuote, SETTINGS, snapshot, tradingApi } from "./order-window";

const ABOVE = BASE + 100;

test.use({ clockStart: "20261118085500" });

test.beforeEach(async ({ page, scenario }) => {
  await page.clock.setFixedTime(new Date(scenario.now));
});

async function emitExpected(scenario: Scenario, price: number): Promise<void> {
  let sub = "";
  await pollSaved(() => {
    const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
    sub = message?.type === "subscribe_feed" ? message.sub : "";
    return sub;
  }).not.toBe("");
  scenario.live.emit({ type: "feed_book", sub, book: { t: scenario.now / 1000, asks: [{ price: ABOVE, qty: 50 }, { price: ABOVE + 100, qty: 40 }], bids: [{ price: BASE, qty: 80 }, { price: BASE - 100, qty: 60 }], totalAskQty: 90, totalBidQty: 140, expected: { price, qty: 300 } } });
}

async function openBook(page: Page, scenario: Scenario): Promise<void> {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
    { id: "book", link: null, kind: "book" },
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  pinQuote(scenario, CODE, BASE);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: 91_000, lowerLimit: 49_000, ...FUNDAMENTAL_FIGURES } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: snapshot(BASE) });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, { body: { symbol: CODE, venue: "combined", trades: [], skippedRows: 0 } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
}

const expectedRow = (root: Locator): Locator => root.locator(".mw-lr[data-expected]");
const outlineStyle = (locator: Locator): Promise<string> => locator.evaluate((element) => getComputedStyle(element).outlineStyle);

async function expectOnlyPriceOutlined(root: Locator, price: string): Promise<Locator> {
  const row = expectedRow(root);
  await expect(row).toHaveCount(1);
  await expect(row.locator(".mw-px-num")).toHaveText(price);
  const px = row.locator(".mw-px");
  expect(await outlineStyle(row)).toBe("none");
  const outline = await px.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("i");
    probe.style.color = "var(--warning)";
    element.append(probe);
    const warning = getComputedStyle(probe).color;
    probe.remove();
    return { style: style.outlineStyle, width: style.outlineWidth, isWarning: style.outlineColor === warning };
  });
  expect(outline).toEqual({ style: "dashed", width: "1px", isWarning: true });
  const styles = await root.locator(".mw-lr:not([data-expected]) .mw-px").evaluateAll((cells) => cells.map((element) => getComputedStyle(element).outlineStyle));
  expect(new Set(styles)).toEqual(new Set(["none"]));
  return px;
}

test("호가주문창의 예상체결 외곽선은 가격과 등락률 칸에만 점선으로 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await emitExpected(scenario, ABOVE);
  const ladder = page.getByTestId("order-window").getByTestId("price-ladder");
  const px = await expectOnlyPriceOutlined(ladder, "70,100");
  await expect(px.locator("small")).toHaveText("+0.14%");
});

test("현재가와 예상체결가가 같으면 가격 칸에 두 테두리가 함께 있다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await emitExpected(scenario, BASE);
  const ladder = page.getByTestId("order-window").getByTestId("price-ladder");
  const px = await expectOnlyPriceOutlined(ladder, "70,000");
  await expect(expectedRow(ladder)).toHaveAttribute("data-current", "");
  const borders = await px.evaluate((element) => ({ shadow: getComputedStyle(element).boxShadow, offset: Number.parseFloat(getComputedStyle(element).outlineOffset) }));
  expect(borders.shadow).toContain("inset");
  expect(borders.offset).toBeGreaterThanOrEqual(0);
});

test("10호가 창의 예상체결 외곽선도 가격 칸에만 있다", async ({ page, scenario }) => {
  await openBook(page, scenario);
  await emitExpected(scenario, ABOVE);
  await expectOnlyPriceOutlined(page.getByTestId("book-window").getByTestId("price-ladder"), "70,100");
});
