import type { FeedBook } from "../src/api/generated/FeedBook";
import type { ViPlaybook } from "../src/api/generated/ViPlaybook";
import type { ViState } from "../src/api/generated/ViState";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { BASE, CODE, cellAt, openOrderWindow, ordersOn, snapshot, status, tradingApi, win, writesTo } from "./order-window";

const VI_PRICE = 77_000;
const nowOf = (scenario: Scenario) => Math.floor(scenario.now / 1000);

const SAMPLE_PLAYBOOK: ViPlaybook = {
  symbol: CODE,
  direction: "up",
  kind: "all",
  lookbackDays: 42,
  sampleCount: 6,
  horizons: [
    { minutes: 1, samples: 6, winRatePct: 66.67, avgReturnPct: 1.45, avgMaePct: -0.62 },
    { minutes: 3, samples: 6, winRatePct: 50.0, avgReturnPct: 1.12, avgMaePct: -1.18 },
    { minutes: 5, samples: 6, winRatePct: 66.67, avgReturnPct: 2.34, avgMaePct: -1.45 },
    { minutes: 10, samples: 6, winRatePct: 83.33, avgReturnPct: 3.15, avgMaePct: -1.9 },
  ],
  recentMatches: [
    {
      date: "2026-11-23",
      triggeredAt: "09:14:00",
      releasedAt: "09:16:02",
      kind: "dynamic",
      triggerPrice: 76_800,
      releasePrice: 77_000,
      return1mPct: 1.82,
      return3mPct: 2.45,
      return5mPct: 3.1,
      return10mPct: 4.2,
      mae5mPct: -0.5,
      lateDropDetected: false,
    },
    {
      date: "2026-11-18",
      triggeredAt: "10:22:00",
      releasedAt: "10:24:00",
      kind: "static",
      triggerPrice: 74_000,
      releasePrice: 73_600,
      return1mPct: -0.95,
      return3mPct: -1.2,
      return5mPct: -1.65,
      return10mPct: -0.4,
      mae5mPct: -2.1,
      lateDropDetected: true,
    },
  ],
};

function bookSub(scenario: Scenario): string {
  const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE);
  return message?.type === "subscribe_feed" ? message.sub : "";
}

function singlePriceBook(t: number, expectedPrice: number, expectedQty: number): FeedBook {
  return {
    t,
    asks: [
      { price: VI_PRICE + 100, qty: 120 },
      { price: VI_PRICE + 200, qty: 90 },
      { price: VI_PRICE + 300, qty: 60 },
    ],
    bids: [
      { price: VI_PRICE, qty: 150 },
      { price: VI_PRICE - 100, qty: 110 },
      { price: VI_PRICE - 200, qty: 80 },
    ],
    totalAskQty: 270,
    totalBidQty: 340,
    expected: { price: expectedPrice, qty: expectedQty },
  };
}

function normalBook(t: number): FeedBook {
  const base = snapshot(BASE);
  return {
    t,
    asks: base.asks.map((level) => ({ price: level.price, qty: level.quantity })),
    bids: base.bids.map((level) => ({ price: level.price, qty: level.quantity })),
    totalAskQty: base.totalAskQuantity,
    totalBidQty: base.totalBidQuantity,
    expected: null,
  };
}

test.describe("호가주문창 VI 오버레이", () => {
  test.use({ clockStart: "20261109100000" });

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test("평시 10호가 상태에서는 VI 패널이 전혀 렌더링되지 않는다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario);
    await expect(win(page).getByTestId("order-vi-top")).toHaveCount(0);
    await expect(win(page).getByTestId("order-vi-bottom")).toHaveCount(0);
    await expect(win(page).getByTestId("price-ladder").locator(".mw-qty-value")).toHaveCount(20);
  });

  test("VI 발동 시 0H 추이·막판 급락 경고·플레이북 팝오버가 뜨고 단일가 사다리 주문 뒤 해제 시 원복된다", async ({ page, scenario }) => {
    ordersOn(scenario);
    const api = tradingApi(scenario);
    scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/vi-playbook`, { body: SAMPLE_PLAYBOOK });
    await openOrderWindow(page, scenario);

    await pollSaved(() => bookSub(scenario)).not.toBe("");
    const sub = bookSub(scenario);
    const now = nowOf(scenario);

    const firing: ViState = {
      symbol: CODE,
      market: "krx",
      active: true,
      direction: "up",
      triggerPrice: VI_PRICE,
      base: BASE,
      triggeredAt: now - 110,
      releasedAt: null,
    };
    scenario.live.emit({ type: "vi_update", state: firing });
    scenario.live.emit({ type: "feed_book", sub, book: singlePriceBook(now - 20, 78_500, 1_200) });
    await expect(win(page).getByTestId("order-vi-top")).toBeVisible();
    await expect(win(page).getByTestId("order-vi-badge")).toContainText("상승 VI");
    await expect(win(page).getByTestId("order-vi-countdown")).toHaveText("00:10");
    await expect(win(page).getByTestId("order-vi-sparkline")).toBeVisible();
    await expect(win(page).getByTestId("order-vi-trap")).toHaveCount(0);

    scenario.live.emit({ type: "feed_book", sub, book: singlePriceBook(now, 77_500, 1_100) });
    await expect(win(page).getByTestId("order-vi-trap")).toContainText("막판 15초 급락");

    await expect(win(page).getByTestId("order-vi-bottom")).toBeVisible();
    await expect(win(page).getByTestId("order-vi-card-1")).toContainText("+1분");
    await expect(win(page).getByTestId("order-vi-card-1")).toContainText("승률 67%");
    await expect(win(page).getByTestId("order-vi-card-3")).toContainText("+3분");
    await expect(win(page).getByTestId("order-vi-card-5")).toContainText("+5분");

    await win(page).getByTestId("order-vi-card-1").click();
    const popover = page.getByTestId("order-vi-popover");
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId("order-vi-pop-horizons")).toContainText("+10분");
    await expect(popover.getByTestId("order-vi-pop-matches")).toContainText("2026-11-23");
    await expect(popover.getByTestId("order-vi-pop-matches")).toContainText("막판급락");
    await popover.getByRole("button", { name: "닫기" }).click();
    await expect(popover).toHaveCount(0);

    await expect(win(page).getByTestId("price-ladder").locator(".mw-qty-value")).toHaveCount(6);
    await cellAt(page, "buy", VI_PRICE).dblclick();
    await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
    expect(writesTo(api, "place")[0]!.body).toMatchObject({ code: CODE, side: "buy", price: VI_PRICE, quantity: 10 });
    await expect(status(page)).toContainText("77,000원");

    scenario.live.emit({ type: "vi_update", state: { ...firing, active: false, base: null, releasedAt: now + 10 } });
    scenario.live.emit({ type: "feed_book", sub, book: normalBook(now + 11) });
    await expect(win(page).getByTestId("order-vi-top")).toHaveCount(0);
    await expect(win(page).getByTestId("order-vi-bottom")).toHaveCount(0);
    await expect(win(page).getByTestId("price-ladder").locator(".mw-qty-value")).toHaveCount(20);
  });

  test("일치하는 과거 VI 이력이 없으면 이력 부족 안내를 보인다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario);
    const now = nowOf(scenario);
    scenario.live.emit({
      type: "vi_update",
      state: { symbol: CODE, market: "krx", active: true, direction: "down", triggerPrice: 63_000, base: BASE, triggeredAt: now - 30, releasedAt: null },
    });
    await expect(win(page).getByTestId("order-vi-badge")).toContainText("하락 VI");
    await expect(win(page).getByTestId("order-vi-countdown")).toHaveText("01:30");
    await expect(win(page).getByTestId("order-vi-empty")).toContainText("이력 부족");
  });
});
