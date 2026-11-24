import type { Page } from "@playwright/test";
import type { UTCTimestamp } from "lightweight-charts";
import type { Bar } from "../src/api/generated/Bar";
import { DEFAULT_CHART_SETTINGS } from "../src/chart/settings";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { cell, DEFAULT_LAYOUT_ID, expect, type Scenario, test, withFirstChart } from "./harness";

const CODE = "005930";
const DAY_1 = "2026-11-19";
const DAY_2 = "2026-11-20";
const BARS_PER_DAY = 30;

const minuteBars: Bar[] = [DAY_1, DAY_2].flatMap((day, d) =>
  Array.from({ length: BARS_PER_DAY }, (_, i) => {
    const c = 60_000 + ((i + d) % 5) * 200 - (i % 3) * 150;
    return {
      t: Date.parse(`${day}T09:00:00+09:00`) / 1000 + i * 300,
      o: c - 100,
      h: c + 300,
      l: c - 300,
      c,
      v: 1000 + i * 50,
    };
  }),
);

const DAY_1_START = minuteBars[0]!.t;
const DAY_1_END = minuteBars[BARS_PER_DAY - 1]!.t;
const DAY_2_START = minuteBars[BARS_PER_DAY]!.t;
const DAY_2_END = minuteBars[minuteBars.length - 1]!.t;

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const replayToggle = (page: Page) => toolbar(page).getByRole("button", { name: "호가 복기", exact: true });
const afterPaint = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

function seedMinuteChart(scenario: Scenario) {
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === CODE && url.searchParams.get("period") === "5m",
    { body: { symbol: CODE, venue: "combined", period: "5m", bars: minuteBars, current: null, nextBefore: null, seq: null } },
  );
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({
    ...layout,
    revision: layout.revision + 1,
    windows: withFirstChart(layout, {
      symbol: CODE,
      venue: "combined",
      period: "5m",
      chartSettings: { ...DEFAULT_CHART_SETTINGS, visibleBars: 80 },
    }),
  });
}

async function accentBottomColumns(page: Page, range?: { from: number; to: number }): Promise<number> {
  return page.evaluate(
    (bounds) => {
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      const swatch = document.createElement("canvas");
      swatch.width = 1;
      swatch.height = 1;
      const swatchCtx = swatch.getContext("2d")!;
      swatchCtx.fillStyle = accent;
      swatchCtx.fillRect(0, 0, 1, 1);
      const [ar, ag, ab] = swatchCtx.getImageData(0, 0, 1, 1).data;

      const chart = window.chartProbe.chart;
      const pane = chart.panes()[0]!;
      const canvas = pane.getHTMLElement()!.querySelector("canvas")!;
      const { width, height } = canvas;
      const ratioX = width / canvas.clientWidth;
      const ratioY = height / canvas.clientHeight;

      let colFrom = 0;
      let colTo = width - 1;
      if (bounds !== null) {
        const scale = chart.timeScale();
        const xStart = scale.timeToCoordinate(bounds.from as UTCTimestamp);
        const xEnd = scale.timeToCoordinate(bounds.to as UTCTimestamp);
        if (xStart === null || xEnd === null) return 0;
        colFrom = Math.max(0, Math.floor(Math.min(xStart, xEnd) * ratioX));
        colTo = Math.min(width - 1, Math.ceil(Math.max(xStart, xEnd) * ratioX));
      }

      const band = Math.max(2, Math.ceil(4 * ratioY));
      const data = canvas.getContext("2d")!.getImageData(0, height - band, width, band).data;

      let matched = 0;
      for (let x = colFrom; x <= colTo; x++) {
        let hit = false;
        for (let y = 0; y < band; y++) {
          const i = (y * width + x) * 4;
          if (
            data[i + 3]! >= 200 &&
            Math.abs(data[i]! - ar!) <= 20 &&
            Math.abs(data[i + 1]! - ag!) <= 20 &&
            Math.abs(data[i + 2]! - ab!) <= 20
          ) {
            hit = true;
            break;
          }
        }
        if (hit) matched++;
      }
      return matched;
    },
    range ? { from: toChartTime(range.from), to: toChartTime(range.to) } : null,
  );
}

test("호가 복기를 켜면 수집된 날 아래에만 연두 선을 긋고 끄면 지운다", async ({ page, scenario }) => {
  seedMinuteChart(scenario);
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  let daysRequests = 0;
  scenario.on(
    (url) => url.pathname === `/api/symbols/${CODE}/book-replay/days`,
    () => {
      daysRequests++;
      return { body: { symbol: CODE, days: ["20261120"] } };
    },
  );

  await page.addInitScript(installChartProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => window.chartProbe?.chart.timeScale().timeToCoordinate(0 as UTCTimestamp) !== undefined)).toBe(true);
  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "false");
  await afterPaint(page);

  expect(daysRequests).toBe(0);
  expect(await accentBottomColumns(page)).toBe(0);

  await replayToggle(page).click();
  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => daysRequests).toBe(1);
  await expect.poll(() => accentBottomColumns(page, { from: DAY_2_START, to: DAY_2_END })).toBeGreaterThan(20);
  expect(await accentBottomColumns(page, { from: DAY_1_START, to: DAY_1_END })).toBe(0);

  await toolbar(page).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "일", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", / 일$/);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await afterPaint(page);
  await expect.poll(() => accentBottomColumns(page)).toBe(0);

  await toolbar(page).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "분봉", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", / 5분$/);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => accentBottomColumns(page, { from: DAY_2_START, to: DAY_2_END })).toBeGreaterThan(20);
  expect(await accentBottomColumns(page, { from: DAY_1_START, to: DAY_1_END })).toBe(0);

  await replayToggle(page).click();
  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "false");
  await afterPaint(page);
  await expect.poll(() => accentBottomColumns(page)).toBe(0);
});
