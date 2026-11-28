import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { ProgramSeriesPage } from "../src/api/generated/ProgramSeriesPage";
import type { TickCvdPage } from "../src/api/generated/TickCvdPage";
import { KINDS } from "../src/chart/indicators/kinds";
import { type ChartSettings, DEFAULT_CHART_SETTINGS, type IndicatorConfig } from "../src/chart/settings";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { openChartSettings } from "./chart-settings-menu";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, firstChart, pollSaved, test, withFirstChart } from "./harness";

const kstAt = (day: string, hh: number, mm: number): number =>
  Date.parse(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`) / 1000;

const makeStepBars = (start: number, count: number, stepSeconds: number, priceAt: (index: number) => number): Bar[] =>
  Array.from({ length: count }, (_, i) => {
    const c = priceAt(i);
    return { t: start + i * stepSeconds, o: c, h: c + 200, l: c - 200, c, v: 1_000 + i * 10 };
  });

const DAY = "2026-11-06";
const PREV_DAY = "2026-11-05";
const PRE_MARKET_BARS = makeStepBars(kstAt(DAY, 8, 0), 20, 180, () => 40_000);
const REGULAR_BARS = makeStepBars(kstAt(DAY, 9, 0), 131, 180, (i) => 50_000 + i * 100);
const AFTER_HOURS_BARS = makeStepBars(kstAt(DAY, 15, 33), 89, 180, () => 90_000);
const FULL_DAY_BARS: Bar[] = [...PRE_MARKET_BARS, ...REGULAR_BARS, ...AFTER_HOURS_BARS];

const COMPARE_FULL_DAY_BARS: Bar[] = [
  ...makeStepBars(kstAt(DAY, 8, 0), 20, 180, () => 100_000),
  ...makeStepBars(kstAt(DAY, 9, 0), 131, 180, (i) => 110_000 + i * 200),
  ...makeStepBars(kstAt(DAY, 15, 33), 89, 180, () => 200_000),
];

const SMA5_INDICATOR: IndicatorConfig = {
  id: "sma-5",
  spec: { kind: "ma", method: "sma", period: 5 },
  panel: "price",
  visible: true,
  style: { colors: ["ind-2"], width: 1 },
};

const saved = (scenario: Scenario) => firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings as ChartSettings;
const popover = (page: Page) => page.getByRole("dialog", { name: "차트 설정", exact: true });
const regularSwitch = (page: Page) => popover(page).getByRole("switch", { name: /^정규장만 보기/ });
const regularBadge = (page: Page) => cell(page).locator("[data-regular-hours-badge]");

function seedChart(scenario: Scenario, period: "3m" | "D", settings: Partial<ChartSettings> = {}) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({
    ...layout,
    revision: layout.revision + 1,
    windows: withFirstChart(layout, {
      symbol: "005930",
      venue: "combined",
      period,
      chartSettings: { ...DEFAULT_CHART_SETTINGS, ...settings },
    }),
  });
}

function trackBarRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (req) => {
    const parsed = new URL(req.url());
    if (parsed.pathname === "/api/bars") urls.push(parsed.search);
  });
  return urls;
}

test("분봉에서 정규장만 보기를 켜면 정규장 봉만 남기고 배지·지표·비교 종목이 추가 조회 없이 재계산된다", async ({ page, scenario }) => {
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "3m",
    { body: { symbol: "005930", venue: "combined", period: "3m", bars: FULL_DAY_BARS, current: null, nextBefore: null, seq: null } },
  );
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "000660" && url.searchParams.get("period") === "3m",
    { body: { symbol: "000660", venue: "combined", period: "3m", bars: COMPARE_FULL_DAY_BARS, current: null, nextBefore: null, seq: null } },
  );
  seedChart(scenario, "3m", {
    visibleBars: 240,
    indicators: [...DEFAULT_CHART_SETTINGS.indicators, SMA5_INDICATOR],
    compare: ["000660"],
  });

  const barRequests = trackBarRequests(page);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  await expect(chart).toHaveAttribute("data-bar-count", String(FULL_DAY_BARS.length));
  await expect(chart).toHaveAttribute("data-first-bar-t", String(PRE_MARKET_BARS[0]!.t));
  await expect(chart).toHaveAttribute("data-last-bar-t", String(AFTER_HOURS_BARS.at(-1)!.t));
  await expect(regularBadge(page)).toBeHidden();

  const smaRow = cell(page).locator(`[data-indicator-row="${SMA5_INDICATOR.id}"]`);
  const compareRow = cell(page).locator(`[data-compare-row="000660"]`);
  await expect(smaRow).toContainText("90,000");
  await expect(compareRow).toContainText("+100.00%");

  const requestsBeforeToggle = barRequests.length;
  await openChartSettings(page, "봉 · 축");
  await expect(regularSwitch(page)).toHaveAttribute("aria-checked", "false");
  await regularSwitch(page).click();

  await expect(regularSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect(popover(page).getByRole("tab", { name: "봉 · 축", exact: true })).toHaveAttribute("data-modified", "true");
  await expect(chart).toHaveAttribute("data-bar-count", String(REGULAR_BARS.length));
  await expect(chart).toHaveAttribute("data-first-bar-t", String(REGULAR_BARS[0]!.t));
  await expect(chart).toHaveAttribute("data-last-bar-t", String(REGULAR_BARS.at(-1)!.t));
  await expect(regularBadge(page)).toBeVisible();
  await expect(regularBadge(page)).toHaveText("정규장");
  await expect(smaRow).toContainText("62,800");
  await expect(compareRow).toContainText("+23.64%");
  await pollSaved(() => saved(scenario).regularHoursOnly).toBe(true);
  expect(barRequests.length).toBe(requestsBeforeToggle);

  await regularSwitch(page).click();
  await expect(regularSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(chart).toHaveAttribute("data-bar-count", String(FULL_DAY_BARS.length));
  await expect(chart).toHaveAttribute("data-first-bar-t", String(PRE_MARKET_BARS[0]!.t));
  await expect(chart).toHaveAttribute("data-last-bar-t", String(AFTER_HOURS_BARS.at(-1)!.t));
  await expect(regularBadge(page)).toBeHidden();
  await expect(smaRow).toContainText("90,000");
  await expect(compareRow).toContainText("+100.00%");
  await pollSaved(() => saved(scenario).regularHoursOnly).toBe(false);
  expect(barRequests.length).toBe(requestsBeforeToggle);
});

test("정규장만 보기 설정은 새로고침 뒤 유지되고 Esc로 닫아도 남으며 기본값 복원이 동작한다", async ({ page, scenario }) => {
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "3m",
    { body: { symbol: "005930", venue: "combined", period: "3m", bars: FULL_DAY_BARS, current: null, nextBefore: null, seq: null } },
  );
  seedChart(scenario, "3m");
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));

  await openChartSettings(page, "봉 · 축");
  await regularSwitch(page).click();
  await expect(chart).toHaveAttribute("data-bar-count", String(REGULAR_BARS.length));
  await pollSaved(() => saved(scenario).regularHoursOnly).toBe(true);
  await popover(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(popover(page)).toBeHidden();

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chart).toHaveAttribute("data-bar-count", String(REGULAR_BARS.length));
  await expect(regularBadge(page)).toBeVisible();

  await openChartSettings(page, "봉 · 축");
  await expect(regularSwitch(page)).toHaveAttribute("aria-checked", "true");
  await regularSwitch(page).click();
  await expect(chart).toHaveAttribute("data-bar-count", String(FULL_DAY_BARS.length));
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(chart).toHaveAttribute("data-bar-count", String(FULL_DAY_BARS.length));
  await expect(regularBadge(page)).toBeHidden();
  await pollSaved(() => saved(scenario).regularHoursOnly).toBe(false);

  await openChartSettings(page, "봉 · 축");
  await regularSwitch(page).click();
  await expect(chart).toHaveAttribute("data-bar-count", String(REGULAR_BARS.length));
  await popover(page).getByRole("button", { name: "기본값 복원", exact: true }).click();
  await expect(regularSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(chart).toHaveAttribute("data-bar-count", String(FULL_DAY_BARS.length));
  await expect(regularBadge(page)).toBeHidden();
  await pollSaved(() => saved(scenario).regularHoursOnly).toBe(false);
});

test("일봉에서는 정규장만 보기를 켜도 모든 봉을 유지하고 정규장 배지를 숨긴다", async ({ page, scenario }) => {
  const dailyBars = makeStepBars(kstAt("2026-10-01", 0, 0), 30, 86_400, (i) => 50_000 + i * 500);
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "D",
    { body: { symbol: "005930", venue: "combined", period: "D", bars: dailyBars, current: null, nextBefore: null, seq: null } },
  );
  seedChart(scenario, "D");
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  await expect(chart).toHaveAttribute("data-bar-count", String(dailyBars.length));

  await openChartSettings(page, "봉 · 축");
  await regularSwitch(page).click();
  await expect(regularSwitch(page)).toHaveAttribute("aria-checked", "true");
  await pollSaved(() => saved(scenario).regularHoursOnly).toBe(true);
  await expect(chart).toHaveAttribute("data-bar-count", String(dailyBars.length));
  await expect(regularBadge(page)).toBeHidden();
});

test("정규장만 보기 중 장외 실시간 체결은 숨겼다가 스위치를 끄면 추가 조회 없이 즉시 표시한다", async ({ page, scenario }) => {
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "3m",
    { body: { symbol: "005930", venue: "combined", period: "3m", bars: REGULAR_BARS, current: null, nextBefore: null, seq: 10 } },
  );
  seedChart(scenario, "3m", { regularHoursOnly: true });
  const barRequests = trackBarRequests(page);

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  const lastRegular = REGULAR_BARS.at(-1)!;
  await expect(chart).toHaveAttribute("data-bar-count", String(REGULAR_BARS.length));
  await expect(chart).toHaveAttribute("data-last-bar-t", String(lastRegular.t));
  await expect(chart).toHaveAttribute("data-last-close", String(lastRegular.c));
  await pollSaved(() => scenario.live.subscriptions().some((s) => s.symbol === "005930" && s.period === "3m")).toBe(true);

  const sub = scenario.live.subscriptions().find((s) => s.symbol === "005930" && s.period === "3m")!.sub;
  const requestsBeforeRealtime = barRequests.length;
  const updatedLastRegular: Bar = { ...lastRegular, h: 64_000, c: 63_500, v: lastRegular.v + 500 };
  scenario.live.emit({ type: "bar", sub, seq: 11, bar: updatedLastRegular });
  await expect(chart).toHaveAttribute("data-last-close", String(updatedLastRegular.c));
  await expect(cell(page).locator("[data-price-row]")).toContainText("63,500");

  const afterBar1: Bar = { t: kstAt(DAY, 15, 33), o: 77_000, h: 78_000, l: 76_500, c: 77_700, v: 5_000 };
  const afterBar2: Bar = { t: kstAt(DAY, 16, 0), o: 88_000, h: 89_000, l: 87_500, c: 88_800, v: 6_000 };
  scenario.live.emit({ type: "bar", sub, seq: 12, bar: afterBar1 });
  scenario.live.emit({ type: "confirmed", sub, seq: 13, bar: afterBar1 });
  scenario.live.emit({ type: "bar", sub, seq: 14, bar: afterBar2 });

  await expect(chart).toHaveAttribute("data-bar-count", String(REGULAR_BARS.length));
  await expect(chart).toHaveAttribute("data-last-bar-t", String(lastRegular.t));
  await expect(chart).toHaveAttribute("data-last-close", String(updatedLastRegular.c));
  await expect(cell(page).locator("[data-price-row]")).toContainText("63,500");

  await openChartSettings(page, "봉 · 축");
  await regularSwitch(page).click();
  await expect(chart).toHaveAttribute("data-bar-count", String(REGULAR_BARS.length + 2));
  await expect(chart).toHaveAttribute("data-last-bar-t", String(afterBar2.t));
  await expect(chart).toHaveAttribute("data-last-close", String(afterBar2.c));
  await expect(cell(page).locator("[data-price-row]")).toContainText("88,800");
  await expect(cell(page).locator("[data-price-row]").getByText("조회 값", { exact: true })).toBeHidden();
  expect(barRequests.length).toBe(requestsBeforeRealtime);
});

test("초기 분봉 페이지가 장외 봉뿐이면 과거 페이지를 자동으로 받아 직전 거래일 정규장 봉을 그린다", async ({ page, scenario }) => {
  const prevRegularBars = makeStepBars(kstAt(PREV_DAY, 9, 0), 131, 180, (i) => 48_000 + i * 50);
  const prevAfterBars = makeStepBars(kstAt(PREV_DAY, 15, 33), 10, 180, () => 60_000);
  const cursor = PRE_MARKET_BARS[0]!.t;

  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "3m" && !url.searchParams.has("before"),
    { body: { symbol: "005930", venue: "combined", period: "3m", bars: PRE_MARKET_BARS, current: null, nextBefore: cursor, seq: null } },
  );
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "3m" && url.searchParams.get("before") === String(cursor),
    { body: { symbol: "005930", venue: "combined", period: "3m", bars: [...prevRegularBars, ...prevAfterBars], current: null, nextBefore: null, seq: null } },
  );
  seedChart(scenario, "3m", { regularHoursOnly: true });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  await expect(chart).toHaveAttribute("data-bar-count", String(prevRegularBars.length));
  await expect(chart).toHaveAttribute("data-first-bar-t", String(prevRegularBars[0]!.t));
  await expect(chart).toHaveAttribute("data-last-bar-t", String(prevRegularBars.at(-1)!.t));
  await expect(regularBadge(page)).toBeVisible();
});

test("정규장 자동 과거 조회가 실패해도 rawHistory가 남아 스위치를 끄거나 Esc로 되돌리면 추가 조회 없이 복구한다", async ({ page, scenario }) => {
  const cursor = PRE_MARKET_BARS[0]!.t;
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "3m" && !url.searchParams.has("before"),
    { body: { symbol: "005930", venue: "combined", period: "3m", bars: PRE_MARKET_BARS, current: null, nextBefore: cursor, seq: null } },
  );
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "3m" && url.searchParams.get("before") === String(cursor),
    { status: 503, body: { error: { code: "kiwoom_unavailable", message: "키움 조회 실패", reason: null, retryAt: null, manualActionRequired: false } } },
  );
  seedChart(scenario, "3m", { regularHoursOnly: true });
  const barRequests = trackBarRequests(page);

  await page.goto("/");
  await expect(cell(page).getByRole("button", { name: "다시 시도" })).toBeVisible();
  const chart = chartOf(cell(page));
  await expect(chart).toHaveAttribute("data-bar-count", "0");

  const requestsBeforeToggleOff = barRequests.length;
  await openChartSettings(page, "봉 · 축");
  await regularSwitch(page).click();
  await expect(chart).toHaveAttribute("data-bar-count", String(PRE_MARKET_BARS.length));
  await expect(cell(page).getByRole("button", { name: "다시 시도" })).toBeHidden();
  expect(barRequests.length).toBe(requestsBeforeToggleOff);
});

test("바로가기 첫 페이지가 장외 봉뿐이어도 이전 페이지에서 정규장 봉을 확보해 성공 토스트를 띄운다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(new Date("2026-11-09T10:00:00+09:00"));
  await page.addInitScript(installChartProbe);

  const dailyBars = scenario.market.page({ symbol: "005930", period: "D" }).bars;
  const back = 8;
  const targetDailyBar = dailyBars.at(-1 - back)!;
  const targetDate = new Date((targetDailyBar.t + 32_400) * 1000).toISOString().slice(0, 10);
  const jumpAfterBars = makeStepBars(kstAt(targetDate, 15, 35), 54, 300, () => 61_000);
  const jumpRegularBars = makeStepBars(kstAt(targetDate, 9, 0), 79, 300, (i) => 55_000 + i * 50);
  const cursor = jumpAfterBars[0]!.t;

  scenario.reply(
    (url) => url.pathname === "/api/bars/jump" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "5m" && url.searchParams.get("date") === targetDate && !url.searchParams.has("before"),
    { body: { symbol: "005930", venue: "combined", period: "5m", date: targetDate, bars: jumpAfterBars, nextBefore: cursor, unadjustedDays: [] } },
  );
  scenario.reply(
    (url) => url.pathname === "/api/bars/jump" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "5m" && url.searchParams.get("date") === targetDate && url.searchParams.get("before") === String(cursor),
    { body: { symbol: "005930", venue: "combined", period: "5m", date: targetDate, bars: jumpRegularBars, nextBefore: null, unadjustedDays: [] } },
  );

  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const dailyWindow: LayoutWindow = {
    id: "cell-0",
    link: null,
    kind: "chart",
    symbol: "005930",
    venue: "combined",
    period: "D",
    chartSettings: { ...DEFAULT_CHART_SETTINGS, indicators: [], panels: [], visibleBars: 50 },
  };
  const minuteWindow: LayoutWindow = {
    id: "cell-1",
    link: null,
    kind: "chart",
    symbol: "005930",
    venue: "combined",
    period: "5m",
    chartSettings: { ...DEFAULT_CHART_SETTINGS, indicators: [], panels: [], visibleBars: 50, regularHoursOnly: true },
  };
  scenario.documents.saveLayout({
    ...layout,
    windows: [dailyWindow, minuteWindow],
    placement: {
      v: 1,
      dock: {
        root: {
          kind: "split",
          dir: "row",
          ratio: 0.5,
          first: { kind: "group", id: "g1", tabs: ["cell-0"], active: "cell-0" },
          second: { kind: "group", id: "g2", tabs: ["cell-1"], active: "cell-1" },
        },
        floats: [],
      },
      canvas: null,
    },
    revision: layout.revision + 1,
  });

  await page.goto("/");
  await expect(cell(page, 1)).toHaveAttribute("aria-busy", "false");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => window.chartProbes?.length ?? 0)).toBeGreaterThanOrEqual(2);

  const idx = dailyBars.length - 1 - back;
  await page.evaluate(({ index }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    probe?.chart.timeScale().setVisibleLogicalRange({ from: index - 49, to: index });
  }, { index: idx });
  await expect.poll(() => page.evaluate(({ time }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    const x = probe?.chart.timeScale().timeToCoordinate(time);
    return x !== null && x !== undefined;
  }, { time: toChartTime(dailyBars[idx - 12]!.t) })).toBe(true);

  const clickAt = await page.evaluate(({ time }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    const x = probe!.chart.timeScale().timeToCoordinate(time)!;
    const box = probe!.chart.chartElement().getBoundingClientRect();
    return { x: box.x + x, y: box.y + box.height * 0.4 };
  }, { time: toChartTime(dailyBars[idx - 12]!.t) });

  await page.mouse.click(clickAt.x, clickAt.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
  await menu.getByRole("menuitem", { name: `바로가기 · ${targetDate}` }).click();

  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(jumpRegularBars.at(-1)!.t));
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-bar-count", String(jumpRegularBars.length));
  await expect(page.locator(".ui-toast")).toContainText(`5분 차트를 ${targetDate} 기준으로 옮겼습니다`);
});

test("정규장만 보기 중 장외 실시간 수급 틱이 CVD·프로그램 지표와 시간축에 누수되지 않고 토글 전환 시 재조회하지 않는다", async ({ page, scenario }) => {
  const cvdPanel = "p-cvd";
  const programPanel = "p-program";
  const cvdIndicator: IndicatorConfig = {
    id: "ind-cvd",
    spec: KINDS.tickCvd.defaults,
    panel: cvdPanel,
    visible: true,
    style: { colors: ["ind-1", "ind-2", "ind-3", "ind-4"], width: 1 },
  };
  const programIndicator: IndicatorConfig = {
    id: "ind-program",
    spec: KINDS.programFlow.defaults,
    panel: programPanel,
    visible: true,
    style: { colors: ["ind-1", "ind-2"], width: 1 },
  };
  const cvdRequests: string[] = [];
  const programRequests: string[] = [];
  const shortAfterBars = makeStepBars(kstAt(DAY, 15, 33), 9, 180, () => 90_000);
  const microDayBars: Bar[] = [...PRE_MARKET_BARS, ...REGULAR_BARS, ...shortAfterBars];

  await page.addInitScript(installChartProbe);
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "3m",
    { body: { symbol: "005930", venue: "combined", period: "3m", bars: microDayBars, current: null, nextBefore: null, seq: 10 } },
  );
  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/tick-cvd$/.test(url.pathname),
    (request): { body: TickCvdPage } => {
      cvdRequests.push(request.url());
      return {
        body: {
          symbol: "005930",
          period: "3m",
          state: "ready",
          points: microDayBars.map((b) => ({
            t: b.t,
            whaleNetMillionWon: 150,
            largeNetMillionWon: 0,
            midNetMillionWon: 0,
            retailNetMillionWon: -30,
          })),
        },
      };
    },
  );
  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/program-series$/.test(url.pathname),
    (request): { body: ProgramSeriesPage } => {
      programRequests.push(request.url());
      return {
        body: {
          symbol: "005930",
          period: "3m",
          state: "ready",
          points: microDayBars.map((b) => ({
            t: b.t,
            netBuyAmountMillionWon: 240,
            netBuyQty: 3000,
            buyAmountMillionWon: 500,
            sellAmountMillionWon: 260,
            programSharePct: 18.5,
          })),
        },
      };
    },
  );

  seedChart(scenario, "3m", {
    regularHoursOnly: false,
    indicators: [cvdIndicator, programIndicator],
    panels: [{ id: cvdPanel, stretch: 0.25 }, { id: programPanel, stretch: 0.25 }],
  });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const cvdRow = cell(page).locator(`[data-indicator-row="${cvdIndicator.id}"]`);
  const programRow = cell(page).locator(`[data-indicator-row="${programIndicator.id}"]`);
  await expect(cvdRow).toContainText("초대형 +1.50억");
  await expect(programRow).toContainText("순매수 +2.40억");

  const cvdCountBeforeToggle = cvdRequests.length;
  const programCountBeforeToggle = programRequests.length;
  await openChartSettings(page, "봉 · 축");
  await regularSwitch(page).click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", String(REGULAR_BARS.length));
  await expect(cvdRow).toContainText("초대형 +1.50억");
  await expect(programRow).toContainText("순매수 +2.40억");
  expect(cvdRequests.length).toBe(cvdCountBeforeToggle);
  expect(programRequests.length).toBe(programCountBeforeToggle);

  await pollSaved(() => scenario.live.messages.some((m) => m.type === "subscribe_feed" && m.kind === "trades")).toBe(true);
  await pollSaved(() => scenario.live.messages.some((m) => m.type === "subscribe_feed" && m.kind === "program")).toBe(true);
  const tradeSub = scenario.live.messages.find(
    (m): m is Extract<typeof m, { type: "subscribe_feed" }> => m.type === "subscribe_feed" && m.kind === "trades",
  )!.sub;
  const programSub = scenario.live.messages.find(
    (m): m is Extract<typeof m, { type: "subscribe_feed" }> => m.type === "subscribe_feed" && m.kind === "program",
  )!.sub;

  const afterHoursT = kstAt(DAY, 16, 0);
  scenario.live.emit({
    type: "feed_trades",
    sub: tradeSub,
    seq: 1,
    trades: [{ t: afterHoursT + 10, price: 100_000, qty: 2_000, venue: "nxt", strength: 120 }],
  });
  scenario.live.emit({
    type: "feed_program",
    sub: programSub,
    row: {
      t: afterHoursT + 10,
      price: 100_000,
      sellQty: 100,
      sellAmount: 10,
      buyQty: 10_000,
      buyAmount: 1000,
      netQty: 9_900,
      netQtyChange: 6_900,
      netAmount: 990,
      netAmountChange: 750,
    },
  });

  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(cvdRow).toContainText("초대형 +1.50억");
  await expect(programRow).toContainText("순매수 +2.40억");
  const afterHoursIndex = await page.evaluate(
    (time) => window.chartProbes[0]?.chart.timeScale().timeToIndex(time as never, false) ?? null,
    toChartTime(afterHoursT),
  );
  expect(afterHoursIndex).toBeNull();

  await regularSwitch(page).click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", String(microDayBars.length));
  await expect(cvdRow).toContainText("초대형 +3.50억");
  await expect(programRow).toContainText("순매수 +9.90억");
  expect(cvdRequests.length).toBe(cvdCountBeforeToggle);
  expect(programRequests.length).toBe(programCountBeforeToggle);
});
