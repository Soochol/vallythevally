import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { BookReplayDay } from "../src/api/generated/BookReplayDay";
import type { BookReplayProgramDay } from "../src/api/generated/BookReplayProgramDay";
import type { BookReplayTrades } from "../src/api/generated/BookReplayTrades";
import type { BrokerDay } from "../src/api/generated/BrokerDay";
import type { ClientMessage } from "../src/api/generated/ClientMessage";
import type { FeedBrokers } from "../src/api/generated/FeedBrokers";
import type { FeedKind } from "../src/api/generated/FeedKind";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderBook } from "../src/api/generated/OrderBook";
import type { Venue } from "../src/api/generated/Venue";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { daySummaryOf } from "./fixtures/scenario";
import { cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, pollSaved, type Scenario, test } from "./harness";
import { FUNDAMENTAL_FIGURES, pinQuote } from "./order-window";

test.use({ clockStart: "20261123093200" });

const CODE = "005930";
const DATE = "20261123";
const MIDNIGHT = Date.parse("2026-11-23T00:00:00+09:00") / 1000;
const at = (hour: number, minute: number, second = 0) => MIDNIGHT + hour * 3600 + minute * 60 + second;
const secOf = (hour: number, minute: number, second = 0) => hour * 3600 + minute * 60 + second;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 20 };

const BARS_5M: Bar[] = Array.from({ length: 13 }, (_, i) => ({
  t: at(8, 30 + i * 5),
  o: 71_000 + i * 100,
  h: 71_300 + i * 100,
  l: 70_900 + i * 100,
  c: 71_200 + i * 100,
  v: 1_000 + i * 50,
}));

const GAP_RANGE: [number, number] = [at(9, 20), at(9, 26)];

const REPLAY_BOOK_DAY: BookReplayDay = {
  symbol: CODE,
  date: DATE,
  coverage: "collected",
  covered: [[540, 559], [567, 575]],
  books: [
    {
      minute: 540,
      asks: [[71_200, 120], [71_300, 230], [71_400, 340]],
      bids: [[71_100, 150], [71_000, 260], [70_900, 370]],
      totalAsk: 1_200,
      totalBid: 2_400,
    },
  ],
  trades: [[540, secOf(9, 2, 10), 71_200, 25]],
};

const REPLAY_TRADES_ALL: BookReplayTrades = {
  symbol: CODE,
  date: DATE,
  coverage: "collected",
  venue: "combined",
  gaps: [GAP_RANGE],
  cumVolume: 3_500,
  cumBuyQty: 2_500,
  cumSellQty: 1_000,
  strength: 250,
  trades: [
    { secondOfDay: secOf(9, 4, 20), price: 71_200, quantity: 2_000, side: "buy", venue: "krx" },
    { secondOfDay: secOf(9, 3, 10), price: 71_100, quantity: 600, side: "sell", venue: "nxt" },
    { secondOfDay: secOf(9, 1, 5), price: 71_000, quantity: 10, side: "buy", venue: "krx" },
  ],
};

const REPLAY_PROGRAM_DAY: BookReplayProgramDay = {
  symbol: CODE,
  date: DATE,
  coverage: "collected",
  gaps: [GAP_RANGE],
  rows: [
    { secondOfDay: secOf(9, 0, 30), price: 71_000, buyQty: 1_000, sellQty: 200, netQty: 800, netQtyChange: 800, netAmountMillionWon: 560 },
    { secondOfDay: secOf(9, 3, 0), price: 71_200, buyQty: 2_500, sellQty: 500, netQty: 2_000, netQtyChange: 1_200, netAmountMillionWon: 1_420 },
    { secondOfDay: secOf(9, 12, 0), price: 71_500, buyQty: 4_000, sellQty: 1_000, netQty: 3_000, netQtyChange: 1_000, netAmountMillionWon: 2_140 },
  ],
};

const brokerEntry = (code: string, name: string, qty: number) => ({ code, name, qty, qtyChange: 0 });

const REPLAY_BROKER_SNAPSHOTS: readonly FeedBrokers[] = [
  { t: at(9, 1, 0), buys: [brokerEntry("151", "키움", 200), brokerEntry("152", "미래", 100)], sells: [brokerEntry("141", "삼성", 180)] },
  { t: at(9, 2, 0), buys: [brokerEntry("151", "키움", 350), brokerEntry("152", "미래", 120)], sells: [brokerEntry("141", "삼성", 250)] },
  { t: at(9, 4, 0), buys: [brokerEntry("151", "키움", 500), brokerEntry("152", "미래", 140)], sells: [brokerEntry("141", "삼성", 320)] },
  { t: at(9, 10, 0), buys: [brokerEntry("151", "키움", 900), brokerEntry("152", "미래", 220)], sells: [brokerEntry("141", "삼성", 550)] },
  { t: at(9, 14, 0), buys: [brokerEntry("151", "키움", 1_400), brokerEntry("152", "미래", 310)], sells: [brokerEntry("141", "삼성", 880)] },
];

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

function seedFourWindowLayout(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: CODE, venue: "combined", period: "5m", chartSettings: SETTINGS },
    { id: "book-0", link: "a", kind: "book" },
    { id: "trades-0", link: "a", kind: "trades" },
    { id: "program-0", link: "a", kind: "program" },
    { id: "brokers-0", link: "a", kind: "brokers" },
  ];
  const root = {
    kind: "split",
    dir: "column",
    ratio: 0.52,
    first: {
      kind: "split",
      dir: "row",
      ratio: 0.42,
      first: { kind: "group", id: "g-chart", tabs: ["cell-0"], active: "cell-0" },
      second: {
        kind: "split",
        dir: "row",
        ratio: 0.5,
        first: { kind: "group", id: "g-book", tabs: ["book-0"], active: "book-0" },
        second: { kind: "group", id: "g-trades", tabs: ["trades-0"], active: "trades-0" },
      },
    },
    second: {
      kind: "split",
      dir: "row",
      ratio: 0.48,
      first: { kind: "group", id: "g-program", tabs: ["program-0"], active: "program-0" },
      second: { kind: "group", id: "g-brokers", tabs: ["brokers-0"], active: "brokers-0" },
    },
  };
  scenario.documents.saveLayout({
    ...layout,
    windows,
    placement: { v: 1, dock: { root, floats: [] }, canvas: null },
    revision: layout.revision + 1,
  });
}

function seedBaseMarket(scenario: Scenario, options?: { readonly replayBrokers?: BrokerDay }) {
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("period") === "5m", {
    body: { symbol: CODE, venue: "combined", period: "5m", bars: BARS_5M, current: null, nextBefore: at(8, 25), seq: null },
  });
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("period") === "1m", {
    body: {
      symbol: CODE,
      venue: "combined",
      period: "1m",
      bars: [
        { t: at(9, 1), o: 71_000, h: 71_100, l: 70_900, c: 71_000, v: 200 },
        { t: at(9, 4), o: 71_100, h: 71_300, l: 71_000, c: 71_200, v: 300 },
        { t: at(9, 10), o: 71_300, h: 71_500, l: 71_200, c: 71_400, v: 400 },
        { t: at(9, 14), o: 71_400, h: 71_600, l: 71_300, c: 71_500, v: 500 },
      ],
      current: null,
      nextBefore: null,
      seq: null,
    },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, {
    body: { symbol: CODE, upperLimit: 95_000, lowerLimit: 50_000, ...FUNDAMENTAL_FIGURES },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: liveSnapshot(80_000) });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, {
    body: {
      symbol: CODE,
      venue: "combined",
      trades: [{ time: "09:31:50", price: 79_900, quantity: 30, exchange: "krx" }],
      skippedRows: 0,
    },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/program-trades`, {
    body: {
      symbol: CODE,
      date: DATE,
      points: [{ time: "09:31:00", price: 79_900, buyQuantity: 9_000, sellQuantity: 1_000, netQuantity: 8_000, buyAmount: 0, sellAmount: 0, netAmount: 640_000_000_000 }],
      skippedRows: 0,
    },
  });
  const collectedBrokers: BrokerDay = options?.replayBrokers ?? {
    symbol: CODE,
    date: DATE,
    source: "store",
    snapshots: [...REPLAY_BROKER_SNAPSHOTS],
    gaps: [GAP_RANGE],
    live: false,
    cursor: "s:4",
    reset: true,
  };
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/brokers`, (request) => {
    const fallback = new URL(request.url()).searchParams.get("fallback");
    if (fallback === "latest") {
      return {
        body: {
          symbol: CODE,
          date: DATE,
          source: "none",
          snapshots: [],
          gaps: [],
          live: true,
          cursor: "",
          reset: true,
        },
      };
    }
    return { body: collectedBrokers };
  });
  pinQuote(scenario, CODE, 79_900, 1_000);
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/day-summary`, () => {
    const quote = scenario.market.quote(CODE, "combined");
    return { body: quote ? daySummaryOf({ ...quote, price: 79_900, change: 1_000 }) : null };
  });
}

type FeedSubscribeMessage = Extract<ClientMessage, { type: "subscribe_feed" }>;

function activeFeedSubs(scenario: Scenario, kind: FeedKind): FeedSubscribeMessage[] {
  const unsubscribed = new Set(
    scenario.live.messages.flatMap((m) => (m.type === "unsubscribe" ? [m.sub] : [])),
  );
  return scenario.live.messages.filter(
    (m): m is FeedSubscribeMessage => m.type === "subscribe_feed" && m.kind === kind && !unsubscribed.has(m.sub),
  );
}

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function hoverBar(page: Page, time: number) {
  const pos = await page.evaluate((t) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    if (!probe) throw new Error("차트 프로브가 없습니다");
    const x = probe.chart.timeScale().timeToCoordinate(t);
    const box = probe.chart.chartElement().getBoundingClientRect();
    if (x === null || x < 0 || x > probe.chart.timeScale().width()) throw new Error("봉이 차트 화면 밖입니다");
    return { x: box.x + x, y: box.y + box.height * 0.5 };
  }, toChartTime(time));
  await page.mouse.move(pos.x, pos.y);
  await frames(page);
}

const replayToggle = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "호가 복기", exact: true });
const bookWin = (page: Page) => page.getByTestId("book-window");
const tradesWin = (page: Page) => page.getByTestId("trades-window");
const programWin = (page: Page) => page.getByTestId("program-window");
const brokersWin = (page: Page) => page.getByTestId("brokers-window");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(installChartProbe);
});

test("호가 복기 ON 후 봉을 가리키면 4창이 동기화되고 4종 실시간 WS를 모두 구독 해제한다", async ({ page, scenario }) => {
  seedFourWindowLayout(scenario);
  seedBaseMarket(scenario);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay`, { body: REPLAY_BOOK_DAY });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay/trades`, { body: REPLAY_TRADES_ALL });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay/program`, { body: REPLAY_PROGRAM_DAY });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(bookWin(page)).toBeVisible();
  await expect(tradesWin(page)).toBeVisible();
  await expect(programWin(page)).toBeVisible();
  await expect(brokersWin(page)).toBeVisible();

  await pollSaved(() => activeFeedSubs(scenario, "book").length).toBeGreaterThan(0);
  await pollSaved(() => activeFeedSubs(scenario, "trades").length).toBeGreaterThan(0);
  await pollSaved(() => activeFeedSubs(scenario, "program").length).toBeGreaterThan(0);
  await pollSaved(() => activeFeedSubs(scenario, "brokers").length).toBeGreaterThan(0);

  await replayToggle(page).click();
  await expect(bookWin(page).getByTestId("replay-strip")).toHaveText("실시간 · 차트를 가리키면 그 시각 호가");
  await expect(tradesWin(page).getByTestId("replay-strip")).toHaveText("실시간 · 차트를 가리키면 그 시각 체결");
  await expect(programWin(page).getByTestId("replay-strip")).toHaveText("실시간 · 차트를 가리키면 그 시각 프로그램");
  await expect(brokersWin(page).getByTestId("replay-strip")).toHaveText("실시간 · 차트를 가리키면 그 시각 거래원");

  await hoverBar(page, at(9, 0));

  await expect(bookWin(page)).toHaveAttribute("data-replay", "past");
  await expect(bookWin(page).getByTestId("replay-strip")).toContainText("수집 호가 · 11/23 09:04:59");
  await expect(bookWin(page).getByTestId("price-ladder")).toContainText("71,200");

  await expect(tradesWin(page)).toHaveAttribute("data-replay", "past");
  await expect(tradesWin(page).getByTestId("replay-strip")).toContainText("수집 체결 · 11/23 09:04:59");
  await expect(tradesWin(page).getByTestId("trade-strength")).toHaveText("250.00%");
  await expect(tradesWin(page).getByTestId("trade-cumulative")).toHaveText("3,500");
  await expect(tradesWin(page).getByTestId("trade-row")).toHaveCount(3);
  await expect(tradesWin(page).getByTestId("trade-row").first()).toContainText("09:04:20");

  await expect(programWin(page)).toHaveAttribute("data-replay", "past");
  await expect(programWin(page).getByTestId("replay-strip")).toContainText("수집 프로그램 · 11/23 09:04:59");
  await expect(programWin(page).getByTestId("program-net-qty")).toHaveText("+2,000");
  await expect(programWin(page).getByTestId("program-buy-qty")).toHaveText("2,500");
  await expect(programWin(page).getByTestId("program-sell-qty")).toHaveText("500");
  await expect(programWin(page).getByTestId("program-row")).toHaveCount(2);
  await expect(programWin(page).getByTestId("program-trend").locator("polyline")).toBeVisible();

  await expect(brokersWin(page)).toHaveAttribute("data-replay", "past");
  await expect(brokersWin(page).getByTestId("replay-strip")).toContainText("수집 거래원 · 11/23 09:04:59");
  const kiwoomCard = brokersWin(page).getByTestId("broker-card").and(page.locator('[data-broker="키움"]'));
  await expect(kiwoomCard.getByTestId("broker-cumulative")).toHaveText("+500");

  await brokersWin(page).getByRole("group", { name: "보기" }).getByRole("button", { name: "이동", exact: true }).click();
  await expect(brokersWin(page).getByTestId("broker-transfer-view")).toBeVisible();
  await expect(brokersWin(page).getByTestId("broker-transfer-range")).toContainText("09:02");
  await expect(brokersWin(page).getByTestId("broker-transfer-range")).toContainText("09:04");
  await expect(brokersWin(page).getByTestId("broker-transfer-range")).not.toContainText("09:10");
  await expect(brokersWin(page).getByTestId("broker-transfer-range")).not.toContainText("09:14");

  await pollSaved(() => activeFeedSubs(scenario, "book")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "trades")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "program")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "brokers")).toHaveLength(0);
});

test("호가 복기를 끄면 4창의 실시간 WS가 복원되고 새 라이브 프레임을 받는다", async ({ page, scenario }) => {
  seedFourWindowLayout(scenario);
  seedBaseMarket(scenario);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay`, { body: REPLAY_BOOK_DAY });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay/trades`, { body: REPLAY_TRADES_ALL });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay/program`, { body: REPLAY_PROGRAM_DAY });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await pollSaved(() => activeFeedSubs(scenario, "brokers").length).toBeGreaterThan(0);

  await replayToggle(page).click();
  await hoverBar(page, at(9, 0));

  await expect(bookWin(page)).toHaveAttribute("data-replay", "past");
  await expect(tradesWin(page)).toHaveAttribute("data-replay", "past");
  await expect(programWin(page)).toHaveAttribute("data-replay", "past");
  await expect(brokersWin(page)).toHaveAttribute("data-replay", "past");
  await pollSaved(() => activeFeedSubs(scenario, "book")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "trades")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "program")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "brokers")).toHaveLength(0);

  await replayToggle(page).click();

  await expect(bookWin(page)).not.toHaveAttribute("data-replay");
  await expect(tradesWin(page)).not.toHaveAttribute("data-replay");
  await expect(programWin(page)).not.toHaveAttribute("data-replay");
  await expect(brokersWin(page)).not.toHaveAttribute("data-replay");
  await expect(page.getByTestId("replay-strip")).toHaveCount(0);

  await pollSaved(() => activeFeedSubs(scenario, "book").length).toBeGreaterThan(0);
  await pollSaved(() => activeFeedSubs(scenario, "trades").length).toBeGreaterThan(0);
  await pollSaved(() => activeFeedSubs(scenario, "program").length).toBeGreaterThan(0);
  await pollSaved(() => activeFeedSubs(scenario, "brokers").length).toBeGreaterThan(0);

  const bookSub = activeFeedSubs(scenario, "book").at(-1)!.sub;
  const tradeSubs = activeFeedSubs(scenario, "trades");
  const programSub = activeFeedSubs(scenario, "program").at(-1)!.sub;
  const brokerSub = activeFeedSubs(scenario, "brokers").at(-1)!.sub;

  scenario.live.emit({
    type: "feed_book",
    sub: bookSub,
    book: {
      t: at(9, 32, 10),
      asks: [{ price: 81_200, qty: 77 }],
      bids: [{ price: 81_100, qty: 88 }],
      totalAskQty: 7_700,
      totalBidQty: 8_800,
      expected: null,
    },
  });
  for (const sub of tradeSubs) {
    scenario.live.emit({
      type: "feed_trades",
      sub: sub.sub,
      seq: 2,
      trades: [{ t: at(9, 32, 10), price: 81_200, qty: 42, venue: "krx", strength: 135.5 }],
    });
  }
  scenario.live.emit({
    type: "feed_program",
    sub: programSub,
    row: {
      t: at(9, 32, 10),
      price: 81_200,
      sellQty: 1_500,
      sellAmount: 0,
      buyQty: 11_000,
      buyAmount: 0,
      netQty: 9_500,
      netQtyChange: 1_500,
      netAmount: 7_700,
      netAmountChange: 0,
    },
  });
  scenario.live.emit({
    type: "feed_brokers",
    sub: brokerSub,
    brokers: {
      t: at(9, 32, 10),
      buys: [brokerEntry("151", "키움", 2_200)],
      sells: [brokerEntry("141", "삼성", 900)],
    },
  });

  await expect(bookWin(page).getByTestId("book-total-ask")).toHaveText("7,700");
  await expect(tradesWin(page).getByTestId("trade-strength")).toHaveText("135.50%");
  await expect(tradesWin(page).getByTestId("trade-row").first()).toContainText("81,200");
  await expect(programWin(page).getByTestId("program-net-qty")).toHaveText("+9,500");
  await expect(brokersWin(page).getByTestId("broker-card").and(page.locator('[data-broker="키움"]')).getByTestId("broker-cumulative")).toHaveText("+2,200");
});

test("진행 중 봉, 수집 끊김, 미수집 종목 상태에서 4창이 일관된 사유를 보이고 라이브 WS를 새지 않는다", async ({ page, scenario }) => {
  seedFourWindowLayout(scenario);
  const uncollectedState = { active: false };
  seedBaseMarket(scenario, {
    replayBrokers: {
      symbol: CODE,
      date: DATE,
      source: "store",
      snapshots: [...REPLAY_BROKER_SNAPSHOTS],
      gaps: [GAP_RANGE],
      live: false,
      cursor: "s:4",
      reset: true,
    },
  });
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/brokers`, (request) => {
    const fallback = new URL(request.url()).searchParams.get("fallback");
    if (fallback === "latest" || uncollectedState.active) {
      return {
        body: {
          symbol: CODE,
          date: DATE,
          source: "none",
          snapshots: [],
          gaps: [],
          live: false,
          cursor: "",
          reset: true,
        },
      };
    }
    return {
      body: {
        symbol: CODE,
        date: DATE,
        source: "store",
        snapshots: [...REPLAY_BROKER_SNAPSHOTS],
        gaps: [GAP_RANGE],
        live: false,
        cursor: "s:4",
        reset: true,
      },
    };
  });
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/book-replay`, () => ({
    body: uncollectedState.active
      ? { symbol: CODE, date: DATE, coverage: "symbol_not_collected", covered: [], books: [], trades: [] }
      : REPLAY_BOOK_DAY,
  }));
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/book-replay/trades`, () => ({
    body: uncollectedState.active
      ? { symbol: CODE, date: DATE, coverage: "symbol_not_collected", venue: "combined", gaps: [], cumVolume: 0, cumBuyQty: 0, cumSellQty: 0, strength: null, trades: [] }
      : REPLAY_TRADES_ALL,
  }));
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/book-replay/program`, () => ({
    body: uncollectedState.active
      ? { symbol: CODE, date: DATE, coverage: "symbol_not_collected", gaps: [], rows: [] }
      : REPLAY_PROGRAM_DAY,
  }));

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await replayToggle(page).click();

  await hoverBar(page, at(9, 30));
  for (const win of [bookWin(page), tradesWin(page), programWin(page), brokersWin(page)]) {
    await expect(win).toHaveAttribute("data-replay", "none");
    await expect(win.getByTestId("replay-strip")).toHaveText("아직 진행 중인 봉입니다");
  }
  await pollSaved(() => activeFeedSubs(scenario, "book")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "trades")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "program")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "brokers")).toHaveLength(0);

  await hoverBar(page, at(9, 20));
  for (const win of [bookWin(page), tradesWin(page), programWin(page), brokersWin(page)]) {
    await expect(win).toHaveAttribute("data-replay", "none");
    await expect(win.getByTestId("replay-strip")).toHaveText("수집이 끊긴 시각입니다");
  }
  await pollSaved(() => activeFeedSubs(scenario, "brokers")).toHaveLength(0);

  uncollectedState.active = true;
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await hoverBar(page, at(9, 0));
  for (const win of [bookWin(page), tradesWin(page), programWin(page), brokersWin(page)]) {
    await expect(win).toHaveAttribute("data-replay", "none");
    await expect(win.getByTestId("replay-strip")).toHaveText("수집하지 않는 종목입니다");
  }
  await pollSaved(() => activeFeedSubs(scenario, "book")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "trades")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "program")).toHaveLength(0);
  await pollSaved(() => activeFeedSubs(scenario, "brokers")).toHaveLength(0);
});

test("복기 중 체결창 최소 금액 필터와 거래소 전환이 쿼리 파라미터와 행·배지를 갱신한다", async ({ page, scenario }) => {
  seedFourWindowLayout(scenario);
  seedBaseMarket(scenario);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay`, { body: REPLAY_BOOK_DAY });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay/program`, { body: REPLAY_PROGRAM_DAY });

  const queries: { venue: string | null; minWon: string | null; untilSec: string | null }[] = [];
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/book-replay/trades`, (request) => {
    const params = new URL(request.url()).searchParams;
    const requestedVenue = (params.get("venue") ?? "combined") as Venue;
    const minWon = Number(params.get("minWon") ?? "0");
    queries.push({ venue: params.get("venue"), minWon: params.get("minWon"), untilSec: params.get("untilSec") });

    const effectiveVenue: Venue = requestedVenue === "nxt" ? "combined" : requestedVenue;
    const filtered = REPLAY_TRADES_ALL.trades.filter(
      (row) => (effectiveVenue === "combined" || row.venue === effectiveVenue) && row.price * row.quantity >= minWon,
    );
    return {
      body: {
        ...REPLAY_TRADES_ALL,
        venue: effectiveVenue,
        trades: filtered,
      },
    };
  });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await replayToggle(page).click();
  await hoverBar(page, at(9, 0));

  await expect(tradesWin(page)).toHaveAttribute("data-replay", "past");
  await expect(tradesWin(page).getByTestId("trade-row")).toHaveCount(3);
  await expect(tradesWin(page).getByTestId("trade-integrated-only")).toHaveCount(0);

  const minGroup = tradesWin(page).getByRole("group", { name: "최소 체결 금액" });
  await minGroup.getByRole("button", { name: "3천만" }).click();
  await expect(tradesWin(page).getByTestId("trade-row")).toHaveCount(2);
  await pollSaved(() => queries.some((q) => q.minWon === "30000000" && q.venue === "combined")).toBe(true);

  await minGroup.getByRole("button", { name: "1억" }).click();
  await expect(tradesWin(page).getByTestId("trade-row")).toHaveCount(1);
  await pollSaved(() => queries.some((q) => q.minWon === "100000000")).toBe(true);

  await minGroup.getByRole("button", { name: "전체" }).click();
  await expect(tradesWin(page).getByTestId("trade-row")).toHaveCount(3);

  await pickDesktopVenue(page, "KRX");
  await expect(tradesWin(page)).toHaveAttribute("data-replay", "past");
  await expect(tradesWin(page).getByTestId("trade-row")).toHaveCount(2);
  await expect(tradesWin(page).getByTestId("trade-integrated-only")).toHaveCount(0);
  await pollSaved(() => queries.some((q) => q.venue === "krx")).toBe(true);
  await pollSaved(() => activeFeedSubs(scenario, "trades")).toHaveLength(0);

  await pickDesktopVenue(page, "NXT");
  await expect(tradesWin(page)).toHaveAttribute("data-replay", "past");
  await expect(tradesWin(page).getByTestId("trade-integrated-only")).toHaveText("통합 기준");
  await expect(tradesWin(page).getByTestId("trade-row")).toHaveCount(3);
  await pollSaved(() => queries.some((q) => q.venue === "nxt")).toBe(true);
  await pollSaved(() => activeFeedSubs(scenario, "trades")).toHaveLength(0);
});
