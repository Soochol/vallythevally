import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import { type ChartSettings, DEFAULT_CHART_SETTINGS, type IndicatorConfig } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { chooseSettingsMenu, openChartSettings } from "./chart-settings-menu";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, firstChart, pollSaved, test, withFirstChart } from "./harness";

const DAY = 86_400;
const START = Date.parse("2024-01-01T00:00:00+09:00") / 1000;

const saved = (scenario: Scenario) => firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings as ChartSettings;
const dialog = (page: Page) => page.getByRole("dialog", { name: "차트 설정", exact: true });
const candlesOnTopSwitch = (page: Page) => dialog(page).getByRole("switch", { name: /^캔들을 지표 위에/ });
const scalePriceOnlySwitch = (page: Page) => dialog(page).getByRole("switch", { name: /^가격만 축에 맞춤/ });

function makeStepBars(highCount: number, flatCount: number): Bar[] {
  const total = highCount + flatCount;
  return Array.from({ length: total }, (_, i) => {
    const t = START + i * DAY;
    if (i < highCount) {
      return { t, o: 99_800, h: 100_200, l: 99_600, c: 100_000, v: 2_000 + (i % 7) * 100 };
    }
    const c = 50_200 + ((i - highCount) % 5) * 150;
    return { t, o: c - 50, h: c + 100, l: c - 100, c, v: 1_000 + ((i - highCount) % 9) * 100 };
  });
}

function seedChart(scenario: Scenario, chartSettings: Partial<ChartSettings>, bars: Bar[]) {
  scenario.reply(
    (url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "D",
    { body: { symbol: "005930", venue: "combined", period: "D", bars, current: null, nextBefore: null, seq: null } },
  );
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({
    ...layout,
    revision: layout.revision + 1,
    windows: withFirstChart(layout, {
      symbol: "005930",
      venue: "combined",
      period: "D",
      chartSettings: { ...DEFAULT_CHART_SETTINGS, ...chartSettings },
    }),
  });
}

async function openChart(page: Page) {
  await page.addInitScript(installChartProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function closeSettings(page: Page) {
  if (await dialog(page).isVisible()) {
    await dialog(page).getByRole("button", { name: "닫기", exact: true }).click();
  }
  await expect(dialog(page)).toBeHidden();
}

const pane0Orders = (page: Page) => page.evaluate(() => {
  const pane = window.chartProbe?.chart.panes()[0];
  if (!pane) return null;
  const list = pane.getSeries();
  let main: number | null = null;
  let mainType: string | null = null;
  let volBar: number | null = null;
  let cloud: number | null = null;
  const overlays: number[] = [];
  let loaded = 0;
  for (const series of list) {
    if (series.data().length > 0) loaded++;
    const type = series.seriesType();
    const order = series.seriesOrder();
    if (type === "Candlestick" || type === "Line" || type === "Bar" || type === "Area") {
      main = order;
      mainType = type;
    } else if (type === "Histogram") {
      volBar = order;
    } else if (type === "Custom" && "bullColor" in series.options()) {
      cloud = order;
    } else if (type === "Custom") {
      overlays.push(order);
    }
  }
  return { total: list.length, loaded, mainType, main, volBar, cloud, overlays };
});

const visiblePriceRange = (page: Page, paneIndex = 0) => page.evaluate((idx) => {
  const pane = window.chartProbe?.chart.panes()[idx];
  if (!pane) return null;
  const range = pane.priceScale("right").getVisibleRange();
  return range ? { from: range.from, to: range.to } : null;
}, paneIndex);

test("캔들을 지표 위에 스위치는 가격 패널 지표와 캔들의 그리기 순서를 바꾸고 저장·복원·지표 추가·봉 모양 전환에도 유지한다", async ({ page, scenario }) => {
  const volOverPrice: IndicatorConfig = {
    id: "vol-price",
    spec: { kind: "volume", maPeriod: 5 },
    panel: "price",
    visible: true,
    style: { colors: ["ind-1"], width: 1 },
  };
  const ma20: IndicatorConfig = {
    id: "ma-20",
    spec: { kind: "ma", method: "sma", period: 20 },
    panel: "price",
    visible: true,
    style: { colors: ["ind-2"], width: 2 },
  };
  const ichi: IndicatorConfig = {
    id: "ichi-1",
    spec: { kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 },
    panel: "price",
    visible: true,
    style: { colors: ["ind-3"], width: 1 },
  };

  seedChart(scenario, { indicators: [volOverPrice, ma20, ichi], panels: [] }, makeStepBars(80, 120));
  await openChart(page);

  await expect.poll(async () => {
    const o = await pane0Orders(page);
    return o !== null && o.total === 10 && o.loaded === 10 && o.overlays.length === 7;
  }).toBe(true);

  const expectMainBehindOverlays = async (overlayCount: number) => {
    await expect.poll(async () => {
      const o = await pane0Orders(page);
      if (!o || o.main === null || o.volBar === null || o.cloud === null || o.overlays.length !== overlayCount) return false;
      return o.volBar < o.main && o.cloud < o.main && o.overlays.every((ord) => ord > o.main!);
    }).toBe(true);
  };

  const expectMainAboveOverlays = async (overlayCount: number, expectedType?: string) => {
    await expect.poll(async () => {
      const o = await pane0Orders(page);
      if (!o || o.main === null || o.volBar === null || o.cloud === null || o.overlays.length !== overlayCount) return false;
      if (expectedType && o.mainType !== expectedType) return false;
      return o.volBar < o.main && o.cloud < o.main && o.overlays.every((ord) => ord < o.main!);
    }).toBe(true);
  };

  await expectMainBehindOverlays(7);

  await openChartSettings(page, "범례 · 표시");
  await expect(candlesOnTopSwitch(page)).toHaveAttribute("aria-checked", "false");
  await candlesOnTopSwitch(page).click();
  await expect(candlesOnTopSwitch(page)).toHaveAttribute("aria-checked", "true");
  await pollSaved(() => saved(scenario).candlesOnTop).toBe(true);
  await expectMainAboveOverlays(7, "Candlestick");

  await closeSettings(page);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expectMainAboveOverlays(7, "Candlestick");

  await openChartSettings(page, "범례 · 표시");
  await dialog(page).getByRole("group", { name: "차트 설정 영역", exact: true }).getByRole("button", { name: "지표", exact: true }).click();
  const cmdDialog = page.getByRole("dialog", { name: "지표·비교 입력창", exact: true });
  await cmdDialog.getByRole("tab", { name: "지표 추가", exact: true }).click();
  await cmdDialog.getByRole("combobox", { name: "지표·비교 찾기" }).fill("이평 5");
  await cmdDialog.getByRole("button", { name: "이동평균 단순 5 추가", exact: true }).click();
  await pollSaved(() => saved(scenario).indicators.length).toBe(4);
  await cmdDialog.getByRole("group", { name: "차트 설정 영역", exact: true }).getByRole("button", { name: "차트 설정", exact: true }).click();
  await expectMainAboveOverlays(8, "Candlestick");
  await chooseSettingsMenu(page, "봉 · 축");
  const styleGroup = dialog(page).getByRole("group", { name: "봉 모양" });
  await styleGroup.getByRole("button", { name: "라인", exact: true }).click();
  await expectMainAboveOverlays(8, "Line");
  await styleGroup.getByRole("button", { name: "캔들", exact: true }).click();
  await expectMainAboveOverlays(8, "Candlestick");

  await chooseSettingsMenu(page, "범례 · 표시");
  await candlesOnTopSwitch(page).click();
  await expect(candlesOnTopSwitch(page)).toHaveAttribute("aria-checked", "false");
  await pollSaved(() => saved(scenario).candlesOnTop).toBe(false);
  await expectMainBehindOverlays(8);
});

test("가격만 축에 맞춤 스위치는 SMA 200을 Y축 자동 범위에서 빼고 하단 RSI 패널은 유지하며 저장·복원한다", async ({ page, scenario }) => {
  const sma200: IndicatorConfig = {
    id: "sma-200",
    spec: { kind: "ma", method: "sma", period: 200 },
    panel: "price",
    visible: true,
    style: { colors: ["ind-1"], width: 2 },
  };
  const rsi14: IndicatorConfig = {
    id: "rsi-14",
    spec: { kind: "rsi", period: 14, signal: null },
    panel: "p-rsi",
    visible: true,
    style: { colors: ["ind-2"], width: 1 },
  };

  seedChart(
    scenario,
    {
      visibleBars: 60,
      indicators: [sma200, rsi14],
      panels: [{ id: "p-rsi", stretch: 0.25 }],
    },
    makeStepBars(200, 60),
  );
  await openChart(page);

  await expect.poll(async () => {
    const o = await pane0Orders(page);
    const r0 = await visiblePriceRange(page, 0);
    const r1 = await visiblePriceRange(page, 1);
    return o !== null && o.loaded === 2 && r0 !== null && r0.to > 55_000 && r1 !== null && r1.to > r1.from;
  }).toBe(true);

  const rsiBefore = (await visiblePriceRange(page, 1))!;

  await openChartSettings(page, "봉 · 축");
  await expect(scalePriceOnlySwitch(page)).toHaveAttribute("aria-checked", "false");
  await scalePriceOnlySwitch(page).click();
  await expect(scalePriceOnlySwitch(page)).toHaveAttribute("aria-checked", "true");
  await pollSaved(() => saved(scenario).scalePriceOnly).toBe(true);

  await expect.poll(async () => {
    const r0 = await visiblePriceRange(page, 0);
    return r0 !== null && r0.to < 53_000 && r0.from > 47_000;
  }).toBe(true);

  const rsiAfter = (await visiblePriceRange(page, 1))!;
  expect(Math.abs(rsiAfter.from - rsiBefore.from)).toBeLessThan(1);
  expect(Math.abs(rsiAfter.to - rsiBefore.to)).toBeLessThan(1);

  await closeSettings(page);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => {
    const o = await pane0Orders(page);
    const r0 = await visiblePriceRange(page, 0);
    return o !== null && o.loaded === 2 && r0 !== null && r0.to < 53_000 && r0.from > 47_000;
  }).toBe(true);

  await openChartSettings(page, "봉 · 축");
  await expect(scalePriceOnlySwitch(page)).toHaveAttribute("aria-checked", "true");
  await scalePriceOnlySwitch(page).click();
  await expect(scalePriceOnlySwitch(page)).toHaveAttribute("aria-checked", "false");
  await pollSaved(() => saved(scenario).scalePriceOnly).toBe(false);

  await expect.poll(async () => {
    const r0 = await visiblePriceRange(page, 0);
    return r0 !== null && r0.to > 55_000;
  }).toBe(true);
});

test("가격만 축에 맞춤 스위치는 일목 구름만 켜져 있어도 구름을 Y축 자동 범위에서 뺀다", async ({ page, scenario }) => {
  const cloudOnlyIchi: IndicatorConfig = {
    id: "ichi-cloud",
    spec: { kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 },
    panel: "price",
    visible: true,
    style: {
      colors: ["ind-1"],
      width: 1,
      ichimoku: {
        showCloud: true,
        showConversion: false,
        showBase: false,
        showSpanA: false,
        showSpanB: false,
        showLagging: false,
        cloudOpacity: 0.2,
      },
    },
  };

  seedChart(scenario, { visibleBars: 60, indicators: [cloudOnlyIchi], panels: [] }, makeStepBars(200, 60));
  await openChart(page);

  await expect.poll(async () => {
    const o = await pane0Orders(page);
    const r0 = await visiblePriceRange(page, 0);
    return o !== null && o.cloud !== null && o.loaded >= 2 && r0 !== null && r0.to > 55_000;
  }).toBe(true);

  await openChartSettings(page, "봉 · 축");
  await scalePriceOnlySwitch(page).click();
  await pollSaved(() => saved(scenario).scalePriceOnly).toBe(true);

  await expect.poll(async () => {
    const r0 = await visiblePriceRange(page, 0);
    return r0 !== null && r0.to < 53_000 && r0.from > 47_000;
  }).toBe(true);

  await scalePriceOnlySwitch(page).click();
  await pollSaved(() => saved(scenario).scalePriceOnly).toBe(false);

  await expect.poll(async () => {
    const r0 = await visiblePriceRange(page, 0);
    return r0 !== null && r0.to > 55_000;
  }).toBe(true);
});

test("Esc 되돌리기와 기본값 복원 및 구역 수정 표시가 두 스위치에 모두 동작한다", async ({ page, scenario }) => {
  const sma200: IndicatorConfig = {
    id: "sma-200",
    spec: { kind: "ma", method: "sma", period: 200 },
    panel: "price",
    visible: true,
    style: { colors: ["ind-1"], width: 2 },
  };

  scenario.documents.saveUiState({ ...scenario.documents.uiState(), indicatorWindow: "dialog" });
  seedChart(scenario, { indicators: [sma200], panels: [] }, makeStepBars(200, 130));
  await openChart(page);

  await expect.poll(async () => {
    const o = await pane0Orders(page);
    const r0 = await visiblePriceRange(page, 0);
    return o !== null && o.loaded === 2 && o.main !== null && o.overlays.length === 1 && o.overlays[0]! > o.main && r0 !== null && r0.to > 55_000;
  }).toBe(true);

  await openChartSettings(page, "봉 · 축");
  const barsTab = dialog(page).getByRole("tab", { name: "봉 · 축", exact: true });
  const displayTab = dialog(page).getByRole("tab", { name: "범례 · 표시", exact: true });
  const resetBtn = dialog(page).getByRole("button", { name: "기본값 복원", exact: true });

  await expect(barsTab).not.toHaveAttribute("data-modified", "true");
  await expect(displayTab).not.toHaveAttribute("data-modified", "true");
  await expect(resetBtn).toBeDisabled();

  await scalePriceOnlySwitch(page).click();
  await expect(barsTab).toHaveAttribute("data-modified", "true");
  await expect(resetBtn).toBeEnabled();
  await expect.poll(async () => {
    const r0 = await visiblePriceRange(page, 0);
    return r0 !== null && r0.to < 53_000;
  }).toBe(true);

  await chooseSettingsMenu(page, "범례 · 표시");
  await candlesOnTopSwitch(page).click();
  await expect(displayTab).toHaveAttribute("data-modified", "true");
  await expect.poll(async () => {
    const o = await pane0Orders(page);
    return o !== null && o.main !== null && o.overlays.length === 1 && o.overlays[0]! < o.main;
  }).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await pollSaved(() => ({ top: saved(scenario).candlesOnTop, scale: saved(scenario).scalePriceOnly })).toEqual({ top: false, scale: false });
  await expect.poll(async () => {
    const o = await pane0Orders(page);
    const r0 = await visiblePriceRange(page, 0);
    return o !== null && o.main !== null && o.overlays.length === 1 && o.overlays[0]! > o.main && r0 !== null && r0.to > 55_000;
  }).toBe(true);

  await openChartSettings(page, "봉 · 축");
  await scalePriceOnlySwitch(page).click();
  await chooseSettingsMenu(page, "범례 · 표시");
  await candlesOnTopSwitch(page).click();
  await expect(barsTab).toHaveAttribute("data-modified", "true");
  await expect(displayTab).toHaveAttribute("data-modified", "true");
  await expect(resetBtn).toBeEnabled();

  await resetBtn.click();
  await expect(candlesOnTopSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(barsTab).not.toHaveAttribute("data-modified", "true");
  await expect(displayTab).not.toHaveAttribute("data-modified", "true");
  await expect(resetBtn).toBeDisabled();
  await chooseSettingsMenu(page, "봉 · 축");
  await expect(scalePriceOnlySwitch(page)).toHaveAttribute("aria-checked", "false");
  await pollSaved(() => ({ top: saved(scenario).candlesOnTop, scale: saved(scenario).scalePriceOnly })).toEqual({ top: false, scale: false });
  await expect.poll(async () => {
    const o = await pane0Orders(page);
    const r0 = await visiblePriceRange(page, 0);
    return o !== null && o.main !== null && o.overlays.length === 1 && o.overlays[0]! > o.main && r0 !== null && r0.to > 55_000;
  }).toBe(true);
});
