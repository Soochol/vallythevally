import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { BrokerDay } from "../src/api/generated/BrokerDay";
import type { FeedBrokers } from "../src/api/generated/FeedBrokers";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Period } from "../src/api/generated/Period";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test, windowTabs } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 40 };
const TODAY = "20261109";
const PAST = "20261106";
const UNCOLLECTED = "20261105";
test.use({ clockStart: "20261109093230" });

const at = (clock: string, day = "2026-11-09") => Date.parse(`${day}T${clock}+09:00`) / 1000;
const entry = (code: string, name: string, qty: number) => ({ code, name, qty, qtyChange: 0 });
const kiwoom = (t: number, qty: number): FeedBrokers => ({ t, buys: [entry("151", "키움", qty)], sells: [entry("141", "삼성", 90)] });
const day = (patch: Partial<BrokerDay>): BrokerDay => ({ symbol: "005930", date: TODAY, source: "none", snapshots: [], gaps: [], live: true, cursor: "", reset: true, ...patch });

const FLOW = day({ source: "flow", snapshots: [kiwoom(at("08:10:00"), 10), kiwoom(at("09:30:00"), 100)], cursor: "f:1:2" });

const window_ = (page: Page) => page.getByTestId("brokers-window");
const card = (page: Page, name: string) => window_(page).getByTestId("broker-card").and(page.locator(`[data-broker="${name}"]`));
const syncButton = (page: Page) => window_(page).getByTestId("brokers-chart-sync");
const brokerFeeds = (scenario: Scenario) => scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "brokers");

async function barCoordinate(page: Page, time: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    (chartTime) => {
      const probe = window.chartProbe;
      if (!probe) throw new Error("차트 좌표가 없습니다");
      const x = probe.chart.timeScale().timeToCoordinate(chartTime);
      const box = probe.chart.chartElement().getBoundingClientRect();
      if (x === null || x < 0 || x > probe.chart.timeScale().width()) throw new Error("가리킬 봉이 화면 밖입니다");
      return { x: box.x + x, y: box.y + box.height * 0.55 };
    },
    toChartTime(time),
  );
}

function collected(scenario: Scenario, today: (after: string | null) => BrokerDay, past?: BrokerDay) {
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers", (request) => {
    const query = new URL(request.url()).searchParams;
    const requested = query.get("date")!;
    if (requested === TODAY) return { body: today(query.get("after")) };
    if (requested === PAST && past !== undefined) return { body: past };
    return { body: day({ date: requested, source: "none", live: false }) };
  });
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers/days", () => ({ body: { symbol: "005930", days: past === undefined ? [] : [PAST] } }));
}

function minuteBars(scenario: Scenario) {
  scenario.on((url) => url.pathname === "/api/bars" && url.searchParams.get("period") === "1m", () => {
    const bars = [["09:00:00", 71_000], ["09:30:00", 71_300], ["09:31:00", 71_400]].map(([clock, close]) => ({ t: at(clock as string), o: close as number, h: close as number, l: close as number, c: close as number, v: 10 }));
    const body: BarsPage = { symbol: "005930", venue: "combined", period: "1m", bars, current: null, nextBefore: null, seq: null };
    return { body };
  });
}

async function openBrokers(page: Page, scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^거래원 입체분석/ }).click();
  await expect(windowTabs(page).getByRole("tab", { name: /^거래원 입체분석/ })).toHaveCount(1);
}

function seedSplitWithChart(scenario: Scenario, period: Period, bars: readonly Bar[]) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period, chartSettings: SETTINGS },
    { id: "brokers", link: "a", kind: "brokers" },
  ];
  const root = {
    kind: "split",
    dir: "row",
    ratio: 0.52,
    first: { kind: "group", id: "g1", tabs: ["cell-0"], active: "cell-0" },
    second: { kind: "group", id: "g2", tabs: ["brokers"], active: "brokers" },
  };
  scenario.documents.saveLayout({
    ...layout,
    windows,
    placement: { v: 1, dock: { root, floats: [] }, canvas: null },
    revision: layout.revision + 1,
  });
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("period") === period, {
    body: { symbol: "005930", venue: "combined", period, bars: [...bars], current: null, nextBefore: null, seq: null },
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("오늘 흐름이 있으면 실시간 구독 없이 09:00부터 보이고 새 행을 이어 받는다", async ({ page, scenario }) => {
  collected(scenario, (after) => {
    if (after === "f:1:2") return day({ source: "flow", snapshots: [kiwoom(at("09:32:00"), 700)], cursor: "f:1:3", reset: false });
    if (after === "f:1:3") return day({ source: "flow", cursor: "f:1:3", reset: false });
    return FLOW;
  });
  await openBrokers(page, scenario);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+700");
  expect(brokerFeeds(scenario)).toEqual([]);
  const bars = (await card(page, "키움").getByTestId("broker-bars").boundingBox())!;
  await page.mouse.move(bars.x + 1, bars.y + bars.height / 2);
  await expect(window_(page).getByTestId("brokers-time")).toContainText("09:00");
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+10");
});

test("수집 자료가 없으면 실시간을 구독한다", async ({ page, scenario }) => {
  collected(scenario, () => day({}));
  await openBrokers(page, scenario);
  await expect.poll(() => brokerFeeds(scenario).length).toBe(1);
  const request = brokerFeeds(scenario)[0]!;
  if (request.type !== "subscribe_feed") throw new Error("거래원 구독이 없습니다");
  scenario.live.emit({ type: "feed_brokers", sub: request.sub, brokers: kiwoom(at("09:32:00"), 300) });
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+300");
});

test("날짜 이동 버튼이 없고 차트 동기화로 분봉의 날짜와 시각을 연동하며 차트를 벗어나도 유지한다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  const bars5m: Bar[] = [
    { t: at("09:25:00", "2026-11-06"), o: 70_000, h: 70_300, l: 69_900, c: 70_200, v: 100 },
    { t: at("09:30:00", "2026-11-06"), o: 70_200, h: 70_600, l: 70_100, c: 70_500, v: 120 },
    { t: at("15:20:00", "2026-11-06"), o: 70_800, h: 71_000, l: 70_700, c: 70_900, v: 150 },
    { t: at("09:25:00", "2026-11-09"), o: 71_000, h: 71_200, l: 70_900, c: 71_100, v: 90 },
    { t: at("09:30:00", "2026-11-09"), o: 71_100, h: 71_400, l: 71_000, c: 71_300, v: 110 },
  ];
  const past = day({
    date: PAST,
    source: "store",
    live: false,
    cursor: "s:1:2",
    snapshots: [kiwoom(at("09:30:00", "2026-11-06"), 5_000), kiwoom(at("15:20:00", "2026-11-06"), 8_000)],
  });
  const counts = { past: 0, jump: 0 };
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers", (request) => {
    const query = new URL(request.url()).searchParams;
    if (query.get("date") === PAST) {
      counts.past += 1;
      return { body: past };
    }
    return { body: query.get("after") === null ? FLOW : day({ source: "flow", cursor: "f:1:2", reset: false }) };
  });
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers/days", () => ({ body: { symbol: "005930", days: [PAST] } }));
  scenario.on((url) => url.pathname === "/api/bars/jump", () => {
    counts.jump += 1;
    return { body: { symbol: "005930", venue: "combined", period: "1m", date: "2026-11-06", bars: [], nextBefore: null } };
  });
  seedSplitWithChart(scenario, "5m", bars5m);

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+100");
  await expect(window_(page).getByRole("button", { name: "이전 관측일" })).toHaveCount(0);
  await expect(window_(page).getByRole("button", { name: "다음 관측일" })).toHaveCount(0);
  await expect(syncButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(window_(page).getByTestId("brokers-sync-strip")).toHaveCount(0);

  await syncButton(page).click();
  await expect(syncButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(window_(page).getByTestId("brokers-sync-strip")).toHaveAttribute("data-kind", "live");

  const earlyPos = await barCoordinate(page, at("09:30:00", "2026-11-06"));
  await page.mouse.move(earlyPos.x, earlyPos.y);
  await expect(window_(page).getByTestId("brokers-sync-date")).toHaveText("11-06");
  await expect(window_(page).getByTestId("brokers-time")).toHaveText("09:34");
  await expect(window_(page).getByTestId("brokers-price")).toHaveText("70,500");
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+5,000");
  await expect(window_(page).getByTestId("broker-future-shade")).toHaveCount(2);
  expect(counts.past).toBe(1);
  expect(counts.jump).toBe(0);

  const latePos = await barCoordinate(page, at("15:20:00", "2026-11-06"));
  await page.mouse.move(latePos.x, latePos.y);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+8,000");
  await expect(window_(page).getByTestId("brokers-time")).toHaveText("15:24");
  expect(counts.past).toBe(1);

  await page.mouse.move(earlyPos.x, earlyPos.y);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+5,000");

  await page.mouse.move(8, 8);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+5,000");

  await card(page, "키움").click();
  await expect(window_(page).getByTestId("broker-detail-row")).toHaveCount(1);
  await expect(window_(page).getByTestId("broker-detail-row").first()).toContainText("09:30:00");

  await syncButton(page).click();
  await expect(syncButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(window_(page).getByTestId("brokers-sync-strip")).toHaveCount(0);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+100");
});

test("일봉 호버는 해당 일자 장마감 전체를 보이고 미수집 날은 빈 상태를 보이며 캐시를 재사용한다", async ({ page, scenario }) => {
  await page.addInitScript(installChartProbe);
  const dailyBars: Bar[] = [
    { t: at("00:00:00", "2026-11-05"), o: 68_500, h: 69_000, l: 68_200, c: 68_900, v: 500 },
    { t: at("00:00:00", "2026-11-06"), o: 69_800, h: 71_000, l: 69_700, c: 70_700, v: 600 },
    { t: at("00:00:00", "2026-11-09"), o: 71_000, h: 71_500, l: 70_900, c: 71_400, v: 700 },
  ];
  const past = day({
    date: PAST,
    source: "store",
    live: false,
    cursor: "s:1:2",
    snapshots: [kiwoom(at("09:30:00", "2026-11-06"), 5_000), kiwoom(at("15:20:00", "2026-11-06"), 8_000)],
  });
  const counts = { past: 0, uncollected: 0 };
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers", (request) => {
    const query = new URL(request.url()).searchParams;
    const requested = query.get("date");
    if (requested === PAST) {
      counts.past += 1;
      return { body: past };
    }
    if (requested === UNCOLLECTED) {
      counts.uncollected += 1;
      return { body: day({ date: UNCOLLECTED, source: "none", live: false }) };
    }
    return { body: query.get("after") === null ? FLOW : day({ source: "flow", cursor: "f:1:2", reset: false }) };
  });
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers/days", () => ({ body: { symbol: "005930", days: [PAST] } }));
  seedSplitWithChart(scenario, "D", dailyBars);

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await syncButton(page).click();

  const pastPos = await barCoordinate(page, at("00:00:00", "2026-11-06"));
  await page.mouse.move(pastPos.x, pastPos.y);
  await expect(window_(page).getByTestId("brokers-sync-strip")).toContainText("11-06 장마감 (일봉)");
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+8,000");
  await expect(window_(page).getByTestId("broker-future-shade")).toHaveCount(0);
  expect(counts.past).toBe(1);

  const emptyPos = await barCoordinate(page, at("00:00:00", "2026-11-05"));
  await page.mouse.move(emptyPos.x, emptyPos.y);
  await expect(window_(page).getByTestId("brokers-sync-strip")).toHaveAttribute("data-kind", "none");
  await expect(window_(page)).toContainText("이 날의 거래원 자료가 없습니다");
  expect(counts.uncollected).toBe(1);

  await page.mouse.move(pastPos.x, pastPos.y);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+8,000");
  expect(counts.past).toBe(1);
});

test("커서 시각의 가격이 머리와 건별 표에 보인다", async ({ page, scenario }) => {
  minuteBars(scenario);
  collected(scenario, (after) => (after === null ? FLOW : day({ source: "flow", cursor: "f:1:2", reset: false })));
  await openBrokers(page, scenario);
  await expect(window_(page).getByTestId("brokers-price")).toHaveText("71,300");
  await card(page, "키움").click();
  await page.mouse.move(5, 5);
  await expect(window_(page).getByTestId("broker-detail-row").first()).toContainText("71,300");
  await expect(window_(page).getByTestId("broker-detail")).toContainText("추정가격");
});

test("끊긴 구간은 카드마다 빗금으로 보인다", async ({ page, scenario }) => {
  collected(scenario, (after) => (after === null ? { ...FLOW, gaps: [[at("09:10:00"), at("09:12:00")]] } : day({ source: "flow", cursor: "f:1:2", reset: false, gaps: [[at("09:10:00"), at("09:12:00")]] })));
  await openBrokers(page, scenario);
  await expect(window_(page).getByTestId("broker-card")).toHaveCount(2);
  await expect(window_(page).getByTestId("broker-gap")).toHaveCount(2);
});
