import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { BookReplayDay } from "../src/api/generated/BookReplayDay";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderBook } from "../src/api/generated/OrderBook";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { daySummaryOf } from "./fixtures/scenario";
import { cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, pollSaved, type Scenario, test } from "./harness";
import { FUNDAMENTAL_FIGURES, pinQuote } from "./order-window";

test.use({ clockStart: "20261123140000" });

const CODE = "005930";
const MIDNIGHT = Date.parse("2026-11-23T00:00:00+09:00") / 1000;
const at = (hour: number, minute: number) => MIDNIGHT + hour * 3600 + minute * 60;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 40 };

const BARS_5M: Bar[] = Array.from({ length: 30 }, (_, i) => ({
  t: at(8, 30 + i * 5),
  o: 71_000 + i * 50,
  h: 71_300 + i * 50,
  l: 70_900 + i * 50,
  c: 71_200 + i * 50,
  v: 1000 + i * 10,
}));

const REPLAY_DAY: BookReplayDay = {
  symbol: CODE,
  date: "20261123",
  coverage: "collected",
  previousClose: 71_000,
  covered: [[540, 560], [570, 620]],
  books: [
    {
      minute: 540,
      asks: [
        [71_200, 120],
        [71_300, 230],
        [71_400, 340],
      ],
      bids: [
        [71_100, 150],
        [71_000, 260],
        [70_900, 370],
      ],
      totalAsk: 1_200,
      totalBid: 2_400,
    },
  ],
  trades: [
    [540, 32_410, 71_100, -15],
    [540, 32_420, 71_200, 25],
  ],
};

function liveSnapshot(ask1: number): OrderBook {
  return {
    symbol: CODE,
    asks: Array.from({ length: 10 }, (_, i) => ({ price: ask1 + i * 100, quantity: 10 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: ask1 - 100 - i * 100, quantity: 20 + i })),
    totalAskQuantity: 9_000,
    totalBidQuantity: 8_000,
    afterHoursAskQuantity: null,
    afterHoursBidQuantity: null,
    bookTime: null,
    expected: null,
  };
}

function seedLayout(scenario: Scenario, extraWindows: LayoutWindow[] = []) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: CODE, venue: "combined", period: "5m", chartSettings: SETTINGS },
    { id: "book-0", link: "a", kind: "book" },
    ...extraWindows,
  ];
  const leftTabs = ["cell-0", ...extraWindows.map((w) => w.id)];
  const root = {
    kind: "split",
    dir: "row",
    ratio: 0.62,
    first: { kind: "group", id: "g1", tabs: leftTabs, active: "cell-0" },
    second: { kind: "group", id: "g2", tabs: ["book-0"], active: "book-0" },
  };
  scenario.documents.saveLayout({
    ...layout,
    windows,
    placement: { v: 1, dock: { root, floats: [] }, canvas: null },
    revision: layout.revision + 1,
  });
}

function seedMarket(scenario: Scenario, ask1 = 80_000) {
  scenario.reply((url) => url.pathname === "/api/bars", {
    body: { symbol: CODE, venue: "combined", period: "5m", bars: BARS_5M, current: null, nextBefore: at(8, 25), seq: null },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, {
    body: { symbol: CODE, upperLimit: 95_000, lowerLimit: 50_000, ...FUNDAMENTAL_FIGURES },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: liveSnapshot(ask1) });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, {
    body: { symbol: CODE, venue: "combined", trades: [], skippedRows: 0 },
  });
  pinQuote(scenario, CODE, ask1 - 100, 1_000);
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/day-summary`, () => {
    const quote = scenario.market.quote(CODE, "combined");
    return { body: quote ? daySummaryOf({ ...quote, price: ask1 - 100, change: 1_000 }) : null };
  });
}

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function barCoordinate(page: Page, time: number, n = 1): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ n, time }) => {
      const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith(`칸 ${n}: `));
      if (!probe) throw new Error("차트 좌표가 없습니다");
      const x = probe.chart.timeScale().timeToCoordinate(time);
      const box = probe.chart.chartElement().getBoundingClientRect();
      if (x === null || x < 0 || x > probe.chart.timeScale().width()) throw new Error("가리킬 봉이 화면 밖입니다");
      return { x: box.x + x, y: box.y + box.height * 0.55 };
    },
    { n, time: toChartTime(time) },
  );
}

const replayToggle = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "호가 복기", exact: true });
const bookWindow = (page: Page) => page.getByTestId("book-window");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(installChartProbe);
});

test("호가 복기를 켜고 봉을 가리키면 10호가창이 그 봉의 수집 호가를 보이고 벗어나도 남는다", async ({ page, scenario }) => {
  seedLayout(scenario);
  seedMarket(scenario, 80_000);
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  let replayRequests = 0;
  scenario.on(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay` && url.searchParams.get("date") === "20261123",
    () => {
      replayRequests++;
      return { body: REPLAY_DAY };
    },
  );

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(bookWindow(page)).toBeVisible();
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("80,000");
  await expect(bookWindow(page).getByTestId("replay-strip")).toHaveCount(0);
  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "false");

  await replayToggle(page).click();
  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(bookWindow(page).getByTestId("replay-strip")).toHaveText("실시간 · 차트를 가리키면 그 시각 호가");
  expect(replayRequests).toBe(0);

  const pos = await barCoordinate(page, at(9, 0));
  await page.mouse.move(pos.x, pos.y);
  await frames(page);

  await expect(bookWindow(page)).toHaveAttribute("data-replay", "past");
  await expect(bookWindow(page).getByTestId("replay-strip")).toContainText("수집 호가 · 11/23 09:04:59");
  await expect(bookWindow(page).getByTestId("replay-venue")).toHaveCount(0);
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("71,200");
  await expect(bookWindow(page).getByTestId("market-symbol-price")).toHaveText("71,200");
  await expect(bookWindow(page).getByTestId("book-total-ask")).toHaveText("1,200");
  await expect(bookWindow(page).getByTestId("book-total-bid")).toHaveText("2,400");
  await expect(bookWindow(page).getByTestId("ladder-info-card")).toHaveCount(0);
  await expect(bookWindow(page).getByTestId("ladder-strength")).toHaveCount(0);
  await expect(bookWindow(page).getByTestId("ladder-trade")).toHaveCount(2);
  expect(replayRequests).toBe(1);

  await page.mouse.move(pos.x + 1, pos.y + 8);
  await frames(page);
  await page.mouse.move(pos.x - 1, pos.y - 8);
  await frames(page);
  expect(replayRequests).toBe(1);

  await page.mouse.move(8, 8);
  await frames(page);
  await expect(bookWindow(page)).toHaveAttribute("data-replay", "past");
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("71,200");

  await pickDesktopVenue(page, "KRX");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.mouse.move(pos.x, pos.y);
  await frames(page);
  await expect(bookWindow(page)).toHaveAttribute("data-replay", "past");
  await expect(bookWindow(page).getByTestId("replay-venue")).toHaveText("통합");

  await replayToggle(page).click();
  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(bookWindow(page)).not.toHaveAttribute("data-replay");
  await expect(bookWindow(page).getByTestId("replay-strip")).toHaveCount(0);
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("80,000");
});

test("available=false면 스위치가 보이지 않고 10호가창이 지금과 같다", async ({ page, scenario }) => {
  seedLayout(scenario);
  seedMarket(scenario, 80_000);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("80,000");
  await expect(replayToggle(page)).toHaveCount(0);
  await expect(bookWindow(page).getByTestId("replay-strip")).toHaveCount(0);
});

test("수집 호가가 끊긴 봉은 노란 띠와 이유를 보이고 총잔량과 현재가를 비운다", async ({ page, scenario }) => {
  seedLayout(scenario);
  seedMarket(scenario, 80_000);
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay`, { body: REPLAY_DAY });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await replayToggle(page).click();

  const gapPos = await barCoordinate(page, at(9, 25));
  await page.mouse.move(gapPos.x, gapPos.y);
  await frames(page);

  await expect(bookWindow(page)).toHaveAttribute("data-replay", "none");
  await expect(bookWindow(page).getByTestId("replay-strip")).toHaveAttribute("data-kind", "none");
  await expect(bookWindow(page).getByTestId("replay-strip")).toHaveText("수집이 끊긴 시각입니다");
  await expect(bookWindow(page).getByTestId("price-ladder")).toHaveCount(0);
  await expect(bookWindow(page).getByTestId("market-symbol-price")).toHaveText("-");
  await expect(bookWindow(page).getByTestId("book-total-ask")).toHaveText("-");
  await expect(bookWindow(page).getByTestId("book-total-bid")).toHaveText("-");
});

test("새로고침하면 호가 복기 스위치만 남고 10호가창은 실시간으로 시작한다", async ({ page, scenario }) => {
  seedLayout(scenario);
  seedMarket(scenario, 80_000);
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay`, { body: REPLAY_DAY });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await replayToggle(page).click();
  await pollSaved(() => scenario.documents.uiPrefs().bookReplay).toBe(true);

  const pos = await barCoordinate(page, at(9, 0));
  await page.mouse.move(pos.x, pos.y);
  await frames(page);
  await expect(bookWindow(page)).toHaveAttribute("data-replay", "past");

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(bookWindow(page)).not.toHaveAttribute("data-replay");
  await expect(bookWindow(page).getByTestId("replay-strip")).toHaveText("실시간 · 차트를 가리키면 그 시각 호가");
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("80,000");
});

test("지난 날 봉은 등락률 없이 오늘 상·하한가 밖 호가도 그대로 보인다", async ({ page, scenario }) => {
  const prevDay = MIDNIGHT - 86_400;
  const prevAt = (hour: number, minute: number) => prevDay + hour * 3600 + minute * 60;
  const pastBars: Bar[] = Array.from({ length: 30 }, (_, i) => ({
    t: prevAt(8, 30 + i * 5),
    o: 119_800 + i * 50,
    h: 120_100 + i * 50,
    l: 119_700 + i * 50,
    c: 120_000 + i * 50,
    v: 1000 + i * 10,
  }));
  const pastReplay: BookReplayDay = {
    symbol: CODE,
    date: "20261122",
    coverage: "collected",
    previousClose: null,
    covered: [[540, 620]],
    books: [
      {
        minute: 540,
        asks: [
          [120_000, 50],
          [120_100, 60],
        ],
        bids: [
          [119_900, 70],
          [119_800, 80],
        ],
        totalAsk: 500,
        totalBid: 700,
      },
    ],
    trades: [[540, 32_420, 120_000, 10]],
  };
  seedLayout(scenario);
  seedMarket(scenario, 80_000);
  scenario.reply((url) => url.pathname === "/api/bars", {
    body: { symbol: CODE, venue: "combined", period: "5m", bars: pastBars, current: null, nextBefore: prevAt(8, 25), seq: null },
  });
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay` && url.searchParams.get("date") === "20261122",
    { body: pastReplay },
  );

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await replayToggle(page).click();

  const pos = await barCoordinate(page, prevAt(9, 0));
  await page.mouse.move(pos.x, pos.y);
  await frames(page);

  await expect(bookWindow(page)).toHaveAttribute("data-replay", "past");
  await expect(bookWindow(page).getByTestId("replay-strip")).toContainText("수집 호가 · 11/22 09:04:59");
  await expect(bookWindow(page).getByTestId("market-symbol-price")).toHaveText("120,000");
  await expect(bookWindow(page).getByTestId("market-symbol-price")).toHaveAttribute("data-tone", "flat");
  await expect(bookWindow(page).locator(".od-head-rate")).toHaveCount(0);
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("120,000");
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("119,900");
  await expect(bookWindow(page).locator(".mw-px small")).toHaveCount(0);
});

test("과거일과 마지막 거래일 다음날 전환에서도 수집 기준가로 10호가창 색상과 등락률이 적용되고 오늘 상·하한 밖 호가도 남는다", async ({ page, scenario }) => {
  await page.clock.install({ time: new Date("2026-11-23T14:00:00+09:00") });
  const prevDay = MIDNIGHT - 86_400;
  const prevAt = (hour: number, minute: number) => prevDay + hour * 3600 + minute * 60;
  const pastBars: Bar[] = Array.from({ length: 30 }, (_, i) => ({
    t: prevAt(8, 30 + i * 5),
    o: 119_800 + i * 50,
    h: 120_100 + i * 50,
    l: 119_700 + i * 50,
    c: 120_000 + i * 50,
    v: 1000 + i * 10,
  }));
  const pastReplay: BookReplayDay = {
    symbol: CODE,
    date: "20261122",
    coverage: "collected",
    previousClose: 119_900,
    covered: [[540, 620]],
    books: [
      {
        minute: 540,
        asks: [
          [120_000, 50],
          [120_100, 60],
        ],
        bids: [
          [119_900, 70],
          [119_800, 80],
        ],
        totalAsk: 500,
        totalBid: 700,
      },
    ],
    trades: [[540, 32_420, 120_000, 10]],
  };
  seedLayout(scenario);
  seedMarket(scenario, 80_000);
  scenario.reply((url) => url.pathname === "/api/bars", {
    body: { symbol: CODE, venue: "combined", period: "5m", bars: pastBars, current: null, nextBefore: prevAt(8, 25), seq: null },
  });
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay` && url.searchParams.get("date") === "20261122",
    { body: pastReplay },
  );

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await replayToggle(page).click();

  const pos = await barCoordinate(page, prevAt(9, 0));
  await page.mouse.move(pos.x, pos.y);
  await frames(page);

  await expect(bookWindow(page)).toHaveAttribute("data-replay", "past");
  await expect(bookWindow(page).getByTestId("market-symbol-price")).toHaveText("120,000");
  await expect(bookWindow(page).getByTestId("market-symbol-price")).toHaveAttribute("data-tone", "up");
  await expect(bookWindow(page).locator(".od-head-rate")).toHaveText("▲0.08%");
  await expect(bookWindow(page).locator(".mw-px.mw-up", { hasText: "120,000" })).toContainText("+0.08%");
  await expect(bookWindow(page).locator(".mw-px.mw-down", { hasText: "119,800" })).toContainText("−0.08%");
  await expect(bookWindow(page).getByTestId("ladder-trade").first().locator(".mw-trade-price")).toHaveAttribute("data-tone", "up");

  await page.clock.fastForward(12 * 3600 * 1000);
  await frames(page);
  await expect(bookWindow(page).locator(".mw-px.mw-up", { hasText: "120,000" })).toContainText("+0.08%");
  await expect(bookWindow(page).locator(".mw-px.mw-down", { hasText: "119,800" })).toContainText("−0.08%");
});

test("오늘 마감 봉이 미수집이고 응답이 20초 넘었으면 곧바로 다시 받고 다른 봉을 스쳐도 20초 주기가 밀리지 않는다", async ({ page, scenario }) => {
  await page.clock.install({ time: new Date("2026-11-23T09:20:00+09:00") });
  seedLayout(scenario);
  seedMarket(scenario, 80_000);
  scenario.reply("/api/book-replay/access", { body: { available: true } });

  const initialDay: BookReplayDay = {
    symbol: CODE,
    date: "20261123",
    coverage: "collected",
    previousClose: 71_000,
    covered: [[540, 544]],
    books: [
      { minute: 540, asks: [[71_200, 120]], bids: [[71_100, 150]], totalAsk: 1_200, totalBid: 2_400 },
    ],
    trades: [[540, 32_420, 71_200, 25]],
  };
  const updatedDay: BookReplayDay = {
    ...initialDay,
    covered: [[540, 550]],
    books: [
      ...initialDay.books,
      { minute: 549, asks: [[71_900, 90]], bids: [[71_800, 110]], totalAsk: 900, totalBid: 1_100 },
    ],
    trades: [...initialDay.trades, [549, 32_990, 71_900, 15]],
  };

  let requests = 0;
  scenario.on(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay` && url.searchParams.get("date") === "20261123",
    () => {
      requests++;
      return { body: requests >= 3 ? updatedDay : initialDay };
    },
  );

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await replayToggle(page).click();

  const bar0900 = await barCoordinate(page, at(9, 0));
  const bar0905 = await barCoordinate(page, at(9, 5));

  await page.mouse.move(bar0900.x, bar0900.y);
  await frames(page);
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("71,200");
  expect(requests).toBe(1);

  await page.clock.fastForward(25_000);
  await page.mouse.move(bar0905.x, bar0905.y);
  await frames(page);
  await pollSaved(() => requests).toBe(2);
  await expect(bookWindow(page).getByTestId("replay-strip")).toHaveText("아직 수집되지 않은 구간입니다");

  await page.clock.fastForward(10_000);
  await page.mouse.move(bar0900.x, bar0900.y);
  await frames(page);
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("71,200");

  await page.mouse.move(bar0905.x, bar0905.y);
  await frames(page);
  expect(requests).toBe(2);

  await page.clock.fastForward(10_000);
  await pollSaved(() => requests).toBe(3);
  await expect(bookWindow(page)).toHaveAttribute("data-replay", "past");
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("71,900");
});

test("공개 모드에서는 book-replay 경로를 호출하지 않고 스위치가 보이지 않는다", async ({ page, scenario }) => {
  scenario.publicMode.enable({ provider: "google", createdAt: Math.floor(scenario.now / 1000) });
  await page.goto("/");
  await expect(page.getByRole("toolbar", { name: "차트 도구 막대" })).toBeVisible();
  await expect(replayToggle(page)).toHaveCount(0);
  const replayCalls = scenario.requests.filter((request) => new URL(request.url()).pathname.includes("book-replay"));
  expect(replayCalls).toHaveLength(0);
});

test("재조회가 실패해도 이미 받은 수집 호가는 유지되고 20초 뒤 다시 시도한다", async ({ page, scenario }) => {
  await page.clock.install({ time: new Date("2026-11-23T09:20:00+09:00") });
  seedLayout(scenario);
  seedMarket(scenario, 80_000);
  scenario.reply("/api/book-replay/access", { body: { available: true } });

  const initialDay: BookReplayDay = {
    symbol: CODE,
    date: "20261123",
    coverage: "collected",
    previousClose: 71_000,
    covered: [[540, 544]],
    books: [{ minute: 540, asks: [[71_200, 120]], bids: [[71_100, 150]], totalAsk: 1_200, totalBid: 2_400 }],
    trades: [[540, 32_420, 71_200, 25]],
  };
  const recoveredDay: BookReplayDay = {
    ...initialDay,
    covered: [[540, 550]],
    books: [
      ...initialDay.books,
      { minute: 549, asks: [[71_900, 90]], bids: [[71_800, 110]], totalAsk: 900, totalBid: 1_100 },
    ],
    trades: [...initialDay.trades, [549, 32_990, 71_900, 15]],
  };

  let requests = 0;
  scenario.on(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay` && url.searchParams.get("date") === "20261123",
    () => {
      requests++;
      if (requests === 1) return { body: initialDay };
      if (requests === 2) return { status: 500, body: { error: { code: "internal", message: "boom", reason: null, retryAt: null, manualActionRequired: false } } };
      return { body: recoveredDay };
    },
  );

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await replayToggle(page).click();

  const bar0900 = await barCoordinate(page, at(9, 0));
  const bar0905 = await barCoordinate(page, at(9, 5));

  await page.mouse.move(bar0900.x, bar0900.y);
  await frames(page);
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("71,200");
  expect(requests).toBe(1);

  await page.clock.fastForward(25_000);
  await page.mouse.move(bar0905.x, bar0905.y);
  await frames(page);
  await pollSaved(() => requests).toBe(2);
  await expect(bookWindow(page).getByTestId("replay-strip")).toHaveText("아직 수집되지 않은 구간입니다");

  await page.mouse.move(bar0900.x, bar0900.y);
  await frames(page);
  await expect(bookWindow(page)).toHaveAttribute("data-replay", "past");
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("71,200");

  await page.mouse.move(bar0905.x, bar0905.y);
  await frames(page);
  await page.clock.fastForward(20_000);
  await pollSaved(() => requests).toBe(3);
  await expect(bookWindow(page)).toHaveAttribute("data-replay", "past");
  await expect(bookWindow(page).getByTestId("price-ladder")).toContainText("71,900");
});
