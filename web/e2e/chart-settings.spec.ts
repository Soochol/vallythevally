import type { Page } from "@playwright/test";
import { type ChartSettings, DEFAULT_CHART_SETTINGS, type IndicatorConfig } from "../src/chart/settings";
import type { Bar } from "../src/api/generated/Bar";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, saveChartShare, test, firstChart, withFirstChart, pickDesktopVenue, pollSaved, fixedWait } from "./harness";
import { selectMinute } from "./select-option";

const RIGHT_OFFSET = 6;

const saved = (scenario: Scenario) => firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings as ChartSettings;
const shownBars = (page: Page) => page.evaluate(() => {
  const range = window.chartProbe.chart.timeScale().getVisibleLogicalRange();
  return range && Math.round(range.to - range.from + 1);
});
const expectShownBars = (page: Page, bars: number) => expect.poll(() => shownBars(page)).toBe(bars + RIGHT_OFFSET);
const settingsButton = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "차트 설정", exact: true });
const popover = (page: Page) => page.getByRole("dialog", { name: "차트 설정", exact: true });
const barsGroup = (page: Page) => popover(page).getByRole("group", { name: "화면에 보이는 봉" });

async function openSettings(page: Page) {
  if (await popover(page).isVisible()) return popover(page);
  await settingsButton(page).click();
  await expect(popover(page)).toBeVisible();
  return popover(page);
}

async function choosePeriod(page: Page, label: string) {
  if (await popover(page).isVisible()) await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: label, exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", new RegExp(` ${label}$`));
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function open(page: Page) {
  await page.addInitScript(installChartProbe);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("위 막대의 차트 설정 버튼은 지표 창이 아니라 차트 설정 팝오버를 열고 Esc로 닫는다", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "봉 모양", exact: true })).toHaveCount(0);
  await settingsButton(page).click();
  await expect(popover(page)).toBeVisible();
  await expect(settingsButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: "지표·비교 입력창" })).toHaveCount(0);
  await expect(barsGroup(page).getByRole("button", { name: "자동", exact: true })).toBeFocused();
  const box = (await popover(page).boundingBox())!;
  const anchor = (await settingsButton(page).boundingBox())!;
  expect(box.width).toBe(320);
  expect(box.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(settingsButton(page)).toBeFocused();
  await expect(settingsButton(page)).toHaveAttribute("aria-expanded", "false");
});

test("보이는 봉 수는 고른 대로 맞추고, 봉 주기를 바꿔도 유지하며, 새로고침 뒤 복원한다", async ({ page, scenario }) => {
  await open(page);
  await expectShownBars(page, 130);
  const settings = await openSettings(page);
  await expect(barsGroup(page).getByRole("button", { name: "자동", exact: true })).toHaveAttribute("aria-pressed", "true");

  await barsGroup(page).getByRole("button", { name: "240", exact: true }).click();
  await expectShownBars(page, 240);
  await expect(barsGroup(page).getByRole("button", { name: "240", exact: true })).toHaveAttribute("aria-pressed", "true");
  await pollSaved(() => saved(scenario).visibleBars).toBe(240);

  await choosePeriod(page, "주");
  await expectShownBars(page, 240);
  await choosePeriod(page, "일");
  await expectShownBars(page, 240);

  await openSettings(page);
  const input = settings.getByRole("spinbutton", { name: "보이는 봉 수 직접 입력" });
  await input.fill("800");
  await input.press("Enter");
  await expectShownBars(page, 800);
  await expect.poll(async () => Number(await chartOf(cell(page)).getAttribute("data-bar-count"))).toBeGreaterThan(800);
  await pollSaved(() => saved(scenario).visibleBars).toBe(800);
  await expect(barsGroup(page).getByRole("button", { pressed: true })).toHaveCount(0);

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expectShownBars(page, 800);
  await openSettings(page);
  await expect(input).toHaveValue("800");
  await expect(input).toBeFocused();

  await input.fill("5");
  await input.press("Enter");
  await expect(input).toHaveValue("10");
  await expectShownBars(page, 10);

  await barsGroup(page).getByRole("button", { name: "자동", exact: true }).click();
  await expectShownBars(page, 130);
  await expect(input).toHaveValue("");
  await pollSaved(() => saved(scenario).visibleBars).toBeNull();
});

test("화면 내 최고·최저 스위치는 보이는 봉의 최고가·최저가 꼬리표를 켜고 끄며 새로고침 뒤 복원한다", async ({ page, scenario }) => {
  await open(page);
  const high = cell(page).locator("[data-extreme=high] > span");
  const low = cell(page).locator("[data-extreme=low] > span");
  await expect(high).toBeHidden();
  await expect(low).toBeHidden();

  const settings = await openSettings(page);
  await barsGroup(page).getByRole("button", { name: "60", exact: true }).click();
  await expectShownBars(page, 60);
  const toggle = settings.getByRole("switch", { name: /화면 내 최고·최저/ });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await pollSaved(() => saved(scenario).showExtremes).toBe(true);

  const expected = () => page.evaluate(() => {
    const { chart, main } = window.chartProbe;
    const scale = chart.timeScale();
    const range = scale.getVisibleLogicalRange()!;
    let high = -Infinity;
    let low = Infinity;
    let last = 0;
    for (let i = Math.max(0, Math.floor(range.from)); i <= Math.ceil(range.to); i++) {
      const bar = main.dataByIndex(i);
      const x = bar ? scale.timeToCoordinate(bar.time) : null;
      if (!bar || !("high" in bar) || x === null || x < 0 || x > scale.width()) continue;
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
      last = bar.close;
    }
    const won = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
    const pct = (v: number) => { const p = Math.round((v - last) / last * 10000) / 100; return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(2)}%`; };
    return { high: `최고 ${won.format(high)} (${pct(high)})`, low: `최저 ${won.format(low)} (${pct(low)})` };
  });
  const tagsMatch = async () => {
    const want = await expected();
    return (await high.textContent()) === want.high && (await low.textContent()) === want.low;
  };
  await expect(high).toBeVisible();
  await expect(low).toBeVisible();
  await expect.poll(tagsMatch).toBe(true);
  const chartBox = (await chartOf(cell(page)).boundingBox())!;
  for (const tag of [high, low]) {
    const box = (await tag.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(chartBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(chartBox.x + chartBox.width);
  }

  await page.evaluate(() => {
    const scale = window.chartProbe.chart.timeScale();
    const range = scale.getVisibleLogicalRange()!;
    scale.setVisibleLogicalRange({ from: range.from - 37.6, to: range.to - 37.6 });
  });
  await expect.poll(tagsMatch).toBe(true);
  await expect(high).toBeVisible();
  await expect(low).toBeVisible();

  await page.keyboard.press("Escape");
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(high).toBeVisible();
  await expect(low).toBeVisible();
  await openSettings(page);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(high).toBeHidden();
  await expect(low).toBeHidden();
  await pollSaved(() => saved(scenario).showExtremes).toBe(false);
});

test("팝오버의 봉 모양과 가격 축은 활성 칸에 바로 반영한다", async ({ page, scenario }) => {
  await open(page);
  const settings = await openSettings(page);
  const style = settings.getByRole("group", { name: "봉 모양" });
  const scale = settings.getByRole("group", { name: "가격 축" });
  await style.getByRole("button", { name: "라인", exact: true }).click();
  await expect(style.getByRole("button", { name: "라인", exact: true })).toHaveAttribute("aria-pressed", "true");
  await pollSaved(() => saved(scenario).style).toBe("line");
  await style.getByRole("button", { name: "캔들", exact: true }).click();
  await pollSaved(() => saved(scenario).style).toBe("candle");

  await scale.getByRole("button", { name: "로그", exact: true }).click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "log");
  await scale.getByRole("button", { name: "일반", exact: true }).click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "normal");
  await pollSaved(() => saved(scenario).scale).toBe("normal");
});

test("비교 종목이 있으면 팝오버의 가격 축은 %로 고정한다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", chartSettings: { ...saved(scenario), compare: ["000660"] } }) });
  await open(page);
  const settings = await openSettings(page);
  const scale = settings.getByRole("group", { name: "가격 축" });
  for (const name of ["일반", "로그", "%"]) await expect(scale.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(scale.getByRole("button", { name: "%", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(settings.getByText("비교 종목이 있으면 % 축으로 그립니다")).toBeVisible();
});

test("화면 가장자리에 반쯤 잘린 봉은 최고·최저에서 빼고, 두 등락률 기준은 이동·확대 뒤 화면 끝 봉 종가를 쓴다", async ({ page, scenario }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const day = 86_400;
  const start = Date.parse("2025-01-01T00:00:00+09:00") / 1000;
  const bars = Array.from({ length: 300 }, (_, i) => {
    const h = 100_000 - i * 100;
    return { t: start + i * day, o: h - 200, h, l: h - 500, c: h - 300, v: 1000 };
  });
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "D",
    { body: { symbol: "005930", venue: "combined", period: "D", bars, current: null, nextBefore: null, seq: null } });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D",
    chartSettings: { ...saved(scenario), visibleBars: 60, showExtremes: true } }) });
  await page.addInitScript(installChartProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expectShownBars(page, 60);
  const high = cell(page).locator("[data-extreme=high] > span");
  const highText = (index: number, lastIndex: number, basis: ChartSettings["extremeBasis"] = "last") => {
    const price = bars[index]!.h;
    const close = bars[lastIndex]!.c;
    return `최고 ${won(price)} (${basis === "last" ? pct(close, price) : pct(price, close)})`;
  };
  await expect(high).toHaveText(highText(240, 299));

  await page.evaluate(() => {
    const scale = window.chartProbe.chart.timeScale();
    const range = scale.getVisibleLogicalRange()!;
    scale.setVisibleLogicalRange({ from: range.from - 100.1, to: range.to - 100.1 });
  });
  await expect.poll(() => page.evaluate(() => window.chartProbe.chart.timeScale().getVisibleLogicalRange()!.from)).toBeLessThan(200);
  const edge = await page.evaluate(() => {
    const { chart, main } = window.chartProbe;
    const range = chart.timeScale().getVisibleLogicalRange()!;
    const cut = Math.floor(range.from);
    const x = (i: number) => chart.timeScale().timeToCoordinate(main.dataByIndex(i)!.time);
    const right = Math.ceil(range.to);
    return { cutX: x(cut), firstShown: x(cut)! < 0 ? cut + 1 : cut, lastShown: x(right)! > chart.timeScale().width() ? right - 1 : right };
  });
  expect(edge.cutX).not.toBeNull();
  expect(edge.cutX!).toBeLessThan(0);
  const firstShown = edge.firstShown;
  await expect(high).toBeVisible();
  await expect(high).toHaveText(highText(firstShown, edge.lastShown));

  const low = cell(page).locator("[data-extreme=low] > span");
  const lowText = (index: number, basis: ChartSettings["extremeBasis"] = "last") => {
    const price = bars[index]!.l;
    const close = bars[index]!.c;
    return `최저 ${won(price)} (${basis === "last" ? pct(close, price) : pct(price, close)})`;
  };
  await expect(low).toHaveText(lowText(edge.lastShown));
  await page.screenshot({ path: testInfo.outputPath("historical-visible-close.png") });
  for (const basis of ["last", "extreme"] as const) {
    await openSettings(page);
    await basisGroup(page).getByRole("button", { name: basis === "last" ? "현재가 대비" : "고가·저가 대비", exact: true }).click();
    await page.keyboard.press("Escape");
    for (const range of [{ from: 238.6, to: 298.6 }, { from: 0.3, to: 60.3 }, { from: 79.2, to: 109.2 }, { from: 20.3, to: 180.3 }]) {
      const shown = await page.evaluate((target) => {
        const { chart, main } = window.chartProbe;
        const scale = chart.timeScale();
        scale.setVisibleLogicalRange(target);
        return new Promise<number[]>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const inside: number[] = [];
          for (let i = 0; i < 300; i++) {
            const x = scale.timeToCoordinate(main.dataByIndex(i)!.time);
            if (x !== null && x >= 0 && x <= scale.width()) inside.push(i);
          }
          resolve(inside);
        })));
      }, range);
      expect(shown.length).toBeGreaterThan(0);
      if (range.to < 298) expect(shown.at(-1)).toBeLessThan(bars.length - 1);
      await expect(high).toHaveText(highText(shown[0]!, shown.at(-1)!, basis));
      await expect(low).toHaveText(lowText(shown.at(-1)!, basis));
    }
    await page.screenshot({ path: testInfo.outputPath(`historical-${basis}.png`) });
    await page.evaluate(() => window.chartProbe.chart.timeScale().setVisibleLogicalRange({ from: 240, to: 305.5 }));
    await expect(high).toHaveText(highText(240, 299, basis));
    await expect(low).toHaveText(lowText(299, basis));
  }
  expect(errors).toEqual([]);
});

test("봉이 없는 화면은 두 등락률 기준 모두 최고·최저 꼬리표를 숨긴다", async ({ page, scenario }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  openWith(scenario, { showExtremes: true }, []);
  await open(page);
  for (const basis of ["현재가 대비", "고가·저가 대비"]) {
    await openSettings(page);
    const button = basisGroup(page).getByRole("button", { name: basis, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    for (const side of ["high", "low"]) await expect(cell(page).locator(`[data-extreme=${side}] > span`)).toBeHidden();
  }
  expect(errors).toEqual([]);
});

test("비교 종목이 있어 축 고정 안내가 붙어도 1280x600에서 팝오버는 버튼 아래에 열리고 지표 창 방식을 고른다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { chartSettings: { ...saved(scenario), compare: ["000660"] } }) });
  await page.setViewportSize({ width: 1280, height: 600 });
  await open(page);
  const settings = await openSettings(page);
  const button = (await settingsButton(page).boundingBox())!;
  const box = (await settings.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(button.y + button.height);
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  const note = (await settings.getByText("비교 종목이 있으면", { exact: false }).boundingBox())!;
  const scale = (await settings.getByRole("group", { name: "가격 축" }).boundingBox())!;
  const windowRow = (await settings.getByRole("group", { name: "지표 창" }).boundingBox())!;
  expect(note.y).toBeGreaterThan(scale.y);
  expect(note.y).toBeLessThan(windowRow.y);
  const choices = settings.getByRole("group", { name: "지표 창" });
  await expect(choices.getByRole("button", { name: "가운데 창", exact: true })).toHaveAttribute("aria-pressed", "true");
  await choices.getByRole("button", { name: "차트 옆", exact: true }).click();
  await pollSaved(() => scenario.documents.uiState().indicatorWindow).toBe("inspector");
});

const won = (x: number) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(x);
const pct = (from: number, to: number) => {
  const p = Math.round((to - from) / from * 10000) / 100;
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(2)}%`;
};
const DAY = 86_400;
const START = Date.parse("2025-01-01T00:00:00+09:00") / 1000;
const zigzagBars: Bar[] = Array.from({ length: 300 }, (_, i) => {
  const c = 50_000 + (i % 7) * 300 - (i % 3) * 450;
  return { t: START + i * DAY, o: c - 150 + (i % 2) * 400, h: c + 600, l: c - 700, c, v: 1000 + i };
});
const ohlc = (page: Page) => cell(page).locator("[data-ohlc]");
const ohlcChangeSwitch = (page: Page) => popover(page).getByRole("switch", { name: /^봉 값 등락률/ });
const extremesSwitch = (page: Page) => popover(page).getByRole("switch", { name: /^화면 내 최고·최저/ });
const basisGroup = (page: Page) => popover(page).getByRole("group", { name: "최고·최저 등락률" });

function openWith(scenario: Scenario, settings: Partial<ChartSettings>, bars: Bar[] = zigzagBars) {
  openWithRaw(scenario, { ...DEFAULT_CHART_SETTINGS, ...settings }, bars);
}

function openWithRaw(scenario: Scenario, chartSettings: object, bars: Bar[] = zigzagBars) {
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "D",
    { body: { symbol: "005930", venue: "combined", period: "D", bars, current: null, nextBefore: null, seq: null } });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D",
    chartSettings }) });
}

async function reload(page: Page) {
  if (await popover(page).isVisible()) await page.keyboard.press("Escape");
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

const ohlcCells = (bar: Bar, prev: Bar | null) => [
  ...([["시", bar.o], ["고", bar.h], ["저", bar.l], ["종", bar.c]] as const).map(([k, v]) => `${k}${won(v)}${prev ? ` (${pct(prev.c, v)})` : ""}`),
  expect.stringMatching(/^량[^(]+$/),
];

const PRICE_MA: IndicatorConfig = { id: "ma-price", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } };
const VOLUME_ID = DEFAULT_CHART_SETTINGS.indicators[0]!.id;
const legendSwitch = (page: Page) => popover(page).getByRole("switch", { name: /^범례/ });
const fallbackBadge = (page: Page) => cell(page).getByText("통합", { exact: true });

function showFallbackBadge(scenario: Scenario) {
  scenario.reply("/api/symbols/005930", { body: { code: "005930", name: "삼성전자", kind: "common", market: "kospi", nxtEnabled: false } });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), venue: "nxt" });
}
const legendRows = (page: Page) => ({
  name: cell(page).locator(".chart-legend [role=heading]"),
  priceRow: cell(page).locator("[data-price-row]"),
  maRow: cell(page).locator(`[data-indicator-row="${PRICE_MA.id}"]`),
  compareRow: cell(page).locator(`[data-compare-row="000660"]`),
});
const middle = async (locator: ReturnType<Page["locator"]>) => {
  const box = (await locator.boundingBox())!;
  return { left: box.x, right: box.x + box.width, y: box.y + box.height / 2 };
};

async function expectLegendOff(page: Page) {
  const rows = legendRows(page);
  for (const row of Object.values(rows)) await expect(row).toBeHidden();
  await expect(ohlc(page)).toBeVisible();
  await expect(cell(page).locator(`[data-indicator-row="${VOLUME_ID}"]`)).toBeVisible();
  const venue = await middle(fallbackBadge(page));
  const values = await middle(ohlc(page));
  expect(Math.abs(venue.y - values.y)).toBeLessThan(8);
  expect(venue.right).toBeLessThanOrEqual(values.left);
}

test("범례 스위치를 끄면 통합 표시와 봉 값 줄만 한 줄로 남기고, 봉 주기를 바꾸거나 새로고침해도 꺼진 채다", async ({ page, scenario }) => {
  showFallbackBadge(scenario);
  openWith(scenario, { indicators: [...DEFAULT_CHART_SETTINGS.indicators, PRICE_MA], compare: ["000660"] });
  await open(page);
  const rows = legendRows(page);
  for (const row of [...Object.values(rows), ohlc(page)]) await expect(row).toBeVisible();
  await openSettings(page);
  await expect(legendSwitch(page)).toHaveAttribute("aria-checked", "true");

  await legendSwitch(page).click();
  await expect(legendSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expectLegendOff(page);
  await pollSaved(() => saved(scenario).showLegend).toBe(false);
  expect(saved(scenario)).not.toHaveProperty("showOhlc");

  await expect(ohlcChangeSwitch(page)).toBeEnabled();
  await ohlcChangeSwitch(page).click();
  await expect(ohlc(page).locator(":scope > span").first()).toContainText("(");
  await pollSaved(() => saved(scenario).showOhlcChange).toBe(true);

  await page.keyboard.press("Escape");
  await expectLegendOff(page);

  await selectMinute(page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "분봉", exact: true }), { label: "5분" });
  await expect(cell(page)).toHaveAttribute("aria-label", / 5분$/);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expectLegendOff(page);
  await pollSaved(() => firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).period).toBe("5m");

  await reload(page);
  await expect(cell(page)).toHaveAttribute("aria-label", /: 삼성전자 통합 5분$/);
  await expectLegendOff(page);
  expect(saved(scenario)).toMatchObject({ showLegend: false, showOhlcChange: true });
  expect(saved(scenario)).not.toHaveProperty("showOhlc");
  await openSettings(page);
  await expect(legendSwitch(page)).toHaveAttribute("aria-checked", "false");

  await legendSwitch(page).click();
  for (const row of [...Object.values(rows), ohlc(page)]) await expect(row).toBeVisible();
  const venue = await middle(fallbackBadge(page));
  const name = await middle(rows.name);
  expect(Math.abs(venue.y - name.y)).toBeLessThan(8);
  await pollSaved(() => saved(scenario).showLegend).toBe(true);
});

test("범례를 끈 채 거래소 조회가 실패해도 위 막대에서 다른 거래소로 복구한다", async ({ page, scenario }) => {
  openWith(scenario, { showLegend: false });
  await page.route("**/api/bars?*", (route) => new URL(route.request().url()).searchParams.get("venue") === "krx"
    ? route.fulfill({ status: 503, json: { error: { code: "kiwoom_unavailable", message: "시험용 KRX 조회 실패" } } })
    : route.fallback());
  await open(page);
  await expect(ohlc(page)).toBeVisible();
  await pickDesktopVenue(page, "KRX");
  await expect(cell(page).getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
  await pickDesktopVenue(page, "통합");
  await expect(cell(page)).toHaveAttribute("aria-label", /: 삼성전자 통합 일$/);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(ohlc(page)).toBeVisible();
});

test("showOhlc: false가 든 옛 설정은 봉 값 줄과 범례를 모두 보인다", async ({ page, scenario }) => {
  const { showLegend: _legend, ...current } = DEFAULT_CHART_SETTINGS;
  openWithRaw(scenario, { ...current, indicators: [...current.indicators, PRICE_MA], showOhlc: false });
  await open(page);
  for (const row of [legendRows(page).name, legendRows(page).priceRow, legendRows(page).maRow, ohlc(page)]) await expect(row).toBeVisible();
  await openSettings(page);
  await expect(legendSwitch(page)).toHaveAttribute("aria-checked", "true");
  await ohlcChangeSwitch(page).click();
  await pollSaved(() => saved(scenario).showOhlcChange).toBe(true);
  expect(saved(scenario)).toMatchObject({ showLegend: true });
  expect(saved(scenario)).not.toHaveProperty("showOhlc");
});

test("범례를 끈 좁은 칸에서는 봉 값이 통합 표시 옆에서 줄을 바꾸고 오류 안내는 범례 안의 다음 줄에 한 줄로 둔다", async ({ page, scenario }) => {
  showFallbackBadge(scenario);
  await page.setViewportSize({ width: 993, height: 800 });
  openWith(scenario, { showLegend: false, showOhlcChange: true });
  saveChartShare(scenario, 0.4);
  await open(page);
  await pollSaved(() => scenario.live.subscriptions().some((s) => s.symbol === "005930")).toBe(true);
  scenario.live.emit({ type: "sub_error", sub: scenario.live.subscriptions().find((s) => s.symbol === "005930")!.sub, code: "realtime_limit" });
  const notice = cell(page).getByText("실시간 한도 초과: 조회 값만 보입니다", { exact: true });
  await expect(notice).toBeVisible();
  const venue = await middle(fallbackBadge(page));
  const first = await middle(ohlc(page).locator(":scope > span").first());
  expect(Math.abs(venue.y - first.y)).toBeLessThan(8);
  const legend = (await cell(page).locator(".chart-legend").boundingBox())!;
  for (const part of [notice, ...await ohlc(page).locator(":scope > span").all()]) {
    const box = (await part.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(legend.x + legend.width);
  }
  expect(await notice.evaluate((el) => { const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects().length; })).toBe(1);

  const wide = (await cell(page).locator(".chart-legend").boundingBox())!.width;
  await page.setViewportSize({ width: 793, height: 800 });
  await expect.poll(async () => (await cell(page).locator(".chart-legend").boundingBox())!.width).toBeLessThan(wide);
  const narrow = (await cell(page).locator(".chart-legend").boundingBox())!;
  for (const value of await ohlc(page).locator(":scope > span").all()) {
    const box = (await value.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(narrow.x + narrow.width);
  }
});

test("봉 값이 그대로면 크기가 바뀌어 다시 그려도 봉 값 줄의 칸을 새로 만들지 않는다", async ({ page, scenario }) => {
  showFallbackBadge(scenario);
  await page.setViewportSize({ width: 993, height: 800 });
  openWith(scenario, { showLegend: false, showOhlcChange: true });
  saveChartShare(scenario, 0.4);
  await page.clock.install();
  await open(page);
  await pollSaved(() => scenario.live.subscriptions().some((s) => s.symbol === "005930")).toBe(true);
  scenario.live.emit({ type: "sub_error", sub: scenario.live.subscriptions().find((s) => s.symbol === "005930")!.sub, code: "realtime_limit" });
  await expect(cell(page).getByText("실시간 한도 초과: 조회 값만 보입니다", { exact: true })).toBeVisible();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(ohlc(page).locator(":scope > span")).toHaveCount(5);
  await ohlc(page).evaluate((line) => {
    const rebuilt: string[] = [];
    let shown = line.textContent;
    new MutationObserver((records) => {
      for (let i = 1; i < records.length; i++) rebuilt.push(`${line.textContent}`);
      if (line.textContent === shown) rebuilt.push(`${line.textContent}`);
      shown = line.textContent;
    }).observe(line, { childList: true });
    (window as unknown as { rebuiltOhlc: typeof rebuilt }).rebuiltOhlc = rebuilt;
  });
  const wide = (await cell(page).locator(".chart-legend").boundingBox())!.width;
  await page.setViewportSize({ width: 793, height: 800 });
  await expect.poll(async () => (await cell(page).locator(".chart-legend").boundingBox())!.width).toBeLessThan(wide);
  await page.clock.runFor(1000);
  await fixedWait(page, 1000, "봉 값 줄을 다시 만들지 않았음을 보려면 원래 대기만큼 실제 시간이 지나야 한다");
  expect(await page.evaluate(() => (window as unknown as { rebuiltOhlc: unknown[] }).rebuiltOhlc)).toEqual([]);
});

test("범례를 끈 지수는 통합 표시 자리 없이 봉 값이 범례 왼쪽 끝에서 시작한다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "IDX:001", venue: null, period: "D",
    chartSettings: { ...DEFAULT_CHART_SETTINGS, showLegend: false } }) });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(ohlc(page)).toBeVisible();
  await expect(fallbackBadge(page)).toHaveCount(0);
  const legend = (await cell(page).locator(".chart-legend").boundingBox())!;
  expect((await ohlc(page).boundingBox())!.x).toBe(legend.x);
});

test("가격 패널에 겹친 거래량의 범례 줄도 범례를 끄면 숨는다", async ({ page, scenario }) => {
  const volume = DEFAULT_CHART_SETTINGS.indicators[0]!;
  openWith(scenario, { indicators: [{ ...volume, panel: "price" }], panels: [] });
  await open(page);
  const volumeRow = cell(page).locator(`[data-indicator-row="${volume.id}"]`);
  await expect(volumeRow).toBeVisible();
  await openSettings(page);
  await legendSwitch(page).click();
  await expect(volumeRow).toBeHidden();
  await expect(ohlc(page)).toBeVisible();
});

test("390x844에서 범례를 끄면 봉 값 줄만 남고 휴대폰 머리의 거래소는 그대로다", async ({ page, scenario }) => {
  openWith(scenario, { indicators: [...DEFAULT_CHART_SETTINGS.indicators, PRICE_MA], compare: ["000660"] });
  await open(page);
  await openSettings(page);
  await legendSwitch(page).click();
  await pollSaved(() => saved(scenario).showLegend).toBe(false);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(ohlc(page)).toBeVisible();
  await expect(legendRows(page).maRow).toBeHidden();
  await expect(legendRows(page).compareRow).toBeHidden();
  await expect(page.getByRole("group", { name: "거래소", exact: true })).toBeVisible();
});

test("봉 값 등락률 스위치는 시·고·저·종 옆에 직전 봉 종가 대비 %를 붙이고, 십자선이 가리키는 봉을 따른다", async ({ page, scenario }) => {
  openWith(scenario, { visibleBars: 60 });
  await open(page);
  const spans = ohlc(page).locator(":scope > span");
  const texts = () => spans.allTextContents();
  const last = zigzagBars.length - 1;
  await settingsButton(page).hover();
  await expect.poll(texts).toEqual(ohlcCells(zigzagBars[last]!, null).map((x, i) => i < 4 ? (x as string).replace(/ \(.*\)$/, "") : x));

  await openSettings(page);
  await expect(ohlcChangeSwitch(page)).toHaveAttribute("aria-checked", "false");
  await ohlcChangeSwitch(page).click();
  await expect(ohlcChangeSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect.poll(texts).toEqual(ohlcCells(zigzagBars[last]!, zigzagBars[last - 1]!));
  await pollSaved(() => saved(scenario).showOhlcChange).toBe(true);
  for (const [n, v] of [[0, zigzagBars[last]!.o], [3, zigzagBars[last]!.c]] as const) {
    const change = v - zigzagBars[last - 1]!.c;
    await expect(spans.nth(n).locator("span")).toHaveClass(change > 0 ? "text-up" : change < 0 ? "text-down" : "text-text-2");
  }

  await page.keyboard.press("Escape");
  const hovered = last - 20;
  const x = await page.evaluate((i) => window.chartProbe.chart.timeScale().timeToCoordinate(window.chartProbe.main.dataByIndex(i)!.time), hovered);
  const box = (await chartOf(cell(page)).boundingBox())!;
  await page.mouse.move(box.x + x!, box.y + box.height / 3);
  await expect.poll(texts).toEqual(ohlcCells(zigzagBars[hovered]!, zigzagBars[hovered - 1]!));
});

test("최고·최저 등락률을 고가·저가 대비로 바꾸면 꼬리표가 최고가·최저가 대비 현재가 %를 적고, 새로고침 뒤 유지하며, 최고·최저가 꺼지면 비활성이다", async ({ page, scenario }) => {
  const bars = Array.from({ length: 300 }, (_, i) => {
    const h = 100_000 - i * 100;
    return { t: START + i * DAY, o: h - 200, h, l: h - 500, c: h - 300, v: 1000 };
  });
  openWith(scenario, { visibleBars: 60, showExtremes: true }, bars);
  await open(page);
  await expectShownBars(page, 60);
  const high = cell(page).locator("[data-extreme=high] > span");
  const low = cell(page).locator("[data-extreme=low] > span");
  const lastClose = bars.at(-1)!.c;
  const highBar = bars[240]!;
  const lowBar = bars[299]!;
  await expect(high).toHaveText(`최고 ${won(highBar.h)} (${pct(lastClose, highBar.h)})`);
  await expect(low).toHaveText(`최저 ${won(lowBar.l)} (${pct(lastClose, lowBar.l)})`);

  await openSettings(page);
  const current = basisGroup(page).getByRole("button", { name: "현재가 대비", exact: true });
  const extreme = basisGroup(page).getByRole("button", { name: "고가·저가 대비", exact: true });
  await expect(current).toHaveAttribute("aria-pressed", "true");
  await expect(current).toHaveAttribute("title", /화면 오른쪽 끝 봉 종가/);
  await expect(extreme).toHaveAttribute("title", /화면 오른쪽 끝 봉 종가/);
  await extreme.click();
  await expect(extreme).toHaveAttribute("aria-pressed", "true");
  const extremeTexts = [`최고 ${won(highBar.h)} (${pct(highBar.h, lastClose)})`, `최저 ${won(lowBar.l)} (${pct(lowBar.l, lastClose)})`];
  await expect(high).toHaveText(extremeTexts[0]!);
  await expect(low).toHaveText(extremeTexts[1]!);
  expect(extremeTexts[0]).toContain("(−");
  expect(extremeTexts[1]).toContain("(+");
  await pollSaved(() => saved(scenario).extremeBasis).toBe("extreme");

  await reload(page);
  await expect(high).toHaveText(extremeTexts[0]!);
  await expect(low).toHaveText(extremeTexts[1]!);
  await openSettings(page);
  await expect(extreme).toHaveAttribute("aria-pressed", "true");
  await extremesSwitch(page).click();
  await expect(high).toBeHidden();
  for (const button of [current, extreme]) await expect(button).toBeDisabled();
  await pollSaved(() => saved(scenario)).toMatchObject({ showExtremes: false, extremeBasis: "extreme" });
});

test("1024x768에서 차트 설정 팝오버의 모든 조작이 창 안에 있고, 등락률이 붙은 봉 값 줄은 범례 폭 안에서 줄을 바꾼다", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page);
  const settings = await openSettings(page);
  const controls = settings.locator("button, input");
  expect(await controls.count()).toBeGreaterThan(10);
  for (const control of await controls.all()) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1024);
    expect(box.y + box.height).toBeLessThanOrEqual(768);
  }

  await ohlcChangeSwitch(page).click();
  await expect(ohlc(page)).toContainText("(");
  const legend = (await cell(page).locator(".chart-legend").boundingBox())!;
  for (const value of await ohlc(page).locator(":scope > span").all()) {
    const box = (await value.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(legend.x + legend.width);
  }
});

test("기본 설정의 봉 값 줄은 좁은 데스크톱 칸에서도 지금처럼 한 줄이다", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page);
  const row = (await ohlc(page).boundingBox())!;
  const first = (await ohlc(page).locator(":scope > span").first().boundingBox())!;
  expect(row.height).toBeLessThan(first.height * 1.5);
});
