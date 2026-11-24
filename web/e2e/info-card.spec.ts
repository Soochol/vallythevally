import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { expect, test, windowTabs } from "./harness";
import { openOrderWindow, ordersOn, tradingApi, win } from "./order-window";

const book = (page: Page) => page.getByTestId("book-window");
const withBook = (windows: LayoutWindow[]): LayoutWindow[] => [...windows, { id: "book", link: null, kind: "book" }];
const labels = (area: Locator) => area.getByTestId("ladder-info").locator(":scope > span:first-child");
const line = (area: Locator, label: string) => area.getByTestId("ladder-info").and(area.page().locator(`[data-label="${label}"]`));
const PRICES = ["시가", "고가", "저가", "기준가", "거래량", "거래대금"];
const RATES = ["시가 등락", "고가 등락", "저가 등락", "기준가", "거래량", "거래대금"];

test("시가·고가·저가 중 하나를 누르면 셋이 함께 등락률로 바뀌고 다시 누르면 셋이 함께 돌아온다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  const area = win(page);
  await expect(labels(area)).toHaveText(PRICES);
  await line(area, "고가").click();
  await expect(labels(area)).toHaveText(RATES);
  await expect(line(area, "시가 등락").locator("b")).toHaveText("−0.14%");
  await line(area, "저가 등락").click();
  await expect(labels(area)).toHaveText(PRICES);
  await line(area, "시가").click();
  await expect(labels(area)).toHaveText(RATES);
});

test("정보란 맨 아래 점 줄은 점이 아닌 곳을 눌러도 쪽이 바뀐다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", { upper: 91_000, lower: 49_000 }, false, undefined, withBook);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  for (const area of [book(page), win(page)]) {
    const dots = area.getByRole("tablist", { name: "상세 정보" });
    await expect(labels(area)).toHaveText(PRICES);
    for (const x of [3, 3]) {
      const before = (await labels(area).allTextContents()).join();
      await dots.click({ position: { x, y: 10 } });
      await expect.poll(async () => (await labels(area).allTextContents()).join()).not.toBe(before);
    }
    await expect(labels(area)).toHaveText(PRICES);
    const box = (await dots.boundingBox())!;
    await dots.click({ position: { x: box.width - 3, y: 10 } });
    await expect(labels(area)).toHaveText(["상한가", "하한가", "상승VI", "하락VI", "시가총액"]);
  }
});

test("정보란은 매도 10호가 열 행을 모두 덮고 점 줄이 매도 1호가 옆에 온다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", { upper: 91_000, lower: 49_000 }, false, undefined, withBook);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  for (const area of [book(page), win(page)]) {
    const rows = area.getByTestId("price-ladder").locator(".mw-lr");
    const first = (await rows.nth(0).boundingBox())!;
    const tenth = (await rows.nth(9).boundingBox())!;
    const card = (await area.getByTestId("ladder-info-card").boundingBox())!;
    const dots = (await area.getByRole("tablist", { name: "상세 정보" }).boundingBox())!;
    expect(card.y).toBeCloseTo(first.y, 0);
    expect(card.y + card.height).toBeCloseTo(tenth.y + tenth.height, 0);
    expect(dots.y).toBeGreaterThanOrEqual(tenth.y - 1);
  }
});
