import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import type { ApiError } from "../src/api/generated/ApiError";
import { KINDS } from "../src/chart/indicators/kinds";
import type { ChartSettings } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, type Scenario, test, withFirstChart } from "./harness";

interface PaintedLabel { color: string; background: [number, number, number, number] }
declare global { interface Window { paintedLabels: Record<string, PaintedLabel> } }

function installLabelProbe() {
  window.paintedLabels = {};
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (value, x, y, maxWidth) {
    const box = this.canvas.getBoundingClientRect();
    if (box.width > 0 && box.width <= 100 && /^[\d,]+$/.test(value)) {
      const transform = this.getTransform();
      const ratio = this.canvas.width / box.width;
      const pixel = this.getImageData(Math.max(0, Math.round(x * transform.a + transform.e - 2 * ratio)), Math.round(y * transform.d + transform.f), 1, 1).data;
      window.paintedLabels[value] = { color: String(this.fillStyle), background: [pixel[0]!, pixel[1]!, pixel[2]!, pixel[3]!] };
    }
    return fillText.call(this, value, x, y, maxWidth);
  };
}

const channels = (css: string): [number, number, number] => {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css);
  if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)];
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (!rgb) throw new Error(`색을 읽을 수 없습니다: ${css}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
};
const luminance = ([r, g, b]: readonly number[]) => {
  const [lr, lg, lb] = [r!, g!, b!].map((value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
};
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

const LAST_DAY = Date.parse("2026-11-06T00:00:00+09:00") / 1000;
type Direction = "up" | "down";

function replyBars(scenario: Scenario, closeOf: (daysAgo: number) => number, direction: Direction = "up") {
  const bars = Array.from({ length: 130 }, (_, i) => {
    const close = closeOf(129 - i);
    const open = direction === "up" ? close - 500 : close + 500;
    return { t: LAST_DAY - (129 - i) * 86400, o: open, h: Math.max(open, close) + 500, l: Math.min(open, close) - 500, c: close, v: 1_000_000 };
  });
  scenario.reply("/api/bars", { body: { symbol: "005930", venue: "combined", period: "D", bars, current: null, nextBefore: null, seq: null } });
}

async function openChart(page: Page) {
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installLabelProbe);
  await page.goto("/?symbol=005930&period=D");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
}

const stopped: ApiError = { error: { code: "kiwoom_auth_failed", message: "인증에 실패했습니다 [8050] 지정단말기 인증에 실패했습니다", reason: "auth_blocked", retryAt: null, manualActionRequired: true } };
const unavailable: ApiError = { error: { code: "kiwoom_unavailable", message: "키움 조회가 응답하지 않습니다", reason: null, retryAt: null, manualActionRequired: false } };

for (const direction of ["up", "down"] as const) {
  test(`${direction === "up" ? "상승" : "하락"} 종목의 현재가 꼬리표는 글자와 바탕의 대비가 4.5:1 이상이다`, async ({ page, scenario }) => {
    replyBars(scenario, (daysAgo) => 195_000 - daysAgo * 100, direction);
    await openChart(page);
    await expect.poll(() => page.evaluate(() => window.paintedLabels["195,000"] !== undefined)).toBe(true);
    const { color, background } = await page.evaluate(() => window.paintedLabels["195,000"]!);
    expect(background[3]).toBe(255);
    expect(contrast(channels(color), background)).toBeGreaterThanOrEqual(4.5);
    const chartText = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--on-data").trim());
    expect(channels(color)).toEqual(channels(chartText));
  });
}

test("가격이 1,523,000인 종목도 가격축 글자는 11px 이상이고 축 폭은 72·80·88 가운데 하나다", async ({ page, scenario }) => {
  replyBars(scenario, (daysAgo) => 1_523_000 - daysAgo * 2000);
  await openChart(page);
  await expect.poll(() => page.evaluate(() => window.paintedLabels["1,523,000"] !== undefined)).toBe(true);
  expect(await page.evaluate(() => window.chartProbe.chart.options().layout.fontSize)).toBeGreaterThanOrEqual(11);
  await expect.poll(() => page.evaluate(() => window.chartProbe.chart.priceScale("right").width())).toBeGreaterThan(72);
  expect([72, 80, 88]).toContain(await page.evaluate(() => window.chartProbe.chart.priceScale("right").width()));
});

test("MACD 패널의 축 꼬리표는 MACD 선 하나다", async ({ page, scenario }) => {
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings: ChartSettings = {
    v: 2, style: "candle", scale: "normal", visibleBars: null, showExtremes: false, showLegend: true, showOhlcChange: false, extremeBasis: "last", showDaySeparators: false, showHorzGrid: true, showVertGrid: true, compare: [],
    indicators: [{ id: "macd", spec: KINDS.macd.defaults, panel: "p0", visible: true, style: { colors: ["ind-1", "ind-2", "ind-3"], width: 1 } }],
    panels: [{ id: "p0", stretch: 0.3 }],
  };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D", chartSettings }) });
  await openChart(page);
  await expect.poll(() => page.evaluate(() => window.chartProbe.chart.panes()[1]?.getSeries().filter((series) => series.data().length > 0).length)).toBe(3);
  const labelled = await page.evaluate(() => window.chartProbe.chart.panes()[1]!.getSeries().filter((series) => series.options().lastValueVisible).map((series) => series.seriesType()));
  expect(labelled).toHaveLength(1);
  expect(labelled).not.toContain("Histogram");
});

test("봉 조회가 수동 조치를 요구하는 오류면 칸 안의 시스템 설정 열기로 시스템 설정을 연다", async ({ page, scenario }) => {
  scenario.reply("/api/bars", { status: 503, body: stopped });
  await page.goto("/");
  const alert = cell(page).getByRole("alert");
  await expect(alert).toContainText("[8050]");
  await expect(alert.getByRole("button", { name: "다시 시도" })).toHaveCount(0);
  await alert.getByRole("button", { name: "시스템 설정 열기" }).click();
  await expect(page.getByRole("dialog", { name: "시스템 설정", exact: true })).toBeVisible();
});

test("오류 상태의 다시 시도는 테두리 있는 버튼이고 칸 가운데에 놓인다", async ({ page, scenario }) => {
  scenario.reply("/api/bars", { status: 503, body: unavailable });
  await page.goto("/");
  const retry = cell(page).getByRole("alert").getByRole("button", { name: "다시 시도" });
  await expect(retry).toBeVisible();
  expect(await retry.evaluate((node) => { const style = getComputedStyle(node); return { width: style.borderTopWidth, style: style.borderTopStyle }; })).toEqual({ width: "1px", style: "solid" });
  const button = (await retry.boundingBox())!;
  const area = (await cell(page).boundingBox())!;
  expect(Math.abs(button.x + button.width / 2 - (area.x + area.width / 2))).toBeLessThanOrEqual(2);
});

test("불러오는 중 글자는 0.4초가 지나야 보이고 그 안에 응답이 오면 끝내 보이지 않는다", async ({ page, scenario }) => {
  const held = scenario.hold((url) => url.pathname === "/api/bars");
  await page.goto("/");
  await held.received;
  const label = cell(page).getByText("차트 불러오는 중", { exact: true });
  await expect(cell(page)).toHaveAttribute("aria-busy", "true");
  const visibilityAt = (milliseconds: number) => label.evaluate((node, time) => {
    const delayed = node.getAnimations()[0]!;
    delayed.pause();
    delayed.currentTime = time;
    return getComputedStyle(node).visibility;
  }, milliseconds);
  expect(await visibilityAt(0)).toBe("hidden");
  expect(await visibilityAt(399)).toBe("hidden");
  expect(await visibilityAt(400)).toBe("visible");
  expect(await visibilityAt(399)).toBe("hidden");
  held.reply({ body: scenario.market.page({ symbol: "005930" }) });
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(label).toHaveCount(0);
});
