import type { Bar } from "../src/api/generated/Bar";
import type { BookReplayMeta } from "../src/api/generated/BookReplayMeta";
import type { BrokerDay } from "../src/api/generated/BrokerDay";
import type { ProgramSeriesPage } from "../src/api/generated/ProgramSeriesPage";
import { encodeHogaSpan } from "../src/features/replay-page/hogaDecode";
import { expect, pollSaved, type Scenario, test } from "./harness";

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

test("/replay는 센터드 3열 콕핏·선택형 보조 흐름·체결/프로그램/거래원 탭·10호가를 보이고 상단 종목찾기·연동색이 없다", async ({ page, scenario }) => {
  seedTickReplay(scenario);
  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);

  await expect(page.getByTestId("replay-page")).toBeVisible();
  await expect(page.getByTestId("replay-resolution-badge")).toHaveAttribute("data-resolution", "tick");
  await expect(page.getByTestId("replay-prev-close")).toHaveText("70,000");
  await expect(page.getByTestId("replay-total-ask")).toHaveText("7,600");
  await expect(page.getByTestId("replay-total-bid")).toHaveText("4,200");

  const topbar = page.getByRole("toolbar", { name: "페이지 도구 막대" });
  await expect(topbar.getByRole("button", { name: "종목 찾기" })).toHaveCount(0);
  await expect(topbar.getByRole("button", { name: /^보낼 연동 색/ })).toHaveCount(0);
  await expect(page.locator(".page-frame[data-full-width]")).toBeVisible();

  const deckBox = (await page.getByTestId("replay-deck").boundingBox())!;
  const workspaceBox = (await page.getByTestId("replay-workspace").boundingBox())!;
  const chartBox = (await page.getByTestId("replay-slot-chart").boundingBox())!;
  const ladderSlotBox = (await page.getByTestId("replay-slot-ladder").boundingBox())!;
  const rightSlotBox = (await page.getByTestId("replay-slot-right").boundingBox())!;
  expect(deckBox.y + deckBox.height).toBeLessThanOrEqual(workspaceBox.y + 4);
  expect(chartBox.x).toBeLessThan(ladderSlotBox.x);
  expect(ladderSlotBox.x).toBeLessThan(rightSlotBox.x);

  const subs = page.getByTestId("replay-sub-indicators");
  await expect(subs.locator('[data-indicator="obi"]')).toContainText("호가 잔량비");
  await subs.locator('[data-indicator-tab="totals"]').click();
  await expect(subs.locator('[data-indicator="totals"]')).toContainText("총잔량");
  await subs.locator('[data-indicator-tab="strength"]').click();
  await expect(subs.locator('[data-indicator="strength"]')).toContainText("체결강도");
  await subs.locator('[data-indicator-tab="program"]').click();
  await expect(subs.locator('[data-indicator="program"]')).toContainText("프로그램 누적");
  await subs.locator('[data-indicator-tab="none"]').click();
  await expect(subs.locator("[data-indicator]")).toHaveCount(0);
  await subs.locator('[data-indicator-tab="obi"]').click();
  await expect(subs.locator('[data-indicator="obi"]')).toBeVisible();

  await expect(page.getByTestId("replay-tab-trades")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("replay-trades-pane")).toBeVisible();
  await expect(page.getByTestId("replay-trade-strength")).toHaveAttribute("data-dir", "up");
  await expect(page.getByTestId("replay-sim-status")).toHaveCount(0);
  await expect(page.getByTestId("replay-ladder")).toHaveClass(/\bod\b/);
  await expect(page.getByTestId("replay-ladder").locator(".mw-footer.od-footer .mw-strip-ratio")).toBeVisible();
  const ladderRowBox = (await page.getByTestId("replay-ladder").locator(".mw-lr").first().boundingBox())!;
  expect(ladderRowBox.height).toBeCloseTo(24, 0);

  await page.getByTestId("replay-tab-program").click();
  await expect(page.getByTestId("replay-program-pane")).toBeVisible();
  await expect(page.getByTestId("replay-program-net-qty")).toContainText("+1,200");
  await expect(page.getByTestId("replay-program-row")).toHaveCount(1);

  const progChangeHead = page.getByTestId("replay-program-pane").getByRole("columnheader", { name: "순매수 증감" });
  expect((await progChangeHead.boundingBox())!.height).toBeLessThanOrEqual(24);

  const spreadBadge = page.getByTestId("replay-spread");
  await expect(spreadBadge).toHaveText("스프레드 1틱 (100원)");
  const spreadClipped = await spreadBadge.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(spreadClipped).toBe(false);

  const ladderBox = (await page.locator(".rp-order-ladder").boundingBox())!;
  const bestAskBox = (await page.locator('[data-testid="replay-sim-buy-cell"][data-price="71100"]').boundingBox())!;
  const bestBidBox = (await page.locator('[data-testid="replay-sim-buy-cell"][data-price="71000"]').boundingBox())!;
  expect(bestAskBox.y).toBeGreaterThanOrEqual(ladderBox.y - 1);
  expect(bestBidBox.y + bestBidBox.height).toBeLessThanOrEqual(ladderBox.y + ladderBox.height + 1);

  await page.getByTestId("replay-tab-brokers").click();
  const brokersPane = page.getByTestId("replay-brokers-pane");
  const brokers = page.getByTestId("replay-brokers");
  await expect(brokersPane.getByTestId("replay-broker-view-transfer")).toHaveAttribute("aria-pressed", "true");
  await expect(brokers.getByTestId("broker-transfer-view")).toBeVisible();

  await brokersPane.getByTestId("replay-broker-view-board").click();
  await expect(brokersPane.getByRole("group", { name: "카드 모양" }).getByRole("button", { name: "숫자", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(brokers.getByTestId("broker-card")).toHaveCount(2);
  await expect(brokers.getByTestId("broker-numbers").first()).toHaveAttribute("data-mode", "numbers");
  await brokers.getByTestId("broker-card").first().click();
  await expect(brokers.getByTestId("broker-detail")).toBeVisible();

  await brokersPane.getByTestId("replay-broker-view-list").click();
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

  const firstTradeRow = page.getByTestId("replay-tape-row").first();
  const tradeTime = firstTradeRow.locator(".tr-time");
  const tradePrice = firstTradeRow.locator(".tr-price");
  await expect(tradeTime).toHaveText("09:00:45");
  await expect(tradeTime).toHaveAttribute("title", "09:00:45.120");
  const timeBox = (await tradeTime.boundingBox())!;
  const priceBox = (await tradePrice.boundingBox())!;
  expect(timeBox.x + timeBox.width).toBeLessThanOrEqual(priceBox.x + 1);

  await page.getByRole("group", { name: "체결 금액 필터" }).getByRole("button", { name: "3천만", exact: true }).click();
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

  await qtyInput.fill("20");
  await page.getByTestId("replay-sim-market-buy").click();
  await expect(page.getByTestId("replay-sim-qty")).toHaveText("20주");
  await expect(page.getByTestId("replay-sim-avg")).toHaveText("71,100원");

  await page.getByTestId("replay-sim-half-sell").click();
  await expect(page.getByTestId("replay-sim-qty")).toHaveText("10주");

  await page.getByTestId("replay-sim-account-toggle").click();
  await expect(page.getByTestId("replay-sim-account")).toBeVisible();
  await expect(page.getByTestId("replay-sim-cash-input")).toBeVisible();
  await expect(page.getByTestId("replay-sim-fee-toggle")).toBeVisible();
  await page.getByTestId("replay-sim-account-toggle").click();
  await expect(page.getByTestId("replay-sim-account")).toHaveCount(0);
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
  const qtyInput = page.getByTestId("replay-sim-qty-input");
  const presetGroup = page.getByRole("group", { name: "주문 수량 프리셋" });
  const btn50 = presetGroup.getByRole("button", { name: "50%", exact: true });
  const btnFull = presetGroup.getByRole("button", { name: "전량", exact: true });
  const higherAskBuyCell = page.locator('[data-testid="replay-sim-buy-cell"][data-price="71300"]');
  const bidBuyCell = page.locator('[data-testid="replay-sim-buy-cell"][data-price="71000"]');

  await expect(qtyInput).toHaveValue("50");
  await expect(qtyInput).not.toHaveAttribute("data-ratio-active", "");

  await btn50.click();
  await expect(btn50).toHaveAttribute("aria-pressed", "true");
  await expect(qtyInput).toHaveValue("50");
  await expect(qtyInput).toHaveAttribute("data-ratio-active", "");
  await expect(higherAskBuyCell.locator(".od-preview")).toHaveText("매수 210");
  await expect(bidBuyCell.locator(".od-preview")).toHaveText("매수 211");

  await btn50.click();
  await expect(btn50).toHaveAttribute("aria-pressed", "false");
  await expect(qtyInput).not.toHaveAttribute("data-ratio-active", "");
  await expect(higherAskBuyCell.locator(".od-preview")).toHaveText("매수 50");

  await btnFull.click();
  await expect(btnFull).toHaveAttribute("aria-pressed", "true");
  await expect(qtyInput).toHaveValue("50");
  await expect(qtyInput).toHaveAttribute("data-ratio-active", "");
  await expect(higherAskBuyCell.locator(".od-preview")).toHaveText("매수 420");
  await expect(higherAskBuyCell.locator(".od-preview")).not.toHaveAttribute("data-over", "");
  await higherAskBuyCell.click();
  await expect(page.getByTestId("replay-sim-qty")).toHaveText("420주");
  await expect(page.getByTestId("replay-sim-status")).toHaveAttribute("data-tone", "ok");
  await expect(btnFull).toHaveAttribute("aria-pressed", "false");
  await expect(qtyInput).not.toHaveAttribute("data-ratio-active", "");
  await expect(qtyInput).toHaveValue("50");

  await page.getByTestId("replay-sim-reset").click();
  await btn50.click();
  await expect(btn50).toHaveAttribute("aria-pressed", "true");
  await expect(qtyInput).toHaveAttribute("data-ratio-active", "");
  await qtyInput.fill("25");
  await expect(btn50).toHaveAttribute("aria-pressed", "false");
  await expect(qtyInput).not.toHaveAttribute("data-ratio-active", "");
  await expect(higherAskBuyCell.locator(".od-preview")).toHaveText("매수 25");

  await page.getByTestId("replay-tab-brokers").click();
  const brokersPane = page.getByTestId("replay-brokers-pane");
  const brokers = page.getByTestId("replay-brokers");
  await brokersPane.getByTestId("replay-broker-view-table").click();
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

test("종목 클릭 시 기존 SearchDialog로 종목을 전환하고, 3열 스플리터 너비 조절과 상단 데크 중앙 배치가 동작한다", async ({ page, scenario }) => {
  seedTickReplay(scenario);
  scenario.reply("/api/symbols/000660/book-replay/days", { body: { symbol: "000660", days: [] } });
  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);

  await expect(page.getByTestId("replay-page")).toBeVisible();
  await expect(page.getByTestId("replay-workspace")).toBeVisible();

  const deckBox = (await page.getByTestId("replay-deck").boundingBox())!;
  const centerBox = (await page.getByTestId("replay-deck-center").boundingBox())!;
  const deckMid = deckBox.x + deckBox.width / 2;
  const centerMid = centerBox.x + centerBox.width / 2;
  expect(Math.abs(deckMid - centerMid)).toBeLessThan(80);

  const chartBefore = (await page.getByTestId("replay-slot-chart").boundingBox())!;
  const ladderBefore = (await page.getByTestId("replay-slot-ladder").boundingBox())!;
  const rightBefore = (await page.getByTestId("replay-slot-right").boundingBox())!;

  const mainSplitter = (await page.getByTestId("replay-splitter-main").boundingBox())!;
  await page.mouse.move(mainSplitter.x + mainSplitter.width / 2, mainSplitter.y + mainSplitter.height / 2);
  await page.mouse.down();
  await page.mouse.move(mainSplitter.x - 80, mainSplitter.y + mainSplitter.height / 2, { steps: 4 });
  await page.mouse.up();

  const chartAfter = (await page.getByTestId("replay-slot-chart").boundingBox())!;
  expect(chartAfter.width).toBeLessThan(chartBefore.width - 20);

  const ladderBeforeRightDrag = (await page.getByTestId("replay-slot-ladder").boundingBox())!;
  const rightBeforeRightDrag = (await page.getByTestId("replay-slot-right").boundingBox())!;

  const rightSplitter = (await page.getByTestId("replay-splitter-right").boundingBox())!;
  await page.mouse.move(rightSplitter.x + rightSplitter.width / 2, rightSplitter.y + rightSplitter.height / 2);
  await page.mouse.down();
  await page.mouse.move(rightSplitter.x + 60, rightSplitter.y + rightSplitter.height / 2, { steps: 4 });
  await page.mouse.up();

  const ladderAfter = (await page.getByTestId("replay-slot-ladder").boundingBox())!;
  const rightAfter = (await page.getByTestId("replay-slot-right").boundingBox())!;
  expect(ladderAfter.width).toBeGreaterThan(ladderBeforeRightDrag.width + 20);
  expect(rightAfter.width).toBeLessThan(rightBeforeRightDrag.width - 20);
  expect(ladderBefore.width).toBeGreaterThan(360);
  expect(rightBefore.width).toBeGreaterThan(280);

  await page.getByTestId("replay-symbol-picker").click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("search-target-bar")).toHaveCount(0);
  await expect(dialog.getByRole("group", { name: "시장 필터" })).toBeVisible();
  const input = dialog.getByRole("combobox", { name: "종목 검색" });
  await input.fill("000660");
  const hynix = dialog.getByRole("option").filter({ hasText: "000660" });
  await expect(hynix).toHaveAttribute("aria-disabled", "false");
  await hynix.click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/replay\?symbol=000660/);
  await expect(page.getByTestId("replay-symbol-picker")).toContainText("000660");
});

test("호가 복기 거래원 패널의 보기·카드 모양·이동 하위 옵션은 탭 전환·종목 변경·새로고침 뒤에도 유지된다", async ({ page, scenario }) => {
  seedTickReplay(scenario);
  const altCode = "000660";
  scenario.reply(`/api/symbols/${altCode}/book-replay/days`, { body: { symbol: altCode, days: [DATE] } });
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${altCode}/book-replay/meta` && url.searchParams.get("date") === DATE,
    { body: { ...REPLAY_META_TICK, symbol: altCode } },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${altCode}/book-replay/span` && url.searchParams.get("date") === DATE && url.searchParams.get("startMinute") === "540",
    { body: SPAN_540_BYTES },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${altCode}/brokers` && url.searchParams.get("date") === DATE,
    { body: { ...BROKER_DAY, symbol: altCode } },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${altCode}/program-series`,
    { body: { ...PROGRAM_PAGE, symbol: altCode } },
  );

  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);

  await page.getByTestId("replay-tab-brokers").click();
  const brokersPane = page.getByTestId("replay-brokers-pane");
  const brokers = page.getByTestId("replay-brokers");
  await expect(brokers.getByTestId("broker-transfer-sankey")).toBeVisible();

  await expect(brokers.getByRole("group", { name: "집계 단위" })).toHaveCount(0);
  const modeGroup = brokers.getByRole("group", { name: "계산 모드" });
  const toggleOther = brokers.getByTestId("broker-transfer-toggle-other");
  const preset30 = brokers.getByTestId("broker-transfer-preset-last30");

  await modeGroup.getByRole("button", { name: "총량", exact: true }).click();
  await toggleOther.click();
  await preset30.click();

  await page.getByTestId("replay-tab-journal").click();
  await expect(brokersPane.getByTestId("replay-sim-journal")).toBeVisible();
  await page.getByTestId("replay-tab-brokers").click();
  await expect(brokers.getByTestId("broker-transfer-sankey")).toBeVisible();

  await brokersPane.getByTestId("replay-broker-view-board").click();
  await brokersPane.getByRole("group", { name: "카드 모양" }).getByRole("button", { name: "복합", exact: true }).click();
  await brokersPane.getByTestId("replay-broker-view-transfer").click();
  await expect(brokers.getByTestId("broker-transfer-sankey")).toBeVisible();

  const assertTransferOptions = async () => {
    await expect(brokers.getByRole("group", { name: "집계 단위" })).toHaveCount(0);
    await expect(modeGroup.getByRole("button", { name: "총량", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(toggleOther).toHaveAttribute("aria-pressed", "false");
    await expect(preset30).toHaveAttribute("aria-pressed", "true");
  };

  await assertTransferOptions();

  await page.getByTestId("replay-symbol-picker").click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill(altCode);
  const hynix = dialog.getByRole("option").filter({ hasText: altCode });
  await expect(hynix).toHaveAttribute("aria-disabled", "false");
  await hynix.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("replay-symbol-picker")).toContainText(altCode);
  await expect(brokers.getByTestId("broker-transfer-sankey")).toBeVisible();
  await assertTransferOptions();

  await pollSaved(() => scenario.documents.uiPrefs().brokers).toMatchObject({
    transferMode: "gross",
    transferShowOther: false,
    transferRangePreset: "last30",
    replayView: "transfer",
    replayCards: "both",
  });
  expect(scenario.documents.uiPrefs().brokers).not.toHaveProperty("transferLevel");

  await page.reload();
  await page.getByTestId("replay-tab-brokers").click();
  await expect(brokers.getByTestId("broker-transfer-sankey")).toBeVisible();
  await assertTransferOptions();

  await brokersPane.getByTestId("replay-broker-view-board").click();
  await expect(brokersPane.getByRole("group", { name: "카드 모양" }).getByRole("button", { name: "복합", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("체결창 수동 스크롤 고정·새 체결 배지·과거 대량 체결 소급 백필과 차트 헤더 범위 버튼 제거가 동작한다", async ({ page, scenario }) => {
  const m545 = 545 * 60_000;
  const m550 = 550 * 60_000;
  const span540Big = new Uint8Array(
    encodeHogaSpan({
      date: 20261125,
      startMinute: 540,
      lengthMinutes: 5,
      symbol: `${CODE}_AL`,
      streams: [
        {
          kind: "trades",
          columns: {
            recv_ms: [M540 + 15_000],
            t_s: [32_415],
            price: [70_000],
            qty: [2_000],
            venue: [1],
          },
        },
      ],
    }),
  );
  const span545Big = new Uint8Array(
    encodeHogaSpan({
      date: 20261125,
      startMinute: 545,
      lengthMinutes: 5,
      symbol: `${CODE}_AL`,
      streams: [
        {
          kind: "trades",
          columns: {
            recv_ms: [m545 + 20_000],
            t_s: [32_720],
            price: [70_000],
            qty: [-600],
            venue: [1],
          },
        },
      ],
    }),
  );
  const smallCount = 120;
  const span550Recv = Array.from({ length: smallCount + 2 }, (_, i) =>
    i < smallCount ? m550 + (i + 1) * 400 : m550 + 62_000 + (i - smallCount) * 1_000,
  );
  const span550Ts = span550Recv.map((ms) => Math.floor(ms / 1000));
  const span550Price = Array.from({ length: smallCount + 2 }, () => 71_000);
  const span550Qty = Array.from({ length: smallCount + 2 }, (_, i) => (i % 2 === 0 ? 15 : -10));
  const span550Venue = Array.from({ length: smallCount + 2 }, () => 1);
  const span550Many = new Uint8Array(
    encodeHogaSpan({
      date: 20261125,
      startMinute: 550,
      lengthMinutes: 5,
      symbol: `${CODE}_AL`,
      streams: [
        {
          kind: "book",
          columns: {
            recv_ms: [m550],
            t_s: [33_000],
            ask_px1: [71_100],
            bid_px1: [71_000],
            ask_qty1: [1_000],
            bid_qty1: [1_000],
            ask_total: [1_000],
            bid_total: [1_000],
          },
        },
        {
          kind: "trades",
          columns: {
            recv_ms: span550Recv,
            t_s: span550Ts,
            price: span550Price,
            qty: span550Qty,
            venue: span550Venue,
          },
        },
      ],
    }),
  );

  const metaMulti: BookReplayMeta = {
    symbol: CODE,
    date: DATE,
    coverage: "collected",
    resolution: "tick",
    spanMinutes: 5,
    covered: [[540, 554]],
    gapsMs: [],
    spans: [
      { startMinute: 540, bookRows: 0, tradeRows: 1, programRows: 0 },
      { startMinute: 545, bookRows: 0, tradeRows: 1, programRows: 0 },
      { startMinute: 550, bookRows: 1, tradeRows: smallCount + 2, programRows: 0 },
    ],
    minutes: [
      {
        minute: 550,
        open: 71_000,
        high: 71_000,
        low: 71_000,
        close: 71_000,
        volume: 1_500,
        cumVol: 2_600,
        cumVal: 182_000_000,
        cumBuyQty: 2_000,
        cumSellQty: 600,
        dayOpen: 70_000,
        dayHigh: 71_000,
        dayLow: 70_000,
        totalAsk: 1_000,
        totalBid: 1_000,
        programNetQty: null,
        programNetAmtMillion: null,
        singlePrice: false,
      },
      {
        minute: 551,
        open: 71_000,
        high: 71_000,
        low: 71_000,
        close: 71_000,
        volume: 25,
        cumVol: 4_100,
        cumVal: 288_500_000,
        cumBuyQty: 2_900,
        cumSellQty: 1_200,
        dayOpen: 70_000,
        dayHigh: 71_000,
        dayLow: 70_000,
        totalAsk: 1_000,
        totalBid: 1_000,
        programNetQty: null,
        programNetAmtMillion: null,
        singlePrice: false,
      },
    ],
  };

  seedCommon(scenario);
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay/meta` && url.searchParams.get("date") === DATE,
    { body: metaMulti },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay/span` && url.searchParams.get("startMinute") === "540",
    { body: span540Big },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay/span` && url.searchParams.get("startMinute") === "545",
    { body: span545Big },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay/span` && url.searchParams.get("startMinute") === "550",
    { body: span550Many },
  );

  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);
  await expect(page.getByTestId("replay-page")).toBeVisible();
  await expect(page.getByRole("group", { name: "차트 범위" })).toHaveCount(0);
  await expect(page.getByTestId("replay-deck").getByRole("button", { name: "±5분 정밀", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "+1m", exact: true }).click();
  await expect(page.getByTestId("replay-clock")).toHaveText("09:11:00.000");

  const tape = page.getByTestId("replay-tape");
  await expect.poll(() => tape.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await tape.evaluate((el) => {
    el.scrollTop = 360;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(tape).toHaveAttribute("data-pinned", "true");
  const returnTopBtn = page.getByTestId("replay-tape-return-top");
  await expect(returnTopBtn).toHaveText("↑ 맨 위로");

  const frozenFirstTime = await page.getByTestId("replay-tape-row").first().locator(".tr-time").textContent();

  await page.getByTestId("replay-mode-switch").getByRole("button", { name: "틱 단위", exact: true }).click();
  await page.getByRole("group", { name: "틱 대상 선택" }).getByRole("button", { name: "체결만", exact: true }).click();
  await page.getByRole("button", { name: "+1틱", exact: true }).click();
  await page.getByRole("button", { name: "+1틱", exact: true }).click();

  await expect(returnTopBtn).toHaveText("↑ 새 체결 2건 · 맨 위로");
  await expect(page.getByTestId("replay-tape-row").first().locator(".tr-time")).toHaveText(frozenFirstTime!);

  await returnTopBtn.click();
  await expect(tape).toHaveAttribute("data-pinned", "false");
  await expect(returnTopBtn).toHaveCount(0);
  await expect(page.getByTestId("replay-tape-row").first().locator(".tr-time")).toHaveText("09:11:03");

  await page.getByRole("group", { name: "체결 금액 필터" }).getByRole("button", { name: "3천만", exact: true }).click();
  await expect(page.getByTestId("replay-tape-row")).toHaveCount(2);
  await expect(page.getByTestId("replay-tape-row").nth(0).locator(".tr-time")).toHaveText("09:05:20");
  await expect(page.getByTestId("replay-tape-row").nth(1).locator(".tr-time")).toHaveText("09:00:15");

  await page.getByRole("group", { name: "체결 금액 필터" }).getByRole("button", { name: "1억", exact: true }).click();
  await expect(page.getByTestId("replay-tape-row")).toHaveCount(1);
  await expect(page.getByTestId("replay-tape-row").first().locator(".tr-time")).toHaveText("09:00:15");
});

test("KRX 단독 아카이브 날짜는 배지·전일종가·연월 점프·프로그램 안내·카탈로그 검색 필터를 표시한다", async ({ page, scenario }) => {
  const archiveDate = "20240827";
  const archiveMidnight = Date.parse("2024-08-27T00:00:00+09:00") / 1000;
  const archiveSpan = new Uint8Array(
    encodeHogaSpan({
      date: 20240827,
      startMinute: 540,
      lengthMinutes: 5,
      symbol: `${CODE}_AL`,
      streams: [
        {
          kind: "book",
          columns: {
            recv_ms: [M540 + 5_000],
            t_s: [32_405],
            ask_px1: [76_100],
            bid_px1: [76_000],
            ask_qty1: [400],
            bid_qty1: [600],
            ask_total: [400],
            bid_total: [600],
          },
        },
        {
          kind: "trades",
          columns: {
            recv_ms: [M540 + 10_000],
            t_s: [32_410],
            price: [76_000],
            qty: [120],
            venue: [1],
          },
        },
      ],
    }),
  );
  const archiveMeta: BookReplayMeta = {
    symbol: CODE,
    date: archiveDate,
    coverage: "collected",
    resolution: "tick",
    spanMinutes: 5,
    previousClose: 75_000,
    venueScope: "krx_archive",
    covered: [[540, 544]],
    gapsMs: [],
    spans: [{ startMinute: 540, bookRows: 1, tradeRows: 1, programRows: 0 }],
    minutes: [
      {
        minute: 540,
        open: 76_000,
        high: 76_000,
        low: 76_000,
        close: 76_000,
        volume: 120,
        cumVol: 0,
        cumVal: 0,
        cumBuyQty: 0,
        cumSellQty: 0,
        dayOpen: null,
        dayHigh: null,
        dayLow: null,
        totalAsk: 400,
        totalBid: 600,
        programNetQty: null,
        programNetAmtMillion: null,
        singlePrice: false,
      },
    ],
  };

  seedTickReplay(scenario);
  scenario.reply("/api/book-replay/catalog", {
    body: {
      items: [
        { symbol: CODE, name: "삼성전자", market: "kospi", kind: "common", nativeDays: 1, archiveDays: 1, totalDays: 2, latestDate: DATE },
        { symbol: "009540", name: "HD한국조선해양", market: "kospi", kind: "common", nativeDays: 0, archiveDays: 142, totalDays: 142, latestDate: archiveDate },
      ],
    },
  });
  scenario.reply(`/api/symbols/${CODE}/book-replay/days`, {
    body: { symbol: CODE, days: [archiveDate, DATE], archiveDays: [archiveDate] },
  });
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay/meta` && url.searchParams.get("date") === archiveDate,
    { body: archiveMeta },
  );
  scenario.reply(
    (url) =>
      url.pathname === `/api/symbols/${CODE}/book-replay/span` &&
      url.searchParams.get("date") === archiveDate &&
      url.searchParams.get("startMinute") === "540",
    { body: archiveSpan },
  );
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/brokers` && url.searchParams.get("date") === archiveDate,
    {
      body: {
        ...BROKER_DAY,
        date: archiveDate,
        venueScope: "krx_archive",
        snapshots: [
          {
            t: archiveMidnight + 540 * 60 + 30,
            sells: [{ code: "012", name: "한  화", qty: 500, qtyChange: 500 }],
            buys: [{ code: "050", name: "키움증권", qty: 900, qtyChange: 900 }],
          },
        ],
      },
    },
  );

  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);
  await expect(page.getByTestId("replay-resolution-badge")).toHaveAttribute("data-venue-scope", "combined");

  await page.getByTestId("replay-date-trigger").click();
  const popover = page.getByTestId("replay-date-popover");
  await expect(popover).toBeVisible();
  await popover.getByTestId("replay-date-year").selectOption("2024");
  await expect(popover.getByTestId("replay-date-month")).toHaveValue("8");
  const archiveCell = popover.locator('[data-date="20240827"]');
  await expect(archiveCell).toHaveAttribute("data-source", "archive");
  await archiveCell.click();

  await expect(page.getByTestId("replay-resolution-badge")).toHaveAttribute("data-venue-scope", "krx_archive");
  await expect(page.getByTestId("replay-resolution-badge")).toHaveText("KRX 단독 · 아카이브");
  await expect(page.getByTestId("replay-prev-close")).toHaveText("75,000");

  await page.getByTestId("replay-tab-program").click();
  await expect(page.getByTestId("replay-program-pane")).toContainText("KRX 아카이브에는 프로그램 매매 데이터가 없습니다");

  await page.getByTestId("replay-tab-brokers").click();
  await expect(page.getByTestId("replay-brokers-archive-badge")).toHaveText("KRX 단독");

  await page.getByTestId("replay-symbol-picker").click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await expect(dialog.getByTestId("search-replay-filter-bar")).toBeVisible();
  await expect(dialog.getByRole("option").filter({ hasText: "009540" })).toContainText("KRX 142일");
});
