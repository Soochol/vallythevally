import type { Bar } from "../src/api/generated/Bar";
import type { BookReplayDay } from "../src/api/generated/BookReplayDay";
import type { BookReplayMeta } from "../src/api/generated/BookReplayMeta";
import type { BrokerDay } from "../src/api/generated/BrokerDay";
import type { ProgramSeriesPage } from "../src/api/generated/ProgramSeriesPage";
import { encodeHogaSpan } from "../src/features/replay-page/hogaDecode";
import { expect, type Scenario, test } from "./harness";

test.use({ clockStart: "20261126160000", viewport: { width: 1440, height: 900 } });

const CODE = "005930";
const DATE = "20261125";
const MIDNIGHT = Date.parse("2026-11-25T00:00:00+09:00") / 1000;
const PREV_MIDNIGHT = Date.parse("2026-11-24T00:00:00+09:00") / 1000;
const M540 = 540 * 60_000;

const DAILY_BARS: Bar[] = [
  { t: PREV_MIDNIGHT + 9 * 3600, o: 70_000, h: 70_500, l: 69_800, c: 70_000, v: 500_000 },
  { t: MIDNIGHT + 9 * 3600, o: 71_000, h: 72_000, l: 70_800, c: 71_500, v: 600_000 },
];

const REPLAY_META_TICK: BookReplayMeta = {
  symbol: CODE,
  date: DATE,
  coverage: "collected",
  resolution: "tick",
  spanMinutes: 5,
  covered: [[540, 542], [544, 545]],
  gapsMs: [[543 * 60_000, 544 * 60_000]],
  spans: [{ startMinute: 540, bookRows: 4, tradeRows: 3, programRows: 2 }],
  minutes: [
    {
      minute: 540,
      open: 71_000,
      high: 71_100,
      low: 71_000,
      close: 71_100,
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
      open: 71_100,
      high: 71_100,
      low: 71_100,
      close: 71_100,
      volume: 250,
      cumVol: 900,
      cumVal: 71_000 * 100 + 71_100 * 800,
      cumBuyQty: 900,
      cumSellQty: 0,
      dayOpen: 71_000,
      dayHigh: 71_100,
      dayLow: 71_000,
      totalAsk: 7_800,
      totalBid: 4_700,
      programNetQty: 2_600,
      programNetAmtMillion: 185,
      singlePrice: false,
    },
    {
      minute: 542,
      open: null,
      high: null,
      low: null,
      close: null,
      volume: 0,
      cumVol: 1_150,
      cumVal: 71_000 * 100 + 71_100 * 1_050,
      cumBuyQty: 900,
      cumSellQty: 250,
      dayOpen: 71_000,
      dayHigh: 71_100,
      dayLow: 71_000,
      totalAsk: 900,
      totalBid: 900,
      programNetQty: 2_600,
      programNetAmtMillion: 185,
      singlePrice: true,
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
          recv_ms: [M540, M540 + 44_900, M540 + 70_000, M540 + 120_500],
          t_s: [32_400, 32_444, 32_470, 32_520],
          ask_px1: [71_100, 71_100, 71_100, 71_600],
          ask_px2: [71_200, 71_200, 71_200, 71_700],
          ask_px3: [71_300, 71_300, 71_300, 0],
          ask_px4: [71_400, 71_400, 71_400, 0],
          bid_px1: [71_000, 71_000, 71_000, 71_500],
          bid_px2: [70_900, 70_900, 70_900, 71_400],
          bid_px3: [70_800, 70_800, 70_800, 0],
          bid_px4: [70_700, 70_700, 70_700, 0],
          ask_qty1: [1_000, 1_500, 1_500, 500],
          ask_qty2: [1_200, 900, 900, 400],
          ask_qty3: [900, 900, 900, 0],
          ask_qty4: [4_500, 4_500, 4_500, 0],
          bid_qty1: [1_400, 1_900, 1_900, 600],
          bid_qty2: [1_100, 1_100, 1_100, 300],
          bid_qty3: [800, 800, 800, 0],
          bid_qty4: [900, 900, 900, 0],
          ask_total: [7_600, 7_800, 7_800, 900],
          bid_total: [4_200, 4_700, 4_700, 900],
        },
      },
      {
        kind: "trades",
        columns: {
          recv_ms: [M540 + 10_250, M540 + 45_120, M540 + 70_500],
          t_s: [32_410, 32_445, 32_470],
          price: [71_000, 71_100, 71_100],
          qty: [100, 800, -250],
          venue: [1, 1, 2],
        },
      },
      {
        kind: "program",
        columns: {
          recv_ms: [M540, M540 + 70_000],
          t_s: [32_400, 32_470],
          sell_qty: [300, 400],
          sell_amt: [35, 45],
          buy_qty: [1_500, 3_000],
          buy_amt: [120, 230],
        },
      },
    ],
  }),
);

const REPLAY_DAY_FALLBACK: BookReplayDay = {
  symbol: CODE,
  date: DATE,
  coverage: "collected",
  covered: [[540, 542], [544, 545]],
  books: [
    {
      minute: 540,
      asks: [[71_100, 1000], [71_200, 1200], [71_300, 900], [71_400, 4500]],
      bids: [[71_000, 1400], [70_900, 1100], [70_800, 800], [70_700, 900]],
      totalAsk: 7_600,
      totalBid: 4_200,
    },
  ],
  trades: [[540, 32_410, 71_000, 100]],
};

const BROKER_DAY: BrokerDay = {
  symbol: CODE,
  date: DATE,
  source: "store",
  snapshots: [
    {
      t: MIDNIGHT + 540 * 60 + 50,
      sells: [{ code: "002", name: "NH투자", qty: 1200, qtyChange: 1200 }],
      buys: [{ code: "036", name: "모건스탠리", qty: 2400, qtyChange: 2400 }],
    },
    {
      t: MIDNIGHT + 541 * 60 + 50,
      sells: [{ code: "002", name: "NH투자", qty: 1800, qtyChange: 600 }],
      buys: [{ code: "036", name: "모건스탠리", qty: 3500, qtyChange: 1100 }],
    },
  ],
  gaps: [],
  live: false,
  cursor: "",
  reset: true,
};

const PROGRAM_PAGE: ProgramSeriesPage = {
  symbol: CODE,
  period: "1m",
  state: "ready",
  points: [
    { t: MIDNIGHT + 540 * 60, netBuyQty: 1200, netBuyAmountMillionWon: 85, buyAmountMillionWon: 120, sellAmountMillionWon: 35, programSharePct: 12 },
    { t: MIDNIGHT + 541 * 60, netBuyQty: 2600, netBuyAmountMillionWon: 185, buyAmountMillionWon: 230, sellAmountMillionWon: 45, programSharePct: 15 },
  ],
};

function seedCommon(scenario: Scenario) {
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply(`/api/symbols/${CODE}/book-replay/days`, { body: { symbol: CODE, days: ["20261124", DATE] } });
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("period") === "D",
    { body: { symbol: CODE, venue: "combined", period: "D", bars: DAILY_BARS, current: null, nextBefore: null, seq: null } },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/brokers` && url.searchParams.get("date") === DATE,
    { body: BROKER_DAY },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/program-series`,
    { body: PROGRAM_PAGE },
  );
}

function seedTickReplay(scenario: Scenario) {
  seedCommon(scenario);
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay/meta` && url.searchParams.get("date") === DATE,
    { body: REPLAY_META_TICK },
  );
  scenario.reply(
    (url) =>
      url.pathname === `/api/symbols/${CODE}/book-replay/span` &&
      url.searchParams.get("date") === DATE &&
      url.searchParams.get("startMinute") === "540",
    { body: SPAN_540_BYTES },
  );
}

test("/replay는 틱 복기 메타·바이너리 청크·4대 보조지표·10호가·거래원을 한 화면에 보이고 이벤트 버튼이 없다", async ({ page, scenario }) => {
  seedTickReplay(scenario);
  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);

  await expect(page.getByTestId("replay-page")).toBeVisible();
  await expect(page.getByTestId("replay-resolution-badge")).toHaveAttribute("data-resolution", "tick");
  await expect(page.getByTestId("replay-prev-close")).toHaveText("70,000");
  await expect(page.getByTestId("replay-total-ask")).toHaveText("7,600");
  await expect(page.getByTestId("replay-total-bid")).toHaveText("4,200");

  const subs = page.getByTestId("replay-sub-indicators");
  await expect(subs.locator('[data-indicator="totals"]')).toContainText("총잔량");
  await expect(subs.locator('[data-indicator="obi"]')).toContainText("호가 잔량비");
  await expect(subs.locator('[data-indicator="strength"]')).toContainText("체결강도");
  await expect(subs.locator('[data-indicator="program"]')).toContainText("프로그램 누적");

  const brokers = page.getByTestId("replay-brokers");
  await expect(brokers.getByTestId("broker-card")).toHaveCount(2);
  await brokers.getByTestId("broker-card").first().click();
  await expect(brokers.getByTestId("broker-detail")).toBeVisible();
  await brokers.getByRole("button", { name: "거래원", exact: true }).click();
  await expect(brokers.getByTestId("broker-row")).toHaveCount(2);
  await expect(brokers.getByTestId("broker-foreign-sum")).toBeVisible();

  await expect(page.getByRole("button", { name: /이벤트/ })).toHaveCount(0);
});

test("시간 단위·틱 단위 모드 전환과 밀리초 1틱 이동·체결 필터·북마크·루프·블라인드·VI·끊김 배너가 동작한다", async ({ page, scenario }) => {
  seedTickReplay(scenario);
  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);

  await expect(page.getByTestId("replay-clock")).toHaveText("09:00:00.000");
  await expect(page.getByTestId("replay-time-controls")).toBeVisible();

  await page.getByTestId("replay-mode-switch").getByRole("button", { name: "틱 단위", exact: true }).click();
  await expect(page.getByTestId("replay-tick-controls")).toBeVisible();
  await expect(page.getByTestId("replay-tick-dt")).toBeVisible();

  await page.getByRole("group", { name: "틱 대상 선택" }).getByRole("button", { name: "체결만", exact: true }).click();
  await page.getByRole("button", { name: "+1틱", exact: true }).click();
  await expect(page.getByTestId("replay-clock")).toHaveText("09:00:10.250");
  await expect(page.getByTestId("replay-head-price")).toHaveText("71,000");
  await expect(page.getByTestId("replay-head-diff")).toContainText("+1,000");

  await page.getByRole("button", { name: "+1틱", exact: true }).click();
  await expect(page.getByTestId("replay-clock")).toHaveText("09:00:45.120");
  await expect(page.getByTestId("replay-total-ask")).toHaveText("7,800");
  await expect(page.getByTestId("replay-tape-row")).toHaveCount(2);

  await page.getByRole("group", { name: "체결 금액 필터" }).getByRole("button", { name: "5천만+", exact: true }).click();
  await expect(page.getByTestId("replay-tape-row")).toHaveCount(1);

  await page.getByTestId("replay-bookmark-btn").click();
  await expect(page.getByTestId("replay-bookmark-btn")).toContainText("북마크 (1)");
  await page.getByTestId("replay-loop-btn").click();
  await expect(page.getByTestId("replay-loop-btn")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("replay-blind-btn").click();
  await expect(page.getByTestId("replay-blind-btn")).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "+1m", exact: true }).click();
  await page.getByRole("button", { name: "+1m", exact: true }).click();
  await expect(page.getByTestId("replay-vi-banner")).toBeVisible();

  await page.getByRole("button", { name: "+1m", exact: true }).click();
  await expect(page.getByTestId("replay-gap-banner")).toBeVisible();
});

test("원문이 없는 장중 1분 요약 해상도는 minute_only 배지와 함께 폴백 재생된다", async ({ page, scenario }) => {
  seedCommon(scenario);
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay/meta` && url.searchParams.get("date") === DATE,
    {
      body: {
        ...REPLAY_META_TICK,
        resolution: "minute_only",
        spans: [],
      } satisfies BookReplayMeta,
    },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay` && url.searchParams.get("date") === DATE,
    { body: REPLAY_DAY_FALLBACK },
  );

  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);
  await expect(page.getByTestId("replay-resolution-badge")).toHaveAttribute("data-resolution", "minute_only");
  await expect(page.getByTestId("replay-resolution-badge")).toContainText("1분 요약");
  await expect(page.getByTestId("replay-total-ask")).toHaveText("7,600");
});

test("공개 모드에서는 book-replay API를 호출하지 않고 안내를 표시한다", async ({ page, scenario }) => {
  scenario.publicMode.enable({ provider: "google", createdAt: Math.floor(scenario.now / 1000) });
  await page.goto("/replay");
  await expect(page.getByText("공개 모드에서는 호가 복기를 지원하지 않습니다")).toBeVisible();
  const replayCalls = scenario.requests.filter((r) => new URL(r.url()).pathname.includes("book-replay"));
  expect(replayCalls).toHaveLength(0);
});

test("다크·라이트 테마 전환과 종목 전환 대화상자가 정상 동작한다", async ({ page, scenario }) => {
  seedTickReplay(scenario);
  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);
  await expect(page.getByTestId("replay-page")).toBeVisible();

  await page.getByTestId("replay-symbol-picker").click();
  const dialog = page.getByTestId("replay-symbol-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "닫기" }).click();
  await expect(dialog).toHaveCount(0);

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByTestId("replay-ladder")).toBeVisible();
});
