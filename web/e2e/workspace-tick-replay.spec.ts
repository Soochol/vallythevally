import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { BookReplayMeta } from "../src/api/generated/BookReplayMeta";
import type { BrokerDay } from "../src/api/generated/BrokerDay";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderBook } from "../src/api/generated/OrderBook";
import type { ProgramSeriesPage } from "../src/api/generated/ProgramSeriesPage";
import { toChartTime } from "../src/chart/time";
import { encodeHogaSpan } from "../src/features/replay-page/hogaDecode";
import { installChartProbe } from "./chart-probe";
import { daySummaryOf } from "./fixtures/scenario";
import { cell, DEFAULT_LAYOUT_ID, expect, type Scenario, test } from "./harness";
import { cellAt, FUNDAMENTAL_FIGURES, openOrder, ordersOn, pinQuote, tradingApi } from "./order-window";

test.use({ clockStart: "20261126140000", viewport: { width: 1600, height: 960 } });

const CODE = "005930";
const ALT_CODE = "000660";
const DATE = "20261125";
const ARCHIVE_DATE = "20261124";

const MIDNIGHT = Date.parse("2026-11-25T00:00:00+09:00") / 1000;
const ARCHIVE_MIDNIGHT = Date.parse("2026-11-24T00:00:00+09:00") / 1000;
const UNCOLLECTED_MIDNIGHT = Date.parse("2026-11-23T00:00:00+09:00") / 1000;
const M540 = 540 * 60_000;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 25 };

const at = (midnight: number, hour: number, minute: number, second = 0) =>
  midnight + hour * 3600 + minute * 60 + second;

const BARS_1M: Bar[] = [
  { t: at(UNCOLLECTED_MIDNIGHT, 9, 0), o: 69_000, h: 69_200, l: 68_900, c: 69_100, v: 500 },
  { t: at(ARCHIVE_MIDNIGHT, 9, 0), o: 70_000, h: 70_300, l: 69_900, c: 70_200, v: 600 },
  { t: at(ARCHIVE_MIDNIGHT, 9, 1), o: 70_200, h: 70_400, l: 70_100, c: 70_300, v: 400 },
  { t: at(MIDNIGHT, 9, 0), o: 71_000, h: 71_200, l: 70_900, c: 71_100, v: 900 },
  { t: at(MIDNIGHT, 9, 1), o: 71_100, h: 71_400, l: 71_000, c: 71_300, v: 550 },
  { t: at(MIDNIGHT, 9, 2), o: 71_300, h: 71_500, l: 71_200, c: 71_400, v: 450 },
  { t: at(MIDNIGHT, 9, 3), o: 71_400, h: 71_600, l: 71_300, c: 71_500, v: 500 },
  { t: at(MIDNIGHT, 9, 4), o: 71_500, h: 71_700, l: 71_400, c: 71_600, v: 500 },
  { t: at(MIDNIGHT, 9, 5), o: 71_600, h: 71_800, l: 71_500, c: 71_700, v: 600 },
];

const DAILY_BARS: Bar[] = [
  { t: at(ARCHIVE_MIDNIGHT, 9, 0), o: 70_000, h: 70_500, l: 69_800, c: 70_000, v: 500_000 },
  { t: at(MIDNIGHT, 9, 0), o: 71_000, h: 72_000, l: 70_800, c: 71_500, v: 600_000 },
];

const REPLAY_META_TICK: BookReplayMeta = {
  symbol: CODE,
  date: DATE,
  coverage: "collected",
  resolution: "tick",
  spanMinutes: 5,
  previousClose: 70_000,
  covered: [[540, 545]],
  gapsMs: [],
  spans: [{ startMinute: 540, bookRows: 4, tradeRows: 4, programRows: 2 }],
  minutes: [
    {
      minute: 540,
      open: 71_000,
      high: 71_200,
      low: 71_000,
      close: 71_200,
      volume: 900,
      cumVol: 0,
      cumVal: 0,
      cumBuyQty: 0,
      cumSellQty: 0,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      totalAsk: 7_600,
      totalBid: 4_200,
      programNetQty: 1_200,
      programNetAmtMillion: 85,
      singlePrice: false,
    },
    {
      minute: 541,
      open: 71_200,
      high: 71_400,
      low: 71_100,
      close: 71_300,
      volume: 550,
      cumVol: 900,
      cumVal: 71_000 * 100 + 71_200 * 800,
      cumBuyQty: 900,
      cumSellQty: 0,
      dayOpen: 71_000,
      dayHigh: 71_200,
      dayLow: 71_000,
      totalAsk: 7_800,
      totalBid: 4_700,
      programNetQty: 2_600,
      programNetAmtMillion: 185,
      singlePrice: false,
    },
    {
      minute: 542,
      open: 71_300,
      high: 71_500,
      low: 71_200,
      close: 71_400,
      volume: 450,
      cumVol: 1_450,
      cumVal: 71_000 * 100 + 71_200 * 800 + 71_300 * 550,
      cumBuyQty: 1_200,
      cumSellQty: 250,
      dayOpen: 71_000,
      dayHigh: 71_400,
      dayLow: 71_000,
      totalAsk: 7_900,
      totalBid: 4_800,
      programNetQty: 2_600,
      programNetAmtMillion: 185,
      singlePrice: false,
    },
    {
      minute: 543,
      open: 71_400,
      high: 71_600,
      low: 71_300,
      close: 71_500,
      volume: 500,
      cumVol: 1_900,
      cumVal: 71_000 * 100 + 71_200 * 800 + 71_300 * 550 + 71_400 * 450,
      cumBuyQty: 1_650,
      cumSellQty: 250,
      dayOpen: 71_000,
      dayHigh: 71_500,
      dayLow: 71_000,
      totalAsk: 8_000,
      totalBid: 5_000,
      programNetQty: 2_600,
      programNetAmtMillion: 185,
      singlePrice: false,
    },
    {
      minute: 544,
      open: 71_500,
      high: 71_700,
      low: 71_400,
      close: 71_600,
      volume: 500,
      cumVol: 2_400,
      cumVal: 71_000 * 100 + 71_200 * 800 + 71_300 * 550 + 71_400 * 450 + 71_500 * 500,
      cumBuyQty: 2_150,
      cumSellQty: 250,
      dayOpen: 71_000,
      dayHigh: 71_600,
      dayLow: 71_000,
      totalAsk: 8_100,
      totalBid: 5_100,
      programNetQty: 2_600,
      programNetAmtMillion: 185,
      singlePrice: false,
    },
  ],
};

const SPAN_540_BYTES = new Uint8Array(
  encodeHogaSpan({
    date: 20261125,
    startMinute: 540,
    lengthMinutes: 5,
    symbol: `${CODE}_AL`,
    streams: [
      {
        kind: "book",
        columns: {
          recv_ms: [M540, M540 + 40_000, M540 + 80_000, M540 + 125_000],
          t_s: [32_400, 32_440, 32_480, 32_525],
          ask_px1: [71_100, 71_200, 71_300, 71_400],
          ask_px2: [71_200, 71_300, 71_400, 71_500],
          ask_px3: [71_300, 71_400, 71_500, 71_600],
          ask_px4: [71_400, 71_500, 71_600, 71_700],
          bid_px1: [71_000, 71_100, 71_200, 71_300],
          bid_px2: [70_900, 71_000, 71_100, 71_200],
          bid_px3: [70_800, 70_900, 71_000, 71_100],
          bid_px4: [70_700, 70_800, 70_900, 71_000],
          ask_qty1: [1_000, 1_500, 1_400, 1_200],
          ask_qty2: [1_200, 900, 1_000, 1_100],
          ask_qty3: [900, 900, 900, 900],
          ask_qty4: [4_500, 4_500, 4_500, 4_500],
          bid_qty1: [1_400, 1_900, 1_800, 1_700],
          bid_qty2: [1_100, 1_100, 1_100, 1_100],
          bid_qty3: [800, 800, 800, 800],
          bid_qty4: [900, 900, 900, 900],
          ask_total: [7_600, 7_800, 7_900, 8_100],
          bid_total: [4_200, 4_700, 4_800, 5_100],
        },
      },
      {
        kind: "trades",
        columns: {
          recv_ms: [M540 + 15_000, M540 + 45_000, M540 + 85_000, M540 + 130_000],
          t_s: [32_415, 32_445, 32_485, 32_530],
          price: [71_000, 71_200, 71_300, 71_400],
          qty: [100, 800, -250, 300],
          venue: [1, 1, 2, 1],
        },
      },
      {
        kind: "program",
        columns: {
          recv_ms: [M540, M540 + 75_000],
          t_s: [32_400, 32_475],
          sell_qty: [300, 400],
          sell_amt: [35, 45],
          buy_qty: [1_500, 3_000],
          buy_amt: [120, 230],
        },
      },
    ],
  }),
);

const ARCHIVE_META: BookReplayMeta = {
  ...REPLAY_META_TICK,
  date: ARCHIVE_DATE,
  venueScope: "krx_archive",
  spans: [{ startMinute: 540, bookRows: 2, tradeRows: 2, programRows: 0 }],
  minutes: REPLAY_META_TICK.minutes.slice(0, 2),
};

const ARCHIVE_SPAN_BYTES = new Uint8Array(
  encodeHogaSpan({
    date: 20261124,
    startMinute: 540,
    lengthMinutes: 5,
    symbol: `${CODE}_KRX`,
    streams: [
      {
        kind: "book",
        columns: {
          recv_ms: [M540, M540 + 30_000],
          t_s: [32_400, 32_430],
          ask_px1: [70_200, 70_300],
          ask_px2: [70_300, 70_400],
          ask_px3: [70_400, 70_500],
          ask_px4: [70_500, 70_600],
          bid_px1: [70_100, 70_200],
          bid_px2: [70_000, 70_100],
          bid_px3: [69_900, 70_000],
          bid_px4: [69_800, 69_900],
          ask_qty1: [500, 600],
          ask_qty2: [500, 600],
          ask_qty3: [500, 600],
          ask_qty4: [500, 600],
          bid_qty1: [700, 800],
          bid_qty2: [700, 800],
          bid_qty3: [700, 800],
          bid_qty4: [700, 800],
          ask_total: [2_000, 2_400],
          bid_total: [2_800, 3_200],
        },
      },
      {
        kind: "trades",
        columns: {
          recv_ms: [M540 + 15_000, M540 + 35_000],
          t_s: [32_415, 32_435],
          price: [70_200, 70_300],
          qty: [200, 350],
          venue: [1, 1],
        },
      },
    ],
  }),
);

const BROKER_DAY: BrokerDay = {
  symbol: CODE,
  date: DATE,
  source: "store",
  coverage: "collected",
  snapshots: [
    {
      t: at(MIDNIGHT, 9, 0, 10),
      sells: [{ code: "002", name: "NH투자", qty: 1_200, qtyChange: 1_200 }],
      buys: [{ code: "036", name: "모건스탠리", qty: 2_400, qtyChange: 2_400 }],
    },
    {
      t: at(MIDNIGHT, 9, 1, 20),
      sells: [{ code: "002", name: "NH투자", qty: 1_800, qtyChange: 600 }],
      buys: [{ code: "036", name: "모건스탠리", qty: 3_500, qtyChange: 1_100 }],
    },
  ],
  gaps: [],
  live: false,
  cursor: "s:1",
  reset: true,
};

const ARCHIVE_BROKER_DAY: BrokerDay = {
  ...BROKER_DAY,
  date: ARCHIVE_DATE,
  venueScope: "krx_archive",
  snapshots: [
    {
      t: at(ARCHIVE_MIDNIGHT, 9, 0, 10),
      sells: [{ code: "002", name: "NH투자", qty: 900, qtyChange: 900 }],
      buys: [{ code: "036", name: "모건스탠리", qty: 1_500, qtyChange: 1_500 }],
    },
  ],
};

const PROGRAM_PAGE: ProgramSeriesPage = {
  symbol: CODE,
  period: "1m",
  state: "ready",
  points: [
    { t: at(MIDNIGHT, 9, 0), netBuyQty: 1_200, netBuyAmountMillionWon: 85, buyAmountMillionWon: 120, sellAmountMillionWon: 35, programSharePct: 12 },
    { t: at(MIDNIGHT, 9, 1), netBuyQty: 2_600, netBuyAmountMillionWon: 185, buyAmountMillionWon: 230, sellAmountMillionWon: 45, programSharePct: 15 },
  ],
};

function liveOrderBook(code: string, ask1: number): OrderBook {
  return {
    symbol: code,
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

function seedSixWindowLayout(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: CODE, venue: "combined", period: "1m", chartSettings: SETTINGS },
    { id: "book-0", link: "a", kind: "book" },
    { id: "order-0", link: "a", kind: "order", venue: "krx" },
    { id: "trades-0", link: "a", kind: "trades" },
    { id: "program-0", link: "a", kind: "program" },
    { id: "brokers-0", link: "a", kind: "brokers" },
  ];
  const root = {
    kind: "split",
    dir: "column",
    ratio: 0.56,
    first: {
      kind: "split",
      dir: "row",
      ratio: 0.42,
      first: { kind: "group", id: "g-chart", tabs: ["cell-0"], active: "cell-0" },
      second: {
        kind: "split",
        dir: "row",
        ratio: 0.48,
        first: { kind: "group", id: "g-book", tabs: ["book-0"], active: "book-0" },
        second: { kind: "group", id: "g-order", tabs: ["order-0"], active: "order-0" },
      },
    },
    second: {
      kind: "split",
      dir: "row",
      ratio: 0.34,
      first: { kind: "group", id: "g-trades", tabs: ["trades-0"], active: "trades-0" },
      second: {
        kind: "split",
        dir: "row",
        ratio: 0.48,
        first: { kind: "group", id: "g-program", tabs: ["program-0"], active: "program-0" },
        second: { kind: "group", id: "g-brokers", tabs: ["brokers-0"], active: "brokers-0" },
      },
    },
  };
  scenario.documents.saveLayout({
    ...layout,
    windows,
    placement: { v: 1, dock: { root, floats: [] }, canvas: null },
    revision: layout.revision + 1,
  });
}

interface TickReplayMarketOverrides {
  readonly meta?: BookReplayMeta;
  readonly spanStart?: number;
  readonly spanBytes?: Uint8Array;
  readonly bars1m?: readonly Bar[];
  readonly nextBefore?: number | null;
  readonly olderPage?: { readonly bars: readonly Bar[]; readonly nextBefore: number | null };
  readonly jumpPage?: { readonly date: string; readonly bars: readonly Bar[]; readonly nextBefore: number | null };
}

function seedTickReplayMarket(scenario: Scenario, overrides: TickReplayMarketOverrides = {}) {
  const dayMeta = overrides.meta ?? REPLAY_META_TICK;
  const daySpanStart = overrides.spanStart ?? 540;
  const daySpanBytes = overrides.spanBytes ?? SPAN_540_BYTES;
  const initialBars = overrides.bars1m ?? BARS_1M;
  const initialNextBefore = overrides.nextBefore !== undefined ? overrides.nextBefore : at(UNCOLLECTED_MIDNIGHT, 8, 55);
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 71_000, 10)]);
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply(`/api/symbols/${CODE}/book-replay/days`, {
    body: { symbol: CODE, days: [ARCHIVE_DATE, DATE], archiveDays: [ARCHIVE_DATE] },
  });
  scenario.reply(`/api/symbols/${ALT_CODE}/book-replay/days`, {
    body: { symbol: ALT_CODE, days: [] },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay`, {
    body: {
      symbol: CODE,
      date: DATE,
      coverage: "collected",
      previousClose: 70_000,
      covered: dayMeta.covered,
      books: [],
      trades: [],
    },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay/trades`, {
    body: {
      symbol: CODE,
      date: DATE,
      coverage: "collected",
      previousClose: 70_000,
      venue: "combined",
      gaps: [],
      cumVolume: 0,
      cumBuyQty: 0,
      cumSellQty: 0,
      strength: null,
      trades: [],
    },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay/program`, {
    body: {
      symbol: CODE,
      date: DATE,
      coverage: "collected",
      previousClose: 70_000,
      gaps: [],
      rows: [],
    },
  });
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay/meta` && url.searchParams.get("date") === DATE,
    { body: dayMeta },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay/meta` && url.searchParams.get("date") === ARCHIVE_DATE,
    { body: ARCHIVE_META },
  );
  scenario.reply(
    (url) =>
      url.pathname === `/api/symbols/${CODE}/book-replay/span`
      && url.searchParams.get("date") === DATE
      && url.searchParams.get("startMinute") === String(daySpanStart),
    { body: daySpanBytes },
  );
  scenario.reply(
    (url) =>
      url.pathname === `/api/symbols/${CODE}/book-replay/span`
      && url.searchParams.get("date") === ARCHIVE_DATE
      && url.searchParams.get("startMinute") === "540",
    { body: ARCHIVE_SPAN_BYTES },
  );
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("period") === "D", {
    body: { symbol: CODE, venue: "combined", period: "D", bars: DAILY_BARS, current: null, nextBefore: null, seq: null },
  });
  scenario.reply(
    (url) =>
      url.pathname === "/api/bars"
      && url.searchParams.get("symbol") === CODE
      && url.searchParams.get("period") !== "D"
      && !url.searchParams.has("before"),
    { body: { symbol: CODE, venue: "combined", period: "1m", bars: initialBars, current: null, nextBefore: initialNextBefore, seq: null } },
  );
  scenario.reply(
    (url) =>
      url.pathname === "/api/bars"
      && url.searchParams.get("symbol") === CODE
      && url.searchParams.get("period") !== "D"
      && url.searchParams.has("before"),
    {
      body: {
        symbol: CODE,
        venue: "combined",
        period: "1m",
        bars: overrides.olderPage?.bars ?? [],
        current: null,
        nextBefore: overrides.olderPage ? overrides.olderPage.nextBefore : initialNextBefore,
        seq: null,
      },
    },
  );
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === ALT_CODE,
    {
      body: {
        symbol: ALT_CODE,
        venue: "combined",
        period: "1m",
        bars: [{ t: at(MIDNIGHT, 9, 0), o: 190_000, h: 191_000, l: 189_500, c: 190_500, v: 400 }],
        current: null,
        nextBefore: null,
        seq: null,
      },
    },
  );
  scenario.on((url) => url.pathname === "/api/bars/jump", (request) => {
    const reqDate = new URL(request.url()).searchParams.get("date");
    if (overrides.jumpPage && reqDate === overrides.jumpPage.date) {
      return {
        body: {
          symbol: CODE,
          venue: "combined",
          period: "1m",
          date: overrides.jumpPage.date,
          bars: overrides.jumpPage.bars,
          nextBefore: overrides.jumpPage.nextBefore,
          unadjustedDays: 0,
        },
      };
    }
    return {
      body: { symbol: CODE, venue: "combined", period: "1m", date: "2026-11-25", bars: BARS_1M.slice(3), nextBefore: null, unadjustedDays: 0 },
    };
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/quote-totals`, {
    body: { symbol: CODE, period: "1m", venue: "combined", state: "ready", points: [] },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/program-series`, {
    body: PROGRAM_PAGE,
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, {
    body: { symbol: CODE, upperLimit: 95_000, lowerLimit: 50_000, ...FUNDAMENTAL_FIGURES },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${ALT_CODE}/fundamentals`, {
    body: { symbol: ALT_CODE, upperLimit: 247_000, lowerLimit: 133_000, ...FUNDAMENTAL_FIGURES },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, { body: liveOrderBook(CODE, 80_000) });
  scenario.reply((url) => url.pathname === `/api/symbols/${ALT_CODE}/order-book`, { body: liveOrderBook(ALT_CODE, 190_500) });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/trades`, {
    body: {
      symbol: CODE,
      venue: "combined",
      trades: [{ time: "13:59:50", price: 79_900, quantity: 30, exchange: "krx" }],
      skippedRows: 0,
    },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${ALT_CODE}/trades`, {
    body: { symbol: ALT_CODE, venue: "combined", trades: [], skippedRows: 0 },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/program-trades`, {
    body: {
      symbol: CODE,
      date: "20261126",
      points: [{ time: "13:59:00", price: 79_900, buyQuantity: 9_000, sellQuantity: 1_000, netQuantity: 8_000, buyAmount: 0, sellAmount: 0, netAmount: 640_000_000_000 }],
      skippedRows: 0,
    },
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${ALT_CODE}/program-trades`, {
    body: { symbol: ALT_CODE, date: "20261126", points: [], skippedRows: 0 },
  });
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/brokers`, (request) => {
    const date = new URL(request.url()).searchParams.get("date");
    if (date === ARCHIVE_DATE) return { body: ARCHIVE_BROKER_DAY };
    if (date === DATE) return { body: BROKER_DAY };
    return { body: { symbol: CODE, date: date ?? "20261126", source: "none", snapshots: [], gaps: [], live: true, cursor: "", reset: true } };
  });
  scenario.reply((url) => url.pathname === `/api/symbols/${ALT_CODE}/brokers`, {
    body: { symbol: ALT_CODE, date: "20261126", source: "none", snapshots: [], gaps: [], live: true, cursor: "", reset: true },
  });
  pinQuote(scenario, CODE, 79_900, 1_000);
  pinQuote(scenario, ALT_CODE, 190_500, 500);
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/day-summary`, () => {
    const quote = scenario.market.quote(CODE, "combined");
    return { body: quote ? daySummaryOf({ ...quote, price: 79_900, change: 1_000 }) : null };
  });
  scenario.on((url) => url.pathname === `/api/symbols/${ALT_CODE}/day-summary`, () => {
    const quote = scenario.market.quote(ALT_CODE, "combined");
    return { body: quote ? daySummaryOf({ ...quote, price: 190_500, change: 500 }) : null };
  });
  return api;
}

async function rightClickBar(page: Page, unixTime: number) {
  const pos = await page.evaluate((t) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    if (!probe) throw new Error("차트 프로브가 없습니다");
    const x = probe.chart.timeScale().timeToCoordinate(t);
    const box = probe.chart.chartElement().getBoundingClientRect();
    if (x === null || x < 0 || x > probe.chart.timeScale().width()) throw new Error("봉이 차트 화면 밖입니다");
    return { x: box.x + x, y: box.y + box.height * 0.5 };
  }, toChartTime(unixTime));
  await page.mouse.click(pos.x, pos.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

const replayToggle = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "호가 복기", exact: true });
const chartHost = (page: Page) => cell(page).locator("[data-bar-count]");
const dock = (page: Page) => page.getByTestId("tick-replay-dock");
const bookWin = (page: Page) => page.getByTestId("book-window");
const orderWin = (page: Page) => page.getByTestId("order-window");
const tradesWin = (page: Page) => page.getByTestId("trades-window");
const programWin = (page: Page) => page.getByTestId("program-window");
const brokersWin = (page: Page) => page.getByTestId("brokers-window");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installChartProbe);
});

test("분봉 차트 우클릭 메뉴는 수집일에 틱 복기 2항목을 맨 앞에 활성으로, 미수집일에는 비활성 사유와 함께 보인다", async ({ page, scenario }) => {
  seedSixWindowLayout(scenario);
  seedTickReplayMarket(scenario);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const collectedMenu = await rightClickBar(page, at(MIDNIGHT, 9, 2));
  const collectedItems = collectedMenu.getByRole("menuitem");
  await expect(collectedItems.nth(0)).toContainText("이 날 처음부터 틱 복기");
  await expect(collectedItems.nth(0)).toContainText("11-25");
  await expect(collectedItems.nth(0)).toBeEnabled();
  await expect(collectedItems.nth(1)).toContainText("이 시각부터 틱 복기");
  await expect(collectedItems.nth(1)).toContainText("09:02");
  await expect(collectedItems.nth(1)).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(collectedMenu).toBeHidden();

  const uncollectedMenu = await rightClickBar(page, at(UNCOLLECTED_MIDNIGHT, 9, 0));
  const uncollectedItems = uncollectedMenu.getByRole("menuitem");
  await expect(uncollectedItems.nth(0)).toContainText("이 날 처음부터 틱 복기");
  await expect(uncollectedItems.nth(0)).toBeDisabled();
  await expect(uncollectedItems.nth(0)).toContainText("수집 데이터 없음");
  await expect(uncollectedItems.nth(1)).toContainText("이 시각부터 틱 복기");
  await expect(uncollectedItems.nth(1)).toBeDisabled();
  await expect(uncollectedItems.nth(1)).toContainText("수집 데이터 없음");
});

test("틱 복기 재생은 호가 복기를 끄고 떠 있는 리모콘·분봉 자라남·5개 연동창·주문 잠금·분봉 주기 전환을 동기화한다", async ({ page, scenario }) => {
  seedSixWindowLayout(scenario);
  const api = seedTickReplayMarket(scenario);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(bookWin(page)).toBeVisible();
  await expect(orderWin(page)).toBeVisible();
  await expect(tradesWin(page)).toBeVisible();
  await expect(programWin(page)).toBeVisible();
  await expect(brokersWin(page)).toBeVisible();

  await replayToggle(page).click();
  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "true");

  const chartBoxBefore = (await cell(page).boundingBox())!;
  const bookBoxBefore = (await bookWin(page).boundingBox())!;

  const menu = await rightClickBar(page, at(MIDNIGHT, 9, 2));
  await menu.getByRole("menuitem", { name: /이 날 처음부터 틱 복기/ }).click();

  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(dock(page)).toBeVisible();
  await expect(dock(page).getByTestId("tick-replay-buffering")).toHaveCount(0);
  await expect(chartHost(page)).toHaveAttribute("data-tick-replay", "active");

  const chartBoxAfter = (await cell(page).boundingBox())!;
  const bookBoxAfter = (await bookWin(page).boundingBox())!;
  expect(Math.abs(chartBoxAfter.x - chartBoxBefore.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(chartBoxAfter.y - chartBoxBefore.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(chartBoxAfter.width - chartBoxBefore.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(chartBoxAfter.height - chartBoxBefore.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(bookBoxAfter.width - bookBoxBefore.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(bookBoxAfter.height - bookBoxBefore.height)).toBeLessThanOrEqual(1);

  const dockBoxBefore = (await dock(page).boundingBox())!;
  const gripBox = (await dock(page).getByTestId("tick-replay-drag-handle").boundingBox())!;
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2 - 120, gripBox.y + gripBox.height / 2 - 80, { steps: 4 });
  await page.mouse.up();
  const dockBoxAfter = (await dock(page).boundingBox())!;
  expect(dockBoxAfter.x).toBeLessThan(dockBoxBefore.x - 40);
  expect(dockBoxAfter.y).toBeLessThan(dockBoxBefore.y - 40);

  await expect(dock(page).getByTestId("tick-replay-play")).toHaveAttribute("data-playing", "true");
  await page.keyboard.press("Space");
  await expect(dock(page).getByTestId("tick-replay-play")).toHaveAttribute("data-playing", "false");

  await expect(bookWin(page)).toHaveAttribute("data-replay", "past");
  await expect(bookWin(page).getByTestId("book-total-ask")).toHaveText("7,600");
  await expect(orderWin(page)).toHaveAttribute("data-replay", "past");
  await expect(orderWin(page)).toHaveAttribute("data-replay-locked", "");
  await expect(programWin(page)).toHaveAttribute("data-replay", "past");
  await expect(programWin(page).getByTestId("program-net-qty")).toHaveText("+1,200");
  await expect(brokersWin(page)).toHaveAttribute("data-replay", "past");

  await cellAt(page, "buy", 71_000).dblclick();
  expect(api.writes).toEqual([]);

  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "3");

  await dock(page).getByTestId("tick-replay-step-next").click();
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText("09:00:15.000");
  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "4");
  await expect(chartHost(page)).toHaveAttribute("data-last-close", "71000");
  await expect(chartHost(page)).toHaveAttribute("data-last-volume", "100");
  await expect(tradesWin(page)).toHaveAttribute("data-replay", "past");
  await expect(tradesWin(page).getByTestId("trade-row")).toHaveCount(1);
  await expect(tradesWin(page).getByTestId("trade-cumulative")).toHaveText("100");

  await page.keyboard.press("ArrowRight");
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText("09:00:40.000");
  await expect(bookWin(page).getByTestId("book-total-ask")).toHaveText("7,800");

  await dock(page).getByTestId("tick-replay-step-next").click();
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText("09:00:45.000");
  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "4");
  await expect(chartHost(page)).toHaveAttribute("data-last-close", "71200");
  await expect(chartHost(page)).toHaveAttribute("data-last-high", "71200");
  await expect(chartHost(page)).toHaveAttribute("data-last-volume", "900");
  await expect(tradesWin(page).getByTestId("trade-row")).toHaveCount(2);
  await expect(tradesWin(page).getByTestId("trade-cumulative")).toHaveText("900");

  await dock(page).getByTestId("tick-replay-step-next").click();
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText("09:01:20.000");
  await expect(programWin(page).getByTestId("program-net-qty")).toHaveText("+2,600");
  await expect(brokersWin(page).getByTestId("brokers-time")).toHaveText("09:01");
  const morganCard = brokersWin(page).getByTestId("broker-card").and(page.locator('[data-broker="모건스탠리"]'));
  await expect(morganCard.getByTestId("broker-cumulative")).toHaveText("+3,500");

  await dock(page).getByTestId("tick-replay-step-next").click();
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText("09:01:25.000");
  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "5");
  await expect(chartHost(page)).toHaveAttribute("data-last-close", "71300");

  await dock(page).getByTestId("tick-replay-time-speeds").getByRole("button", { name: "30x", exact: true }).click();
  await expect(dock(page).getByTestId("tick-replay-time-speeds").getByRole("button", { name: "30x", exact: true })).toHaveAttribute("aria-pressed", "true");

  await dock(page).getByTestId("tick-replay-mode-switch").getByRole("button", { name: "틱", exact: true }).click();
  await expect(dock(page).getByTestId("tick-replay-tick-rates")).toBeVisible();
  await dock(page).getByTestId("tick-replay-tick-rates").getByRole("button", { name: "15틱/s", exact: true }).click();
  await expect(dock(page).getByTestId("tick-replay-tick-rates").getByRole("button", { name: "15틱/s", exact: true })).toHaveAttribute("aria-pressed", "true");

  const scrubberBox = (await dock(page).getByTestId("tick-replay-scrubber").boundingBox())!;
  await page.mouse.click(scrubberBox.x + scrubberBox.width * 0.005, scrubberBox.y + scrubberBox.height / 2);
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText(/^09:0[1-4]:/);

  await dock(page).getByTestId("tick-replay-step-next").click();
  const clockBeforePeriodSwitch = (await dock(page).getByTestId("tick-replay-clock").textContent())!;
  await cell(page).click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("Digit5");
  await expect(cell(page)).toHaveAttribute("aria-label", / 5분$/);
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText(clockBeforePeriodSwitch);
  await expect(chartHost(page)).toHaveAttribute("data-tick-replay", "active");
  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "3");
  await expect(chartHost(page)).toHaveAttribute("data-last-volume", "1450");

  await page.keyboard.press("Digit3");
  await expect(cell(page)).toHaveAttribute("aria-label", / 3분$/);
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText(clockBeforePeriodSwitch);
  await expect(chartHost(page)).toHaveAttribute("data-tick-replay", "active");
  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "3");
});

test("호갑플레이 아카이브 날짜에서 틱 복기를 시작하면 KRX 단독 배지를 보이고 정상 재생한다", async ({ page, scenario }) => {
  seedSixWindowLayout(scenario);
  seedTickReplayMarket(scenario);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const menu = await rightClickBar(page, at(ARCHIVE_MIDNIGHT, 9, 0));
  await menu.getByRole("menuitem", { name: /이 날 처음부터 틱 복기/ }).click();

  await expect(dock(page)).toBeVisible();
  await expect(dock(page).getByTestId("tick-replay-buffering")).toHaveCount(0);
  await expect(dock(page).getByTestId("tick-replay-archive-badge")).toHaveText("KRX 단독");
  await expect(bookWin(page).getByTestId("replay-archive-badge")).toHaveText("KRX 단독");

  await dock(page).getByTestId("tick-replay-step-next").click();
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText("09:00:15.000");
  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "1");
  await expect(chartHost(page)).toHaveAttribute("data-last-close", "70200");
  await expect(tradesWin(page).getByTestId("trade-row")).toHaveCount(1);
  await expect(cell(page).getByText("분봉은 최근 1년까지 볼 수 있습니다")).toHaveCount(0);
});

test("실시간 복귀 버튼, Esc 키, 연동 그룹 종목 변경으로 틱 복기가 즉시 종료되고 실시간으로 돌아온다", async ({ page, scenario }) => {
  seedSixWindowLayout(scenario);
  seedTickReplayMarket(scenario);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "9");

  const menu1 = await rightClickBar(page, at(MIDNIGHT, 9, 0));
  await menu1.getByRole("menuitem", { name: /이 날 처음부터 틱 복기/ }).click();
  await expect(dock(page)).toBeVisible();
  await expect(chartHost(page)).toHaveAttribute("data-tick-replay", "active");

  await dock(page).getByTestId("tick-replay-exit").click();
  await expect(dock(page)).toHaveCount(0);
  await expect(chartHost(page)).not.toHaveAttribute("data-tick-replay");
  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "9");
  await expect(bookWin(page)).not.toHaveAttribute("data-replay");
  await expect(orderWin(page)).not.toHaveAttribute("data-replay-locked");

  const menu2 = await rightClickBar(page, at(MIDNIGHT, 9, 2));
  await menu2.getByRole("menuitem", { name: /이 시각부터 틱 복기/ }).click();
  await expect(dock(page)).toBeVisible();
  await expect(dock(page).getByTestId("tick-replay-clock")).toContainText("09:02:");

  await page.keyboard.press("Escape");
  await expect(dock(page)).toHaveCount(0);
  await expect(chartHost(page)).not.toHaveAttribute("data-tick-replay");
  await expect(bookWin(page)).not.toHaveAttribute("data-replay");

  const menu3 = await rightClickBar(page, at(MIDNIGHT, 9, 0));
  await menu3.getByRole("menuitem", { name: /이 날 처음부터 틱 복기/ }).click();
  await expect(dock(page)).toBeVisible();
  await expect(dock(page).getByTestId("tick-replay-buffering")).toHaveCount(0);

  await page.getByRole("button", { name: "종목·지표·명령 찾기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill(ALT_CODE);
  const altOption = dialog.getByRole("option").filter({ hasText: ALT_CODE }).first();
  await altOption.click();
  await expect(dialog).toBeHidden();

  await expect(dock(page)).toHaveCount(0);
  await expect(chartHost(page)).not.toHaveAttribute("data-tick-replay");
  await expect(bookWin(page)).toHaveAttribute("data-symbol", ALT_CODE);
  await expect(bookWin(page)).not.toHaveAttribute("data-replay");
});

test("이 날 처음부터 틱 복기는 장전 첫 수집 틱(08:00~)에서 시작하고 리모콘 빈 영역 드래그와 경계 클램프가 동작한다", async ({ page, scenario }) => {
  const m480 = 480 * 60_000;
  const nxtMeta: BookReplayMeta = {
    ...REPLAY_META_TICK,
    covered: [[480, 1199]],
    spans: [{ startMinute: 480, bookRows: 2, tradeRows: 1, programRows: 0 }],
    minutes: [
      {
        minute: 480,
        open: 70_500,
        high: 70_600,
        low: 70_500,
        close: 70_600,
        volume: 150,
        cumVol: 0,
        cumVal: 0,
        cumBuyQty: 0,
        cumSellQty: 0,
        dayOpen: null,
        dayHigh: null,
        dayLow: null,
        totalAsk: 3_400,
        totalBid: 2_900,
        programNetQty: null,
        programNetAmtMillion: null,
        singlePrice: false,
      },
    ],
  };
  const nxtSpanBytes = new Uint8Array(
    encodeHogaSpan({
      date: 20261125,
      startMinute: 480,
      lengthMinutes: 5,
      symbol: `${CODE}_AL`,
      streams: [
        {
          kind: "book",
          columns: {
            recv_ms: [m480 + 5_000, m480 + 25_000],
            t_s: [28_805, 28_825],
            ask_px1: [70_600, 70_700],
            ask_px2: [70_700, 70_800],
            ask_px3: [70_800, 70_900],
            ask_px4: [70_900, 71_000],
            bid_px1: [70_500, 70_600],
            bid_px2: [70_400, 70_500],
            bid_px3: [70_300, 70_400],
            bid_px4: [70_200, 70_300],
            ask_qty1: [800, 900],
            ask_qty2: [800, 800],
            ask_qty3: [900, 900],
            ask_qty4: [900, 900],
            bid_qty1: [700, 800],
            bid_qty2: [700, 700],
            bid_qty3: [700, 700],
            bid_qty4: [800, 800],
            ask_total: [3_400, 3_500],
            bid_total: [2_900, 3_000],
          },
        },
        {
          kind: "trades",
          columns: {
            recv_ms: [m480 + 18_000],
            t_s: [28_818],
            price: [70_600],
            qty: [150],
            venue: [2],
          },
        },
      ],
    }),
  );

  seedSixWindowLayout(scenario);
  seedTickReplayMarket(scenario, { meta: nxtMeta, spanStart: 480, spanBytes: nxtSpanBytes });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const menu = await rightClickBar(page, at(MIDNIGHT, 9, 2));
  await menu.getByRole("menuitem", { name: /이 날 처음부터 틱 복기/ }).click();

  await expect(dock(page)).toBeVisible();
  await expect(dock(page).getByTestId("tick-replay-buffering")).toHaveCount(0);
  await page.keyboard.press("Space");
  await expect(dock(page).getByTestId("tick-replay-play")).toHaveAttribute("data-playing", "false");

  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText(/^08:00:0[5-9]\./);
  await expect(dock(page).getByTestId("tick-replay-session")).toHaveText("장전");
  await expect(dock(page).locator(".trd-scrub-edge").nth(0)).toHaveText("08:00");
  await expect(dock(page).locator(".trd-scrub-edge").nth(1)).toHaveText("20:00");
  await expect(bookWin(page).getByTestId("book-total-ask")).toHaveText("3,400");

  await dock(page).getByTestId("tick-replay-step-next").click();
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText("08:00:18.000");

  const workspaceBox = (await page.locator("main.workspace").boundingBox())!;
  const beforeDrag = (await dock(page).boundingBox())!;
  const symbolBox = (await dock(page).getByTestId("tick-replay-symbol").boundingBox())!;

  await page.mouse.move(symbolBox.x + symbolBox.width / 2, symbolBox.y + symbolBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(symbolBox.x + symbolBox.width / 2 - 140, symbolBox.y + symbolBox.height / 2 - 120, { steps: 5 });
  await page.mouse.up();

  const afterHeaderDrag = (await dock(page).boundingBox())!;
  expect(afterHeaderDrag.x).toBeLessThan(beforeDrag.x - 80);
  expect(afterHeaderDrag.y).toBeLessThan(beforeDrag.y - 80);

  const emptySpot = { x: afterHeaderDrag.x + afterHeaderDrag.width - 140, y: afterHeaderDrag.y + 14 };
  await page.mouse.move(emptySpot.x, emptySpot.y);
  await page.mouse.down();
  await page.mouse.move(workspaceBox.x - 500, workspaceBox.y - 500, { steps: 5 });
  await page.mouse.up();

  const clampedTopLeft = (await dock(page).boundingBox())!;
  expect(clampedTopLeft.x).toBeGreaterThanOrEqual(workspaceBox.x + 7);
  expect(clampedTopLeft.y).toBeGreaterThanOrEqual(workspaceBox.y + 7);
  expect(clampedTopLeft.x).toBeLessThanOrEqual(workspaceBox.x + 12);
  expect(clampedTopLeft.y).toBeLessThanOrEqual(workspaceBox.y + 12);

  await page.mouse.move(clampedTopLeft.x + clampedTopLeft.width - 140, clampedTopLeft.y + 14);
  await page.mouse.down();
  await page.mouse.move(workspaceBox.x + workspaceBox.width + 500, workspaceBox.y + workspaceBox.height + 500, { steps: 5 });
  await page.mouse.up();

  const clampedBottomRight = (await dock(page).boundingBox())!;
  expect(clampedBottomRight.x + clampedBottomRight.width).toBeLessThanOrEqual(workspaceBox.x + workspaceBox.width - 7);
  expect(clampedBottomRight.y + clampedBottomRight.height).toBeLessThanOrEqual(workspaceBox.y + workspaceBox.height - 7);

  await dock(page).getByTestId("tick-replay-step-next").click();
  await expect(dock(page).getByTestId("tick-replay-clock")).toHaveText("08:00:25.000");
  await expect(bookWin(page).getByTestId("book-total-ask")).toHaveText("3,500");
});

test("틱 복기 재생 중에 과거로 스크롤해도 1년 이내 과거 분봉을 정상 불러오고 가짜 1년 안내를 띄우지 않는다", async ({ page, scenario }) => {
  const olderDayMidnight = Date.parse("2026-11-20T00:00:00+09:00") / 1000;
  const recentPriorBars: Bar[] = Array.from({ length: 70 }, (_, idx) => ({
    t: at(ARCHIVE_MIDNIGHT, 9, idx),
    o: 70_000 + idx * 10,
    h: 70_100 + idx * 10,
    l: 69_900 + idx * 10,
    c: 70_050 + idx * 10,
    v: 200,
  }));
  const olderBars: Bar[] = Array.from({ length: 15 }, (_, idx) => ({
    t: at(olderDayMidnight, 14, idx),
    o: 68_000 + idx * 10,
    h: 68_100 + idx * 10,
    l: 67_900 + idx * 10,
    c: 68_050 + idx * 10,
    v: 150,
  }));
  const initialBars = [...recentPriorBars, ...BARS_1M.slice(3)];
  let olderRequests = 0;

  seedSixWindowLayout(scenario);
  seedTickReplayMarket(scenario, {
    bars1m: initialBars,
    nextBefore: at(ARCHIVE_MIDNIGHT, 9, 0),
    olderPage: {
      bars: olderBars,
      nextBefore: at(olderDayMidnight, 13, 59),
    },
  });
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/api/bars" && url.searchParams.get("symbol") === CODE && url.searchParams.has("before")) {
      olderRequests += 1;
    }
  });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const menu = await rightClickBar(page, at(MIDNIGHT, 9, 2));
  await menu.getByRole("menuitem", { name: /이 날 처음부터 틱 복기/ }).click();

  await expect(dock(page)).toBeVisible();
  await expect(dock(page).getByTestId("tick-replay-buffering")).toHaveCount(0);
  await page.keyboard.press("Space");
  await expect(dock(page).getByTestId("tick-replay-play")).toHaveAttribute("data-playing", "false");
  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "70");
  expect(olderRequests).toBe(0);

  await page.evaluate(() => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    if (!probe) throw new Error("차트 프로브가 없습니다");
    probe.chart.timeScale().setVisibleLogicalRange({ from: -1, to: 18 });
  });

  await expect.poll(() => olderRequests).toBeGreaterThanOrEqual(1);
  await expect(chartHost(page)).toHaveAttribute("data-bar-count", "85");
  await expect(cell(page).getByText("분봉은 최근 1년까지 볼 수 있습니다")).toHaveCount(0);
});
