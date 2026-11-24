import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, expect, test, windowTabs } from "./harness";
import { type Api, BASE, openOrderWindow, ordersOn, snapshot, tradingApi, win, writesTo } from "./order-window";

const book = (page: Page) => page.getByTestId("book-window");
const rows = (area: Locator) => area.getByTestId("price-ladder").locator(".mw-lr");
const withBook = (windows: LayoutWindow[]): LayoutWindow[] => [...windows, { id: "book", link: null, kind: "book" }];
const CROSSED = { ...snapshot(BASE), asks: Array.from({ length: 10 }, (_, i) => ({ price: BASE + 100 * i, quantity: 10 + i })) };

async function openCrossed(page: Page, scenario: Scenario): Promise<Api> {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", { upper: 91_000, lower: 49_000 }, false, CROSSED, withBook);
  return api;
}

test("교차 호가에서 사다리는 매도 열 줄 아래 매수 열 줄이고 정보란은 매수 잔량을 가리지 않는다", async ({ page, scenario }) => {
  await openCrossed(page, scenario);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  for (const area of [book(page), win(page)]) {
    await expect(rows(area)).toHaveCount(20);
    const sides = await rows(area).evaluateAll((lines) => lines.map((line) => ({
      price: line.querySelector(".mw-px-num")?.textContent?.trim(),
      ask: line.querySelector(".mw-qty[data-side=ask] .mw-qty-value") !== null,
      bid: line.querySelector(".mw-qty[data-side=bid] .mw-qty-value") !== null,
    })));
    expect(sides.slice(0, 10).every(({ ask, bid }) => ask && !bid)).toBe(true);
    expect(sides.slice(10).every(({ ask, bid }) => bid && !ask)).toBe(true);
    expect(sides.filter(({ price }) => price === "70,000")).toHaveLength(2);
    expect([sides[9]!.price, sides[10]!.price]).toEqual(["70,000", "70,000"]);
    const tenth = (await rows(area).nth(9).boundingBox())!;
    const card = (await area.getByTestId("ladder-info-card").boundingBox())!;
    expect(card.y + card.height).toBeLessThanOrEqual(tenth.y + tenth.height + 1);
  }
});

test("교차 호가에서 매도 칸과 매수 칸을 더블클릭하면 그 줄의 가격으로 주문이 나간다", async ({ page, scenario }) => {
  const api = await openCrossed(page, scenario);
  const cell = (row: number, side: string) => rows(win(page)).nth(row).locator(`[data-order-cell][data-side="${side}"]`);
  await cell(9, "sell").dblclick();
  await expect.poll(() => writesTo(api, "place").length).toBe(1);
  await cell(10, "buy").dblclick();
  await expect.poll(() => writesTo(api, "place").length).toBe(2);
  expect(writesTo(api, "place").map(({ body }) => [body.side, body.price])).toEqual([["sell", 70_000], ["buy", 70_000]]);
});
