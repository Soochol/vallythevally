import type { Page } from "@playwright/test";
import type { DayHistory } from "../src/api/generated/DayHistory";
import type { InvestorNetSharesDay } from "../src/api/generated/InvestorNetSharesDay";
import type { KstDate } from "../src/api/generated/KstDate";
import type { Layout } from "../src/api/generated/Layout";
import type { ProgramSeriesPage } from "../src/api/generated/ProgramSeriesPage";
import { kstDateOf } from "../src/chart/barJump";
import { parseChartSettings } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { cell, DEFAULT_LAYOUT_ID, expect, firstChart, pollSaved, test, withFirstChart } from "./harness";
import { useCenterIndicatorWindow } from "./indicator-window";
import { selectMinute } from "./select-option";

function investorRow(day: KstDate, foreign: number, institution: number): InvestorNetSharesDay {
  return {
    day,
    individual: -(foreign + institution),
    foreign,
    institution,
    financialInvestment: 0,
    insurance: 0,
    investmentTrust: 0,
    otherFinancial: 0,
    bank: 0,
    pensionFund: 0,
    privateFund: 0,
    government: 0,
    otherCorporation: 0,
  };
}

function addDays(date: KstDate, offset: number): KstDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const leftAxisVisible = (page: Page) => page.evaluate(() => window.chartProbe.chart.priceScale("left").options().visible);
const paneCount = (page: Page) => page.evaluate(() => window.chartProbe.chart.panes().length);

async function paneBoxes(page: Page) {
  return page.evaluate(() => {
    const chartEl = window.chartProbe.chart.chartElement();
    const chartRect = chartEl.getBoundingClientRect();
    return window.chartProbe.chart.panes().map((pane) => {
      const rect = pane.getHTMLElement()?.getBoundingClientRect();
      return {
        x: chartRect.left,
        width: chartRect.width,
        top: rect?.top ?? chartRect.top,
        height: pane.getHeight(),
      };
    });
  });
}

async function dragRowTo(page: Page, id: string, targetX: number, targetY: number) {
  const grip = cell(page).locator(`[data-indicator-row="${id}"] [data-indicator-grip]`);
  const box = await grip.boundingBox();
  if (!box) throw new Error(`그립 손잡이가 없습니다: ${id}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 10 });
  await page.mouse.up();
}

test("일봉에서 외국인·기관·프로그램 순매수를 추가하고 단일 요청 공유, 표시·집계·단위 전환과 주봉 롤업을 확인한다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  const dailySample = scenario.market.page({ symbol: "005930", period: "D", venue: "combined" });
  const dailyBars = dailySample.current ? [...dailySample.bars, dailySample.current] : dailySample.bars;
  const lastDaily = dailyBars[dailyBars.length - 1]!;
  const prevDaily = dailyBars[dailyBars.length - 2]!;
  const lastDailyDate = kstDateOf(lastDaily.t);
  const prevDailyDate = kstDateOf(prevDaily.t);

  const weeklySample = scenario.market.page({ symbol: "005930", period: "W", venue: "combined" });
  const weeklyBars = weeklySample.current ? [...weeklySample.bars, weeklySample.current] : weeklySample.bars;
  const lastWeekly = weeklyBars[weeklyBars.length - 1]!;
  const lastWeeklyDate = kstDateOf(lastWeekly.t);

  const dayMap = new Map<KstDate, InvestorNetSharesDay>();
  dayMap.set(prevDailyDate, investorRow(prevDailyDate, 100_000, -50_000));
  dayMap.set(lastDailyDate, investorRow(lastDailyDate, 200_000, -100_000));
  if (!dayMap.has(lastWeeklyDate)) {
    dayMap.set(lastWeeklyDate, investorRow(lastWeeklyDate, 150_000, 60_000));
  }
  const nextWeekDay = addDays(lastWeeklyDate, 1);
  if (!dayMap.has(nextWeekDay) && nextWeekDay !== lastDailyDate && nextWeekDay !== prevDailyDate) {
    dayMap.set(nextWeekDay, investorRow(nextWeekDay, 50_000, 40_000));
  }
  const mockedDays = [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const lastWeekEnd = addDays(lastWeeklyDate, 7);
  const expectedWeeklyShares = mockedDays
    .filter((d) => d.day >= lastWeeklyDate && d.day < lastWeekEnd)
    .reduce((sum, d) => sum + d.foreign, 0);

  const investorRequests: string[] = [];
  const programRequests: string[] = [];

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/investor-net-shares$/.test(url.pathname),
    (request) => {
      investorRequests.push(request.url());
      const u = new URL(request.url());
      const from = u.searchParams.get("from") ?? "";
      const to = u.searchParams.get("to") ?? "";
      const body: DayHistory<InvestorNetSharesDay> = {
        symbol: "005930",
        from,
        to,
        coverage: { kind: "whole_range" },
        days: mockedDays,
        source: "kiwoom",
        skippedDays: [],
        undatedRows: [],
      };
      return { body };
    },
  );

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/program-series$/.test(url.pathname),
    (request) => {
      programRequests.push(request.url());
      const u = new URL(request.url());
      const period = u.searchParams.get("period") ?? "D";
      const pts = period === "W"
        ? [{ t: lastWeekly.t, netBuyAmountMillionWon: 500, netBuyQty: 7_000, buyAmountMillionWon: 900, sellAmountMillionWon: 400, programSharePct: 19.0 }]
        : [
            { t: prevDaily.t, netBuyAmountMillionWon: 120, netBuyQty: 1_500, buyAmountMillionWon: 300, sellAmountMillionWon: 180, programSharePct: 16.0 },
            { t: lastDaily.t, netBuyAmountMillionWon: 230, netBuyQty: 3_000, buyAmountMillionWon: 500, sellAmountMillionWon: 270, programSharePct: 21.0 },
          ];
      const body: ProgramSeriesPage = {
        symbol: "005930",
        period: period as ProgramSeriesPage["period"],
        state: "ready",
        points: pts,
      };
      return { body };
    },
  );

  await page.goto("/?symbol=005930&period=D");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: /^지표/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "지표 추가", exact: true }).click();
  await dialog.getByRole("option", { name: "외국인 순매수 추가 후보", exact: true }).click();
  await dialog.getByRole("button", { name: "외국인 순매수 추가", exact: true }).click();
  await dialog.getByRole("option", { name: "기관 순매수 추가 후보", exact: true }).click();
  await dialog.getByRole("button", { name: "기관 순매수 추가", exact: true }).click();
  await dialog.getByRole("option", { name: "프로그램 수급 추가 후보", exact: true }).click();
  await dialog.getByRole("button", { name: "프로그램 수급 추가", exact: true }).click();
  await dialog.getByRole("button", { name: "입력창 닫기", exact: true }).click();

  const foreignRow = cell(page).locator("[data-indicator-row]").filter({ hasText: "외국인 순매수" });
  const instRow = cell(page).locator("[data-indicator-row]").filter({ hasText: "기관 순매수" });
  const progRow = cell(page).locator("[data-indicator-row]").filter({ hasText: "프로그램 수급" });

  const expectedForeignEok = ((200_000 * lastDaily.c) / 1e8).toFixed(2);
  const expectedInstEok = ((100_000 * lastDaily.c) / 1e8).toFixed(2);
  await expect(foreignRow).toContainText(`순매수 +${expectedForeignEok}억`);
  await expect(instRow).toContainText(`순매수 −${expectedInstEok}억`);
  await expect(progRow).toContainText("순매수 +3.50억");

  expect(investorRequests).toHaveLength(1);
  expect(programRequests.some((u) => new URL(u).searchParams.get("period") === "D")).toBe(true);

  await foreignRow.locator("[data-indicator-edit]").first().click();
  const popover = page.getByRole("dialog", { name: "외국인 순매수 설정" });

  await popover.getByRole("group", { name: "단위" }).getByRole("button", { name: "주", exact: true }).click();
  await expect(foreignRow).toContainText("순매수 +20.0만주");

  await popover.getByRole("group", { name: "집계 방식" }).getByRole("button", { name: "누적", exact: true }).click();
  await expect(foreignRow).toContainText("순매수 +30.0만주");

  await popover.getByRole("group", { name: "표시 형태" }).getByRole("button", { name: "라인", exact: true }).click();
  await expect(popover.getByRole("group", { name: "굵기" })).toBeVisible();

  await popover.getByRole("group", { name: "표시 형태" }).getByRole("button", { name: "바+누적선", exact: true }).click();
  await expect(popover.getByRole("group", { name: "집계 방식" }).getByRole("button", { name: "봉별", exact: true })).toBeDisabled();
  await expect(foreignRow).toContainText("순매수 +20.0만주");
  await expect(foreignRow).toContainText("누적 +30.0만주");

  await popover.getByRole("group", { name: "표시 형태" }).getByRole("button", { name: "세로 바", exact: true }).click();
  await popover.getByRole("group", { name: "집계 방식" }).getByRole("button", { name: "봉별", exact: true }).click();
  await popover.getByRole("button", { name: "설정 닫기" }).click();

  const periods = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" });
  await periods.getByRole("button", { name: "주", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const weekExpectedShares = `+${(expectedWeeklyShares / 1e4).toFixed(1)}만주`;
  await expect(foreignRow).toContainText(`순매수 ${weekExpectedShares}`);
  await expect(progRow).toContainText("순매수 +5.00억");
});

test("분봉으로 전환하면 외국인·기관은 설정을 보존한 채 안내 문구를 보이고 프로그램 수급은 계속 동작한다", async ({ page, scenario }) => {
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings = {
    v: 2,
    style: "candle",
    scale: "normal",
    compare: [],
    indicators: [
      { id: "foreign-1", spec: { kind: "foreignFlow", displayMode: "both", aggregation: "bar", unit: "shares" }, panel: "p-foreign", visible: true, style: { colors: ["ind-1", "ind-2"], width: 1 } },
      { id: "inst-1", spec: { kind: "institutionFlow", displayMode: "histogram", aggregation: "bar", unit: "eok" }, panel: "p-inst", visible: true, style: { colors: ["ind-3"], width: 1 } },
      { id: "prog-1", spec: { kind: "programFlow", displayMode: "histogram", aggregation: "cumulative", unit: "eok", showShare: false }, panel: "p-prog", visible: true, style: { colors: ["ind-4"], width: 1 } },
    ],
    panels: [
      { id: "p-foreign", stretch: 0.25 },
      { id: "p-inst", stretch: 0.25 },
      { id: "p-prog", stretch: 0.25 },
    ],
  };
  scenario.documents.saveLayout({
    ...layout,
    revision: layout.revision + 1,
    windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D", chartSettings }),
  });

  const minSample = scenario.market.page({ symbol: "005930", period: "5m", venue: "combined" });
  const minBars = minSample.current ? [...minSample.bars, minSample.current] : minSample.bars;
  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/program-series$/.test(url.pathname),
    (request) => {
      const period = new URL(request.url()).searchParams.get("period") ?? "5m";
      const body: ProgramSeriesPage = {
        symbol: "005930",
        period: period as ProgramSeriesPage["period"],
        state: "ready",
        points: minBars.map((b) => ({
          t: b.t,
          netBuyAmountMillionWon: 180,
          netBuyQty: 2_000,
          buyAmountMillionWon: 350,
          sellAmountMillionWon: 170,
          programSharePct: 14.5,
        })),
      };
      return { body };
    },
  );

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const periods = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" });
  await selectMinute(periods.getByRole("button", { name: "분봉", exact: true }), "5m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const foreignRow = cell(page).locator('[data-indicator-row="foreign-1"]');
  const instRow = cell(page).locator('[data-indicator-row="inst-1"]');
  const progRow = cell(page).locator('[data-indicator-row="prog-1"]');

  await expect(foreignRow).toContainText("주식·ETF 일봉 이상 전용");
  await expect(instRow).toContainText("주식·ETF 일봉 이상 전용");
  await expect(progRow).toContainText("순매수 +1.80억");

  await pollSaved(() =>
    parseChartSettings(firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings).indicators.find((i) => i.id === "foreign-1")?.spec,
  ).toEqual({ kind: "foreignFlow", displayMode: "both", aggregation: "bar", unit: "shares" });
});

test("기관 순매수를 외국인 순매수 패널에 합치면 우측 Y축을 공유하고 누적·주 단위로 바꾸면 좌측 Y축이 자동 활성화된다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings = {
    v: 2,
    style: "candle",
    scale: "normal",
    compare: [],
    indicators: [
      { id: "foreign-1", spec: { kind: "foreignFlow", displayMode: "histogram", aggregation: "bar", unit: "eok" }, panel: "p-foreign", visible: true, style: { colors: ["ind-1"], width: 1 } },
      { id: "inst-1", spec: { kind: "institutionFlow", displayMode: "histogram", aggregation: "bar", unit: "eok" }, panel: "p-inst", visible: true, style: { colors: ["ind-2"], width: 1 } },
    ],
    panels: [
      { id: "p-foreign", stretch: 0.25 },
      { id: "p-inst", stretch: 0.25 },
    ],
  };
  scenario.documents.saveLayout({
    ...layout,
    revision: layout.revision + 1,
    windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D", chartSettings }),
  });

  await page.addInitScript(installChartProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => paneCount(page)).toBe(3);
  expect(await leftAxisVisible(page)).toBe(false);

  const panes = await paneBoxes(page);
  const foreignPane = panes[1]!;
  await dragRowTo(page, "inst-1", foreignPane.x + foreignPane.width * 0.45, foreignPane.top + foreignPane.height * 0.5);

  await expect.poll(() => paneCount(page)).toBe(2);
  await expect.poll(() => leftAxisVisible(page)).toBe(false);
  const foreignRow = cell(page).locator('[data-indicator-row="foreign-1"]');
  const instRow = cell(page).locator('[data-indicator-row="inst-1"]');
  await expect(foreignRow.locator("[data-indicator-axis]")).toHaveText("R");
  await expect(instRow.locator("[data-indicator-axis]")).toHaveText("R");

  await instRow.locator("[data-indicator-edit]").first().click();
  const popover = page.getByRole("dialog", { name: "기관 순매수 설정" });
  await popover.getByRole("group", { name: "집계 방식" }).getByRole("button", { name: "누적", exact: true }).click();
  await expect(foreignRow.locator("[data-indicator-axis]")).toHaveText("R");
  await expect(instRow.locator("[data-indicator-axis]")).toHaveText("L");
  await expect.poll(() => leftAxisVisible(page)).toBe(true);

  await popover.getByRole("group", { name: "집계 방식" }).getByRole("button", { name: "봉별", exact: true }).click();
  await expect(instRow.locator("[data-indicator-axis]")).toHaveText("R");
  await expect.poll(() => leftAxisVisible(page)).toBe(false);

  await popover.getByRole("group", { name: "단위" }).getByRole("button", { name: "주", exact: true }).click();
  await popover.getByRole("button", { name: "설정 닫기" }).click();
  await expect(foreignRow.locator("[data-indicator-axis]")).toHaveText("R");
  await expect(instRow.locator("[data-indicator-axis]")).toHaveText("L");
  await expect.poll(() => leftAxisVisible(page)).toBe(true);
});
