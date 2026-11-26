import type { Bar } from "../src/api/generated/Bar";
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

test("가상 매매 시뮬레이션 주문·미체결·체결·되감기 복원과 틱 Δt 고정폭이 동작한다", async ({ page, scenario }) => {
  seedTickReplay(scenario);
  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);

  await expect(page.getByTestId("replay-page")).toBeVisible();
  await expect(page.getByTestId("replay-total-ask")).toHaveText("7,600");

  await page.getByTestId("replay-mode-switch").getByRole("button", { name: "틱 단위", exact: true }).click();
  const dtPill = page.getByTestId("replay-tick-dt");
  await expect(dtPill).toBeVisible();
  const dtWidthBefore = (await dtPill.boundingBox())!.width;

  await page.getByRole("button", { name: "+1틱", exact: true }).click();
  await expect(page.getByTestId("replay-clock")).toHaveText("09:00:10.250");
  const dtWidthAfter = (await dtPill.boundingBox())!.width;
  expect(Math.abs(dtWidthAfter - dtWidthBefore)).toBeLessThanOrEqual(0.5);

  const qtyInput = page.getByTestId("replay-sim-qty-input");
  await qtyInput.fill("10");
  await page.locator('[data-testid="replay-sim-buy-cell"][data-price="71100"]').click();
  await expect(page.getByTestId("replay-sim-qty")).toHaveText("10주");
  await expect(page.getByTestId("replay-sim-avg")).toHaveText("71,100원");
  await expect(page.getByTestId("replay-sim-avg-dot")).toBeVisible();

  await page.locator('[data-testid="replay-sim-buy-cell"][data-price="70900"]').click();
  await expect(page.locator('[data-testid="replay-sim-chip"][data-side="buy"][data-price="70900"]')).toHaveText("10");

  await page.getByTestId("replay-tab-journal").click();
  await expect(page.getByTestId("replay-sim-fill-row")).toHaveCount(1);

  await page.getByTestId("replay-sim-flatten").click();
  await expect(page.getByTestId("replay-sim-qty")).toHaveText("0주");
  await expect(page.getByTestId("replay-sim-fill-row")).toHaveCount(2);

  await page.getByRole("button", { name: "-1틱", exact: true }).click();
  await expect(page.getByTestId("replay-sim-undo-rewind")).toBeVisible();
  await expect(page.getByTestId("replay-sim-fill-row")).toHaveCount(0);

  await page.getByTestId("replay-sim-undo-rewind").click();
  await expect(page.getByTestId("replay-sim-fill-row")).toHaveCount(2);

  await page.getByTestId("replay-sim-reset").click();
  await expect(page.getByTestId("replay-sim-qty")).toHaveText("0주");
  await expect(page.getByTestId("replay-sim-fill-row")).toHaveCount(0);
});

test("전량 매수 가격별 주문, 총 자산 원 표기, 총잔량 중앙 시각, 분봉 주기 전환과 재생 버튼 대비가 동작한다", async ({ page, scenario }) => {
  seedTickReplay(scenario);
  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);

  await expect(page.getByTestId("replay-page")).toBeVisible();
  await expect(page.getByTestId("replay-sim-equity")).toHaveText("30,000,000원 (0.00%)");
  await expect(page.getByTestId("replay-ladder-clock")).toHaveText("09:00:00");
  await expect(page.getByTestId("replay-ladder").getByText("매도 총잔량")).toHaveCount(0);
  await expect(page.getByTestId("replay-ladder").getByText("매수 총잔량")).toHaveCount(0);

  await page.getByRole("button", { name: "+1틱", exact: true }).click();
  await expect(page.getByTestId("replay-ladder-clock")).toHaveText("09:00:10");

  await page.getByRole("group", { name: "프리셋 기준" }).getByRole("button", { name: "매수", exact: true }).click();
  await page.getByRole("group", { name: "주문 수량 프리셋" }).getByRole("button", { name: "전량", exact: true }).click();

  const higherAskBuyCell = page.locator('[data-testid="replay-sim-buy-cell"][data-price="71300"]');
  await expect(higherAskBuyCell.locator(".od-preview")).toHaveText("매수 420");
  await expect(higherAskBuyCell.locator(".od-preview")).not.toHaveAttribute("data-over", "");
  await higherAskBuyCell.click();
  await expect(page.getByTestId("replay-sim-qty")).toHaveText("420주");
  await expect(page.getByTestId("replay-sim-status")).toHaveAttribute("data-tone", "ok");

  const brokers = page.getByTestId("replay-brokers");
  await brokers.getByTestId("replay-broker-view-table").click();
  await expect(brokers.getByTestId("replay-broker-table")).toBeVisible();
  await expect(brokers.getByTestId("replay-broker-table-row")).toHaveCount(5);
  await expect(brokers.getByTestId("replay-broker-table-stamp")).toContainText("첫 스냅샷");

  await page.getByRole("button", { name: "+1m", exact: true }).click();
  await expect(brokers.getByTestId("replay-broker-sell-name").first()).toContainText("NH투자");
  await expect(brokers.getByTestId("replay-broker-sell-qty").first()).toHaveText("1,200");
  await expect(brokers.getByTestId("replay-broker-buy-name").first()).toContainText("모건스탠리");
  await expect(brokers.getByTestId("replay-broker-buy-qty").first()).toHaveText("2,400");
  await expect(brokers.getByTestId("replay-broker-table-foreign")).toContainText("+2,400");

  await page.getByRole("button", { name: "+1m", exact: true }).click();
  await expect(brokers.getByTestId("replay-broker-sell-qty").first()).toHaveText("1,800");
  await expect(brokers.getByTestId("replay-broker-buy-qty").first()).toHaveText("3,500");
  await expect(brokers.getByTestId("replay-broker-table-foreign")).toContainText("+3,500");

  await page.getByTestId("replay-chart-timeframe").getByRole("button", { name: "5분", exact: true }).click();
  await expect(page.getByTestId("replay-main-chart")).toHaveAttribute("data-timeframe", "5");

  const mainChart = page.getByTestId("replay-main-chart");
  const box = (await mainChart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.wheel(0, -120);
  await page.mouse.dblclick(box.x + box.width * 0.4, box.y + box.height * 0.5);

  await page.evaluate(() => document.documentElement.setAttribute("data-style", "bento"));
  const playBg = await page.getByTestId("replay-play").evaluate((el) => getComputedStyle(el).backgroundColor);
  const raisedBg = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--raised)";
    document.body.appendChild(probe);
    const val = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return val;
  });
  expect(playBg).not.toBe(raisedBg);
});
