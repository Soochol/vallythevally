import type { FeedBook } from "../src/api/generated/FeedBook";
import { type Scenario, cell, expect, pollSaved, test } from "./harness";
import { useCenterIndicatorWindow } from "./indicator-window";
import { BASE, CODE, openOrderWindow, ordersOn, snapshot, tradingApi, win } from "./order-window";

const nowOf = (scenario: Scenario) => Math.floor(scenario.now / 1000);

function feedSub(scenario: Scenario, kind: "book" | "trades"): string {
  const message = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === kind && m.symbol === CODE);
  return message?.type === "subscribe_feed" ? message.sub : "";
}

function feedSubs(scenario: Scenario, kind: "book" | "trades"): string[] {
  return scenario.live.messages
    .filter((m) => m.type === "subscribe_feed" && m.kind === kind && m.symbol === CODE)
    .map((m) => (m.type === "subscribe_feed" ? m.sub : ""))
    .filter((sub) => sub !== "");
}

function makeBook(t: number, ask0Qty: number, bid0Qty: number): FeedBook {
  const base = snapshot(BASE);
  return {
    t,
    asks: base.asks.map((level, index) => ({ price: level.price, qty: index === 0 ? ask0Qty : level.quantity })),
    bids: base.bids.map((level, index) => ({ price: level.price, qty: index === 0 ? bid0Qty : level.quantity })),
    totalAskQty: base.totalAskQuantity - base.asks[0]!.quantity + ask0Qty,
    totalBidQty: base.totalBidQuantity - base.bids[0]!.quantity + bid0Qty,
    expected: null,
  };
}

test.describe("허수 취소·아이스버그·OFI 미시 신호", () => {
  test.use({ clockStart: "20261109100000" });

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test("체결 없는 0D 잔량 급감 시 호가 사다리에 허수 취소 큐가 뜨고 설정으로 숨길 수 있다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario);

    await pollSaved(() => feedSub(scenario, "book")).not.toBe("");
    const bookSub = feedSub(scenario, "book");
    const now = nowOf(scenario);
    const ask0Price = BASE + 100;

    scenario.live.emit({ type: "feed_book", sub: bookSub, book: makeBook(now, 5_000, 2_000) });
    scenario.live.emit({ type: "feed_book", sub: bookSub, book: makeBook(now + 1, 100, 2_000) });

    const cue = win(page).getByTestId("order-micro-cue");
    await expect(cue).toHaveCount(1);
    await expect(cue).toHaveAttribute("data-kind", "spoof_cancel");
    await expect(cue).toHaveAttribute("data-price", String(ask0Price));
    await expect(cue).toHaveAttribute("title", /취소율 100%/);

    await win(page).getByTestId("order-settings-button").click();
    const popover = page.getByTestId("order-settings");
    await expect(popover).toBeVisible();
    await popover.getByLabel("허수·아이스버그 표시").uncheck();
    await expect(win(page).getByTestId("order-micro-cue")).toHaveCount(0);
  });

  test("동일 수량 0B 체결이 동반된 0D 감소에서는 허수 취소 큐가 뜨지 않는다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario);

    await pollSaved(() => feedSub(scenario, "book")).not.toBe("");
    await pollSaved(() => feedSub(scenario, "trades")).not.toBe("");
    const bookSub = feedSub(scenario, "book");
    const tradeSub = feedSub(scenario, "trades");
    const now = nowOf(scenario);
    const ask0Price = BASE + 100;

    scenario.live.emit({ type: "feed_book", sub: bookSub, book: makeBook(now, 5_000, 2_000) });
    scenario.live.emit({
      type: "feed_trades",
      sub: tradeSub,
      seq: 1,
      trades: [{ t: now + 1, price: ask0Price, qty: 4_900, venue: "krx", strength: 120 }],
    });
    scenario.live.emit({ type: "feed_book", sub: bookSub, book: makeBook(now + 2, 100, 2_000) });

    await expect(win(page).getByTestId("order-ofi-bar")).toHaveAttribute("data-ofi-qty", "4900");
    await expect(win(page).getByTestId("order-micro-cue")).toHaveCount(0);
  });

  test("호가주문창 OFI 매수압력 막대가 실시간 0D 변화에 따라 갱신된다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario);

    await pollSaved(() => feedSub(scenario, "book")).not.toBe("");
    const bookSub = feedSub(scenario, "book");
    const now = nowOf(scenario);
    const ofiBar = win(page).getByTestId("order-ofi-bar");

    await expect(ofiBar).toBeVisible();
    await expect(ofiBar).toHaveAttribute("data-buy-pct", "50");

    scenario.live.emit({ type: "feed_book", sub: bookSub, book: makeBook(now, 2_000, 2_000) });
    scenario.live.emit({ type: "feed_book", sub: bookSub, book: makeBook(now + 1, 2_000, 3_500) });
    await expect(ofiBar).toHaveAttribute("data-buy-pct", "100");
    await expect(ofiBar).toHaveAttribute("data-ofi-qty", "1500");

    scenario.live.emit({ type: "feed_book", sub: bookSub, book: makeBook(now + 2, 2_000, 1_500) });
    await expect(ofiBar).toHaveAttribute("data-ofi-qty", "-500");
  });

  test("차트 호가 잔량 히트맵 설정에 허수·아이스버그 토글과 미시 표기 방식이 보인다", async ({ page, scenario }) => {
    useCenterIndicatorWindow(scenario);
    scenario.reply(
      (url) => /^\/api\/symbols\/[^/]+\/quote-depth$/.test(url.pathname),
      { body: { available: true, venue: "combined", source: "priceMax", days: [{ date: "2026-11-09", state: "closed" }], points: [] } },
    );
    await page.goto("/?symbol=005930&period=5m");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");

    await page.getByRole("button", { name: /^지표/ }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "지표 추가", exact: true }).click();
    await dialog.getByRole("option", { name: "호가 잔량 히트맵 추가 후보", exact: true }).click();
    await dialog.getByRole("button", { name: "입력창 닫기", exact: true }).click();

    const heatRow = page.locator("[data-indicator-row]").filter({ hasText: "호가 잔량 히트맵" });
    await expect(heatRow).toHaveCount(1);
    await heatRow.getByRole("button", { name: "호가 잔량 히트맵 설정 열기", exact: true }).click();

    const spoofSwitch = dialog.getByRole("switch", { name: "허수 취소 표시", exact: true });
    const icebergSwitch = dialog.getByRole("switch", { name: "아이스버그 흡수 표시", exact: true });
    const modeGroup = dialog.getByRole("group", { name: "미시 표기 방식", exact: true });

    await expect(spoofSwitch).toHaveAttribute("aria-checked", "false");
    await expect(icebergSwitch).toHaveAttribute("aria-checked", "false");
    await expect(modeGroup.getByRole("button", { name: "점 표기", exact: true })).toHaveAttribute("aria-pressed", "true");

    await spoofSwitch.click();
    await icebergSwitch.click();
    await modeGroup.getByRole("button", { name: "배지 표기", exact: true }).click();

    await expect(spoofSwitch).toHaveAttribute("aria-checked", "true");
    await expect(icebergSwitch).toHaveAttribute("aria-checked", "true");
    await expect(modeGroup.getByRole("button", { name: "배지 표기", exact: true })).toHaveAttribute("aria-pressed", "true");

    await dialog.getByRole("button", { name: "설정 닫기", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("체결창이 함께 열려도 호가주문창 fallback 미시 감지가 체결을 이중 집계하지 않는다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(
      page,
      scenario,
      false,
      "krx",
      { upper: 91_000, lower: 49_000 },
      false,
      snapshot(BASE),
      (windows) => [
        ...windows.filter((w) => w.kind === "chart" || w.kind === "order"),
        { id: "trades-co", link: null, kind: "trades", symbol: CODE },
      ],
    );

    await pollSaved(() => feedSubs(scenario, "book").length).toBeGreaterThanOrEqual(1);
    await pollSaved(() => feedSubs(scenario, "trades").length).toBeGreaterThanOrEqual(2);
    const bookSub = feedSubs(scenario, "book")[0]!;
    const tradeSubs = feedSubs(scenario, "trades");
    const now = nowOf(scenario);
    const ask0Price = BASE + 100;

    scenario.live.emit({ type: "feed_book", sub: bookSub, book: makeBook(now, 1_000, 2_000) });
    for (const sub of tradeSubs) {
      scenario.live.emit({
        type: "feed_trades",
        sub,
        seq: 1,
        trades: [{ t: now + 1, price: ask0Price, qty: 800, venue: "krx", strength: 120 }],
      });
    }
    scenario.live.emit({ type: "feed_book", sub: bookSub, book: makeBook(now + 2, 600, 2_000) });

    await expect(win(page).getByTestId("order-ofi-bar")).toHaveAttribute("data-ofi-qty", "400");
    await expect(win(page).getByTestId("order-micro-cue")).toHaveCount(0);
  });

  test("호가창이 함께 열려도 호가주문창 fallback 미시 감지가 호가를 중복 처리하지 않는다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(
      page,
      scenario,
      false,
      "krx",
      { upper: 91_000, lower: 49_000 },
      false,
      snapshot(BASE),
      (windows) => [
        ...windows.filter((w) => w.kind === "chart" || w.kind === "order"),
        { id: "book-co", link: null, kind: "book", symbol: CODE },
      ],
    );

    await pollSaved(() => feedSubs(scenario, "book").length).toBeGreaterThanOrEqual(2);
    const bookSubs = feedSubs(scenario, "book");
    const now = nowOf(scenario);

    for (const sub of bookSubs) {
      scenario.live.emit({ type: "feed_book", sub, book: makeBook(now, 5_000, 2_000) });
    }
    for (const sub of bookSubs) {
      scenario.live.emit({ type: "feed_book", sub, book: makeBook(now + 1, 100, 2_000) });
    }

    await expect(win(page).getByTestId("order-ofi-bar")).toHaveAttribute("data-ofi-qty", "4900");
    await expect(win(page).getByTestId("order-micro-cue")).toHaveCount(1);
  });
});
