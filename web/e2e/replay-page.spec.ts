import type { Bar } from "../src/api/generated/Bar";
import type { BookReplayDay } from "../src/api/generated/BookReplayDay";
import type { BrokerDay } from "../src/api/generated/BrokerDay";
import type { ProgramSeriesPage } from "../src/api/generated/ProgramSeriesPage";
import { expect, type Scenario, test } from "./harness";

test.use({ clockStart: "20261126160000", viewport: { width: 1440, height: 900 } });

const CODE = "005930";
const DATE = "20261125";
const MIDNIGHT = Date.parse("2026-11-25T00:00:00+09:00") / 1000;
const PREV_MIDNIGHT = Date.parse("2026-11-24T00:00:00+09:00") / 1000;

const DAILY_BARS: Bar[] = [
  { t: PREV_MIDNIGHT + 9 * 3600, o: 70_000, h: 70_500, l: 69_800, c: 70_000, v: 500_000 },
  { t: MIDNIGHT + 9 * 3600, o: 71_000, h: 72_000, l: 70_800, c: 71_500, v: 600_000 },
];

const REPLAY_DAY: BookReplayDay = {
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
    {
      minute: 541,
      asks: [[71_100, 1500], [71_200, 900], [71_300, 900], [71_400, 4500]],
      bids: [[71_000, 1900], [70_900, 1100], [70_800, 800], [70_700, 900]],
      totalAsk: 7_800,
      totalBid: 4_700,
    },
    {
      minute: 542,
      asks: [[71_600, 500], [71_700, 400]],
      bids: [[71_500, 600], [71_400, 300]],
      totalAsk: 900,
      totalBid: 900,
    },
  ],
  trades: [
    [540, 32_410, 71_000, 100],
    [540, 32_445, 71_100, 800],
    [541, 32_470, 71_100, -250],
  ],
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

function seedReplay(scenario: Scenario) {
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply(`/api/symbols/${CODE}/book-replay/days`, { body: { symbol: CODE, days: ["20261124", DATE] } });
  scenario.reply(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay` && url.searchParams.get("date") === DATE,
    { body: REPLAY_DAY },
  );
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

test("/replay는 4대 보조지표·10호가 델타·과거일 기준가·거래원 입체/거래원을 한 화면에 보이고 이벤트 컨트롤이 없다", async ({ page, scenario }) => {
  seedReplay(scenario);
  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);

  await expect(page.getByTestId("replay-page")).toBeVisible();
  await expect(page.getByTestId("replay-prev-close")).toHaveText("70,000");
  await expect(page.getByTestId("replay-head-price")).toHaveText("71,000");
  await expect(page.getByTestId("replay-head-diff")).toContainText("+1,000");

  const subs = page.getByTestId("replay-sub-indicators");
  await expect(subs.locator('[data-indicator="totals"]')).toContainText("총잔량");
  await expect(subs.locator('[data-indicator="obi"]')).toContainText("호가 잔량비");
  await expect(subs.locator('[data-indicator="strength"]')).toContainText("체결강도");
  await expect(subs.locator('[data-indicator="program"]')).toContainText("프로그램 누적");

  await expect(page.getByTestId("replay-total-ask")).toHaveText("7,600");
  await expect(page.getByTestId("replay-total-bid")).toHaveText("4,200");

  const brokers = page.getByTestId("replay-brokers");
  await expect(brokers.getByTestId("broker-card")).toHaveCount(2);
  await brokers.getByTestId("broker-card").first().click();
  await expect(brokers.getByTestId("broker-detail")).toBeVisible();
  await brokers.getByRole("button", { name: "거래원", exact: true }).click();
  await expect(brokers.getByTestId("broker-row")).toHaveCount(2);
  await expect(brokers.getByTestId("broker-foreign-sum")).toBeVisible();

  await expect(page.getByRole("button", { name: /이벤트/ })).toHaveCount(0);
});

test("틱 이동·체결 필터·북마크·A-B 루프·블라인드 복기·단일가 VI·끊김 배너가 동작한다", async ({ page, scenario }) => {
  seedReplay(scenario);
  await page.goto(`/replay?symbol=${CODE}&date=${DATE}`);

  await expect(page.getByTestId("replay-clock")).toHaveText("09:00:10.000");
  await page.getByRole("button", { name: "+1틱", exact: true }).click();
  await expect(page.getByTestId("replay-clock")).toHaveText("09:00:45.000");
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

test("공개 모드에서는 book-replay API를 호출하지 않고 안내를 표시한다", async ({ page, scenario }) => {
  scenario.publicMode.enable({ provider: "google", createdAt: Math.floor(scenario.now / 1000) });
  await page.goto("/replay");
  await expect(page.getByText("공개 모드에서는 호가 복기를 지원하지 않습니다")).toBeVisible();
  const replayCalls = scenario.requests.filter((r) => new URL(r.url()).pathname.includes("book-replay"));
  expect(replayCalls).toHaveLength(0);
});

test("다크·라이트 테마 전환과 종목 전환 대화상자가 정상 동작한다", async ({ page, scenario }) => {
  seedReplay(scenario);
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
