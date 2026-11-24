import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { ViState } from "../src/api/generated/ViState";
import { daySummaryOf } from "./fixtures/scenario";
import { type Scenario, expect, pollSaved, test, windowTabs } from "./harness";
import { BASE, CODE, openOrderWindow, ordersOn, requestedVenues, tradingApi, win } from "./order-window";

const SUMMARY_PATH = `/api/symbols/${CODE}/day-summary`;
const KRX_OPEN = 70_000;
const RELEASE_OPEN = 75_000;
const ABOVE = BASE + 100;
const TRIGGER_AFTER = 30;
const VI_SECONDS = 134;

const book = (page: Page) => page.getByTestId("book-window");
const withBook = (windows: LayoutWindow[]): LayoutWindow[] => [...windows, { id: "book", link: null, kind: "book" }];
const info = (area: Locator, label: string) => area.locator(`[data-testid="ladder-info"][data-label="${label}"]`);
const valueOf = (area: Locator, label: string) => info(area, label).locator("b");
const areas = (page: Page) => [book(page), win(page)];
const nowOf = (scenario: Scenario) => Math.floor(scenario.now / 1000);

const firing = (scenario: Scenario, patch: Partial<ViState> = {}): ViState => ({ symbol: CODE, active: true, direction: "up", triggerPrice: 77_100, base: KRX_OPEN, triggeredAt: nowOf(scenario) - TRIGGER_AFTER, releasedAt: null, ...patch });
const released = (scenario: Scenario): ViState => firing(scenario, { active: false, base: null, triggeredAt: nowOf(scenario) - 600, releasedAt: nowOf(scenario) - 600 + VI_SECONDS });

function serveSummary(scenario: Scenario) {
  scenario.on((url) => url.pathname === SUMMARY_PATH, (request) => {
    const venue = new URL(request.url()).searchParams.get("venue") === "krx" ? "krx" : "combined";
    const quote = scenario.market.quote(CODE, venue)!;
    const summary = daySummaryOf({ ...quote, price: BASE, change: 0 });
    return { body: venue === "krx" ? { ...summary, open: KRX_OPEN } : summary };
  });
}

async function openBoth(page: Page, scenario: Scenario) {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario, false, "krx", { upper: 91_000, lower: 49_000 }, false, undefined, withBook);
  serveSummary(scenario);
  await windowTabs(page).getByRole("tab", { name: /^10호가/ }).click();
  for (const area of areas(page)) await expect(info(area, "시가")).toBeVisible();
}

async function showStockPage(page: Page) {
  for (const area of areas(page)) {
    await area.getByRole("tab", { name: "종목" }).click();
    await expect(info(area, "상한가")).toBeVisible();
  }
}

function bookSubs(scenario: Scenario): string[] {
  return scenario.live.messages.flatMap((m) => (m.type === "subscribe_feed" && m.kind === "book" && m.symbol === CODE ? [m.sub] : []));
}

async function emitBook(scenario: Scenario) {
  await pollSaved(() => bookSubs(scenario).length).toBeGreaterThanOrEqual(2);
  for (const sub of bookSubs(scenario)) scenario.live.emit({ type: "feed_book", sub, book: { t: nowOf(scenario), asks: [{ price: ABOVE, qty: 50 }, { price: ABOVE + 100, qty: 40 }], bids: [{ price: BASE, qty: 80 }, { price: BASE - 100, qty: 60 }], totalAskQty: 90, totalBidQty: 140, expected: { price: ABOVE, qty: 300 } } });
}

const krxSummaries = (scenario: Scenario) => requestedVenues(scenario, SUMMARY_PATH).filter((venue) => venue === "krx");

test.beforeEach(async ({ page, scenario }) => {
  await page.clock.setFixedTime(new Date(scenario.now));
});

test.describe("정규장", () => {
  test.use({ clockStart: "20261109100000" });

  test("VI 중에는 10호가와 호가주문 1쪽에 예상체결 두 칸과 사다리 강조가 보이고 해제되면 사라진다", async ({ page, scenario }) => {
    await openBoth(page, scenario);
    await emitBook(scenario);
    for (const area of areas(page)) {
      await expect(area.locator(".mw-qty-value")).toHaveCount(4);
      await expect(info(area, "예상체결가")).toHaveCount(0);
      await expect(area.locator(".mw-lr[data-expected]")).toHaveCount(0);
    }

    scenario.live.emit({ type: "vi_update", state: firing(scenario) });
    for (const area of areas(page)) {
      await expect(valueOf(area, "예상체결가")).toHaveText("70,100");
      await expect(valueOf(area, "예상체결량")).toHaveText("300");
      await expect(area.locator(".mw-lr[data-expected] .mw-px-num")).toHaveText("70,100");
    }

    scenario.live.emit({ type: "vi_update", state: released(scenario) });
    for (const area of areas(page)) {
      await expect(info(area, "예상체결가")).toHaveCount(0);
      await expect(area.locator(".mw-lr[data-expected]")).toHaveCount(0);
    }
  });

  test("2쪽 상승VI·하락VI는 KRX 시가로 계산하고 KRX 요약은 한 번만 부른다", async ({ page, scenario }) => {
    await openBoth(page, scenario);
    expect(krxSummaries(scenario)).toEqual([]);
    await showStockPage(page);
    for (const area of areas(page)) {
      await expect(valueOf(area, "상승VI")).toHaveText("77,000");
      await expect(valueOf(area, "하락VI")).toHaveText("63,000");
    }
    const combined = () => requestedVenues(scenario, SUMMARY_PATH).filter((venue) => venue !== "krx").length;
    const before = combined();
    await pollSaved(combined).toBeGreaterThan(before);
    expect(krxSummaries(scenario)).toHaveLength(1);
  });

  test("발동 중이면 그 방향 칸이 발동가와 경고색이고 방향을 모르면 이름과 색을 그대로 둔다", async ({ page, scenario }) => {
    await openBoth(page, scenario);
    await showStockPage(page);
    scenario.live.emit({ type: "vi_update", state: firing(scenario) });
    for (const area of areas(page)) {
      await expect(valueOf(area, "상승VI 발동")).toHaveText("77,100");
      await expect(info(area, "상승VI 발동")).toHaveAttribute("data-warn", "");
      await expect(info(area, "상승VI")).toHaveCount(0);
      await expect(valueOf(area, "하락VI")).toHaveText("63,000");
    }

    scenario.live.emit({ type: "vi_update", state: firing(scenario, { direction: null, triggerPrice: null }) });
    for (const area of areas(page)) {
      await expect(valueOf(area, "상승VI")).toHaveText("77,000");
      await expect(info(area, "상승VI")).not.toHaveAttribute("data-warn", "");
      await expect(info(area, "상승VI 발동")).toHaveCount(0);
      await expect(valueOf(area, "하락VI")).toHaveText("63,000");
    }
  });

  test("해제 뒤 기준가가 없으면 해제 시각이 든 KRX 1분봉 시가로 계산한다", async ({ page, scenario }) => {
    await openBoth(page, scenario);
    const releasedAt = released(scenario).releasedAt!;
    const minute = releasedAt - (releasedAt % 60);
    const bar = (t: number, o: number) => ({ t, o, h: o, l: o, c: o, v: 1 });
    const asked: string[] = [];
    scenario.on((url) => url.pathname === "/api/bars" && url.searchParams.get("period") === "1m" && url.searchParams.get("venue") === "krx", (request) => {
      asked.push(request.url());
      return { body: { symbol: CODE, venue: "krx", period: "1m", bars: [bar(minute - 60, 70_000), bar(minute, RELEASE_OPEN), bar(minute + 60, 76_000)], current: null, nextBefore: null, seq: null } };
    });
    scenario.live.emit({ type: "vi_update", state: released(scenario) });
    await showStockPage(page);
    for (const area of areas(page)) {
      await expect(valueOf(area, "상승VI")).toHaveText("82,500");
      await expect(valueOf(area, "하락VI")).toHaveText("67,500");
    }
    expect(asked).toHaveLength(1);
    expect(krxSummaries(scenario)).toEqual([]);
  });
});

test.describe("정규장 밖", () => {
  test.use({ clockStart: "20261109152500" });

  test("정규장 밖에서는 상승VI·하락VI가 대시이고 KRX 값을 부르지 않는다", async ({ page, scenario }) => {
    await openBoth(page, scenario);
    await showStockPage(page);
    for (const area of areas(page)) {
      await expect(valueOf(area, "상승VI")).toHaveText("-");
      await expect(valueOf(area, "하락VI")).toHaveText("-");
    }
    expect(krxSummaries(scenario)).toEqual([]);
  });
});
