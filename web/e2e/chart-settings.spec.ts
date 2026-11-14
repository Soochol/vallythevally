import type { Page } from "@playwright/test";
import { type ChartSettings, DEFAULT_CHART_SETTINGS, type IndicatorConfig } from "../src/chart/settings";
import type { Bar } from "../src/api/generated/Bar";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, test, firstChart, withFirstChart } from "./harness";
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
  await expect.poll(() => saved(scenario).visibleBars).toBe(240);

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
  await expect.poll(() => saved(scenario).visibleBars).toBe(800);
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
  await expect.poll(() => saved(scenario).visibleBars).toBeNull();
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
  await expect.poll(() => saved(scenario).showExtremes).toBe(true);

  const expected = () => page.evaluate(() => {
    const { chart, main } = window.chartProbe;
    const scale = chart.timeScale();
    const range = scale.getVisibleLogicalRange()!;
    let high = -Infinity;
    let low = Infinity;
    for (let i = Math.max(0, Math.floor(range.from)); i <= Math.ceil(range.to); i++) {
      const bar = main.dataByIndex(i);
      const x = bar ? scale.timeToCoordinate(bar.time) : null;
      if (!bar || !("high" in bar) || x === null || x < 0 || x > scale.width()) continue;
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
    }
    const lastBar = main.dataByIndex(Number.MAX_SAFE_INTEGER, -1);
    const last = lastBar && "close" in lastBar ? lastBar.close : 0;
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
  await expect.poll(() => saved(scenario).showExtremes).toBe(false);
});

test("팝오버의 봉 모양과 가격 축은 활성 칸에 바로 반영한다", async ({ page, scenario }) => {
  await open(page);
  const settings = await openSettings(page);
  const style = settings.getByRole("group", { name: "봉 모양" });
  const scale = settings.getByRole("group", { name: "가격 축" });
  await style.getByRole("button", { name: "라인", exact: true }).click();
  await expect(style.getByRole("button", { name: "라인", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => saved(scenario).style).toBe("line");
  await style.getByRole("button", { name: "캔들", exact: true }).click();
  await expect.poll(() => saved(scenario).style).toBe("candle");

  await scale.getByRole("button", { name: "로그", exact: true }).click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "log");
  await scale.getByRole("button", { name: "일반", exact: true }).click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "normal");
  await expect.poll(() => saved(scenario).scale).toBe("normal");
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

test("화면 가장자리에 반쯤 잘린 봉은 최고·최저에서 빼고, 첫 봉이나 마지막 봉이 잘려도 오류 없이 다시 그린다", async ({ page, scenario }) => {
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
  const lastClose = bars.at(-1)!.c;
  const highText = (index: number) => `최고 ${new Intl.NumberFormat("ko-KR").format(bars[index]!.h)} (+${((bars[index]!.h - lastClose) / lastClose * 100).toFixed(2)}%)`;
  await expect(high).toHaveText(highText(240));

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
    return { cutX: x(cut), firstShown: x(cut)! < 0 ? cut + 1 : cut };
  });
  expect(edge.cutX).not.toBeNull();
  expect(edge.cutX!).toBeLessThan(0);
  const firstShown = edge.firstShown;
  await expect(high).toBeVisible();
  await expect(high).toHaveText(highText(firstShown));

  const low = cell(page).locator("[data-extreme=low] > span");
  const lowText = (index: number) => {
    const change = (bars[index]!.l - lastClose) / lastClose * 100;
    return `최저 ${new Intl.NumberFormat("ko-KR").format(bars[index]!.l)} (${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(change).toFixed(2)}%)`;
  };
  for (const range of [{ from: 238.6, to: 298.6 }, { from: 0.3, to: 60.3 }]) {
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
    await expect(high).toHaveText(highText(shown[0]!));
    await expect(low).toHaveText(lowText(shown.at(-1)!));
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
  await expect.poll(() => scenario.documents.uiState().indicatorWindow).toBe("inspector");
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
const ohlcSwitch = (page: Page) => popover(page).getByRole("switch", { name: /^봉 값 \(/ });
const ohlcChangeSwitch = (page: Page) => popover(page).getByRole("switch", { name: /^봉 값 등락률/ });
const extremesSwitch = (page: Page) => popover(page).getByRole("switch", { name: /^화면 내 최고·최저/ });
const basisGroup = (page: Page) => popover(page).getByRole("group", { name: "최고·최저 등락률" });

function openWith(scenario: Scenario, settings: Partial<ChartSettings>, bars: Bar[] = zigzagBars) {
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "D",
    { body: { symbol: "005930", venue: "combined", period: "D", bars, current: null, nextBefore: null, seq: null } });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D",
    chartSettings: { ...DEFAULT_CHART_SETTINGS, ...settings } }) });
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

test("봉 값 스위치를 끄면 범례의 봉 값 줄만 숨기고, 봉 주기를 바꾸거나 새로고침해도 꺼진 채다", async ({ page, scenario }) => {
  const ma: IndicatorConfig = { id: "ma-price", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } };
  openWith(scenario, { indicators: [...DEFAULT_CHART_SETTINGS.indicators, ma] });
  await open(page);
  const priceRow = ohlc(page).locator("xpath=preceding-sibling::div[1]");
  const name = cell(page).locator(".chart-legend [role=heading]");
  const maRow = cell(page).locator(`[data-indicator-row="${ma.id}"]`);
  await expect(ohlc(page)).toBeVisible();
  await expect(ohlc(page)).toContainText("시");
  await expect(ohlc(page)).not.toContainText("(");
  await expect(maRow).toBeVisible();
  expect(saved(scenario)).toMatchObject({ showOhlc: true, showOhlcChange: false, extremeBasis: "last" });

  await openSettings(page);
  await expect(ohlcSwitch(page)).toHaveAttribute("aria-checked", "true");
  await ohlcSwitch(page).click();
  await expect(ohlcSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(ohlc(page)).toBeHidden();
  for (const kept of [name, priceRow, maRow]) await expect(kept).toBeVisible();
  const priceBottom = (await priceRow.boundingBox())!;
  expect((await maRow.boundingBox())!.y - (priceBottom.y + priceBottom.height)).toBeLessThan(12);
  await expect.poll(() => saved(scenario).showOhlc).toBe(false);

  await page.keyboard.press("Escape");
  await selectMinute(page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "분봉", exact: true }), { label: "5분" });
  await expect(cell(page)).toHaveAttribute("aria-label", / 5분$/);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(priceRow).toBeVisible();
  await expect(ohlc(page)).toBeHidden();

  await reload(page);
  await expect(priceRow).toBeVisible();
  await expect(ohlc(page)).toBeHidden();
  await openSettings(page);
  await expect(ohlcSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(ohlcChangeSwitch(page)).toBeDisabled();
});

test("봉 값 등락률 스위치는 시·고·저·종 옆에 직전 봉 종가 대비 %를 붙이고, 십자선이 가리키는 봉을 따르며, 봉 값 줄이 꺼지면 비활성이다", async ({ page, scenario }) => {
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
  await expect.poll(() => saved(scenario).showOhlcChange).toBe(true);
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
  await settingsButton(page).hover();

  await openSettings(page);
  await ohlcSwitch(page).click();
  await expect(ohlcChangeSwitch(page)).toBeDisabled();
  await expect(ohlcChangeSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => saved(scenario)).toMatchObject({ showOhlc: false, showOhlcChange: true });
  await ohlcSwitch(page).click();
  await expect(ohlcChangeSwitch(page)).toBeEnabled();
  await expect.poll(texts).toEqual(ohlcCells(zigzagBars[last]!, zigzagBars[last - 1]!));
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
  await expect(current).toHaveAttribute("title", /현재가/);
  await expect(extreme).toHaveAttribute("title", /최고가/);
  await extreme.click();
  await expect(extreme).toHaveAttribute("aria-pressed", "true");
  const extremeTexts = [`최고 ${won(highBar.h)} (${pct(highBar.h, lastClose)})`, `최저 ${won(lowBar.l)} (${pct(lowBar.l, lastClose)})`];
  await expect(high).toHaveText(extremeTexts[0]!);
  await expect(low).toHaveText(extremeTexts[1]!);
  expect(extremeTexts[0]).toContain("(−");
  expect(extremeTexts[1]).toContain("(+");
  await expect.poll(() => saved(scenario).extremeBasis).toBe("extreme");

  await reload(page);
  await expect(high).toHaveText(extremeTexts[0]!);
  await expect(low).toHaveText(extremeTexts[1]!);
  await openSettings(page);
  await expect(extreme).toHaveAttribute("aria-pressed", "true");
  await extremesSwitch(page).click();
  await expect(high).toBeHidden();
  for (const button of [current, extreme]) await expect(button).toBeDisabled();
  await expect.poll(() => saved(scenario)).toMatchObject({ showExtremes: false, extremeBasis: "extreme" });
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
