import type { Page } from "@playwright/test";
import { type Scenario, cell, expect, pollSaved, test } from "./harness";
import { RenderProbe } from "./render-probe";
import { BASE, CODE, infoLabels, infoTab, openOrderWindow, ordersOn, tradingApi, win, writesTo } from "./order-window";

const info = (page: Page, label: string) => page.getByTestId("ladder-info").filter({ has: page.locator(":scope > span", { hasText: new RegExp(`^${label}$`) }) });
const value = (page: Page, label: string) => info(page, label).locator(":scope > b");

async function emitTrade(scenario: Scenario, seq: number, sameTimeRatio?: number): Promise<void> {
  const requests = () => scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "trades" && m.symbol === CODE);
  await pollSaved(() => requests().length).toBeGreaterThan(0);
  for (const request of requests()) {
    if (request.type !== "subscribe_feed") continue;
    scenario.live.emit({ type: "feed_trades", sub: request.sub, seq, trades: [{ t: scenario.now / 1000 + seq, price: BASE, qty: 3, venue: "krx", strength: 101.5, ...(sameTimeRatio === undefined ? {} : { sameTimeRatio }) }] });
  }
}

test("정보란 칸을 누르면 그 칸만 바뀌고 쪽과 종목을 오가도 유지되며 다시 누르면 처음 값이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, true);
  await cell(page, 1).click();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expect(value(page, "시가")).toHaveText("69,900");
  await info(page, "시가").click();
  await expect(value(page, "시가 등락")).toHaveText("−0.14%");
  await expect(infoLabels(page)).toHaveText(["시가 등락", "고가", "저가", "기준가", "전일대비", "거래량", "거래대금"]);
  await infoTab(page, "종목").click();
  await infoTab(page, "시세").click();
  await expect(value(page, "시가 등락")).toHaveText("−0.14%");
  await cell(page, 2).click();
  await expect(win(page)).toHaveAttribute("data-symbol", "000660");
  await cell(page, 1).click();
  await expect(win(page)).toHaveAttribute("data-symbol", CODE);
  await expect(value(page, "시가 등락")).toHaveText("−0.14%");
  await info(page, "시가 등락").click();
  await expect(value(page, "시가")).toHaveText("69,900");
  await expect(info(page, "시가 등락")).toHaveCount(0);
});

test("거래량 칸을 누르면 체결의 동시간비를 보이고 체결에 값이 없어도 마지막 값을 유지한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await info(page, "거래량").click();
  await expect(value(page, "동시간비")).toHaveText("-");
  await emitTrade(scenario, 1, 93.95);
  await expect(value(page, "동시간비")).toHaveText("93.95%");
  await emitTrade(scenario, 2);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(2);
  await expect(value(page, "동시간비")).toHaveText("93.95%");
});

test("정보란 칸은 Enter와 Space로 바뀌고 더블클릭해도 주문이 나가지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await info(page, "시가").focus();
  await page.keyboard.press("Enter");
  await expect(value(page, "시가 등락")).toHaveText("−0.14%");
  await expect(info(page, "시가 등락")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(value(page, "시가")).toHaveText("69,900");
  await info(page, "거래량").dblclick();
  await expect(value(page, "거래량")).toHaveText("123만");
  expect(writesTo(api, "place")).toHaveLength(0);
});

test("바꾸지 않은 정보란은 동시간비만 바뀐 체결로 다시 그려지지 않고 거래량 칸을 바꾸면 그 값으로 다시 그려진다", async ({ page, scenario }) => {
  const probe = await RenderProbe.install(page);
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await emitTrade(scenario, 1, 90);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(1);
  await probe.watch({ card: "[data-testid=ladder-info-card]" });
  await probe.reset();
  await emitTrade(scenario, 2, 91);
  await emitTrade(scenario, 3, 92);
  await expect(page.getByTestId("ladder-trade")).toHaveCount(3);
  expect((await probe.counts()).card ?? 0).toBe(0);
  await info(page, "거래량").click();
  await expect(value(page, "동시간비")).toHaveText("92.00%");
  await probe.reset();
  await emitTrade(scenario, 4, 93);
  await expect(value(page, "동시간비")).toHaveText("93.00%");
  expect((await probe.counts()).card).toBeGreaterThanOrEqual(1);
});
