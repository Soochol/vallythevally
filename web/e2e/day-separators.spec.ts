import type { Page } from "@playwright/test";
import type { UTCTimestamp } from "lightweight-charts";
import type { Bar } from "../src/api/generated/Bar";
import { type ChartSettings, DEFAULT_CHART_SETTINGS } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test, firstChart, withFirstChart } from "./harness";

const KST = 32_400;
const BARS_PER_DAY = 40;
const DAYS = ["2026-11-04", "2026-11-05", "2026-11-06"];
const minuteBars: Bar[] = DAYS.flatMap((day, d) => Array.from({ length: BARS_PER_DAY }, (_, i) => {
  const c = 50_000 + ((i + d) % 7) * 300 - (i % 3) * 450;
  return { t: Date.parse(`${day}T09:00:00+09:00`) / 1000 + i * 180, o: c - 150, h: c + 600, l: c - 700, c, v: 1000 + ((i * 37) % 11) * 400 };
}));
const DAY_STARTS = DAYS.slice(1).map((_, d) => (d + 1) * BARS_PER_DAY);
const SEPARATED = DAY_STARTS.map((i) => [minuteBars[i - 1]!.t + KST, minuteBars[i]!.t + KST] as const);
const INK_CHANGED = 300;

const saved = (scenario: Scenario) => firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings as ChartSettings;
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const popover = (page: Page) => page.getByRole("dialog", { name: "차트 설정", exact: true });
const daySwitch = (page: Page) => popover(page).getByRole("switch", { name: "날짜 구분선" });

function openMinute(scenario: Scenario, settings: Partial<ChartSettings> = {}) {
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "3m",
    { body: { symbol: "005930", venue: "combined", period: "3m", bars: minuteBars, current: null, nextBefore: null, seq: null } });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "3m",
    chartSettings: { ...DEFAULT_CHART_SETTINGS, ...settings } }) });
}

async function open(page: Page) {
  await page.addInitScript(installChartProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => window.chartProbe?.chart.timeScale().timeToCoordinate(0 as UTCTimestamp) !== undefined)).toBe(true);
}

async function setSwitch(page: Page, on: boolean) {
  if (!await popover(page).isVisible()) await toolbar(page).getByRole("button", { name: "차트 설정", exact: true }).click();
  if (await daySwitch(page).getAttribute("aria-checked") !== String(on)) await daySwitch(page).click();
  await expect(daySwitch(page)).toHaveAttribute("aria-checked", String(on));
  await afterPaint(page);
}

async function choosePeriod(page: Page, button: string, label: string) {
  if (await popover(page).isVisible()) await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await toolbar(page).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: button, exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", new RegExp(` ${label}$`));
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await afterPaint(page);
}

const afterPaint = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

type PaneInk = { ratio: number; ink: number[] };

const paneInk = (page: Page): Promise<PaneInk[]> => page.evaluate(() => window.chartProbe.chart.panes().map((pane) => {
  const canvas = pane.getHTMLElement()!.querySelector("canvas")!;
  const { width, height } = canvas;
  const data = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  const ink = new Array<number>(width).fill(0);
  for (let i = 0; i < data.length; i += 4) ink[(i / 4) % width]! += data[i]! + data[i + 1]! + data[i + 2]!;
  return { ratio: width / canvas.clientWidth, ink };
}));

async function stableInk(page: Page): Promise<PaneInk[]> {
  let last = await paneInk(page);
  await expect(async () => {
    await afterPaint(page);
    const now = await paneInk(page);
    const same = JSON.stringify(now) === JSON.stringify(last);
    last = now;
    expect(same).toBe(true);
  }).toPass();
  return last;
}

function changedAt(on: PaneInk, off: PaneInk): number[] {
  const columns = on.ink.flatMap((ink, x) => Math.abs(ink - (off.ink[x] ?? 0)) > INK_CHANGED ? [x] : []);
  const runs: number[][] = [];
  for (const x of columns) {
    const run = runs.at(-1);
    if (run && x - run.at(-1)! <= 1) run.push(x);
    else runs.push([x]);
  }
  return runs.map((run) => (run[0]! + run.at(-1)! + 1) / 2 / on.ratio);
}

const midpoints = (page: Page) => page.evaluate((pairs) => {
  const scale = window.chartProbe.chart.timeScale();
  return pairs.map(([before, after]) => (scale.timeToCoordinate(before as UTCTimestamp)! + scale.timeToCoordinate(after as UTCTimestamp)!) / 2);
}, SEPARATED);

async function separatorsAt(page: Page): Promise<number[][]> {
  await setSwitch(page, true);
  const on = await stableInk(page);
  await setSwitch(page, false);
  const off = await stableInk(page);
  await setSwitch(page, true);
  return on.map((pane, i) => changedAt(pane, off[i]!));
}

async function expectSeparatorsOnEveryPane(page: Page, panes: number) {
  const want = await midpoints(page);
  expect(want).toHaveLength(DAY_STARTS.length);
  const drawn = await separatorsAt(page);
  expect(drawn).toHaveLength(panes);
  for (const xs of drawn) {
    expect(xs).toHaveLength(want.length);
    xs.forEach((x, i) => expect(Math.abs(x - want[i]!)).toBeLessThanOrEqual(1));
  }
}

test("분봉에서 날짜 구분선을 켜면 가격·거래량 패널의 날짜가 바뀌는 자리마다 두 봉 한가운데에 긋고, 일봉에서는 긋지 않는다", async ({ page, scenario }) => {
  openMinute(scenario);
  await open(page);
  await setSwitch(page, false);
  expect(saved(scenario).showDaySeparators).toBe(false);

  await expectSeparatorsOnEveryPane(page, 2);
  await expect.poll(() => saved(scenario).showDaySeparators).toBe(true);

  await choosePeriod(page, "일", "일");
  const daily = await stableInk(page);
  await setSwitch(page, false);
  expect(await stableInk(page)).toEqual(daily);
  await setSwitch(page, true);
  expect(await stableInk(page)).toEqual(daily);

  await choosePeriod(page, "분봉", "3분");
  await expectSeparatorsOnEveryPane(page, 2);
});

test("새로고침 뒤에도 날짜 구분선 스위치가 켜져 있고 구분선을 긋는다", async ({ page, scenario }) => {
  openMinute(scenario);
  await open(page);
  await setSwitch(page, true);
  await expect.poll(() => saved(scenario).showDaySeparators).toBe(true);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await setSwitch(page, true);
  await expect(daySwitch(page)).toHaveAttribute("aria-checked", "true");
  await expectSeparatorsOnEveryPane(page, 2);
  expect(saved(scenario).showDaySeparators).toBe(true);
});

test("지표 패널을 더하면 새 패널에도 날짜 구분선을 긋는다", async ({ page, scenario }) => {
  openMinute(scenario, { showDaySeparators: true });
  await open(page);
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창", exact: true });
  await dialog.getByRole("combobox", { name: "지표·비교 찾기" }).fill("RSI");
  await dialog.getByRole("option", { name: "RSI 14 추가 후보", exact: true }).click();
  await dialog.getByRole("button", { name: "RSI 14 추가", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-indicator-row]").filter({ hasText: "RSI 14" }).last()).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.chartProbe.chart.panes().length)).toBe(3);
  await expectSeparatorsOnEveryPane(page, 3);
});

test("1024x768에서 날짜 구분선 스위치를 포함한 차트 설정 팝오버의 모든 조작이 창 안에 있다", async ({ page, scenario }) => {
  openMinute(scenario);
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page);
  await setSwitch(page, true);
  await expect(daySwitch(page)).toHaveAttribute("title", "분봉에서 날짜가 바뀌는 자리에 세로선");
  for (const control of await popover(page).locator("button, input").all()) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1024);
    expect(box.y + box.height).toBeLessThanOrEqual(768);
  }
});
