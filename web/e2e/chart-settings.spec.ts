import type { Page } from "@playwright/test";
import type { ChartSettings } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

const RIGHT_OFFSET = 6;

const saved = (scenario: Scenario) => scenario.documents.layout(DEFAULT_LAYOUT_ID).cells[0]!.chartSettings as ChartSettings;
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
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0]!, symbol: "005930", venue: "combined", chartSettings: { ...saved(scenario), compare: ["000660"] } }] });
  await open(page);
  const settings = await openSettings(page);
  const scale = settings.getByRole("group", { name: "가격 축" });
  for (const name of ["일반", "로그", "%"]) await expect(scale.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(scale.getByRole("button", { name: "%", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(settings.getByText("비교 종목이 있으면 % 축으로 그립니다")).toBeVisible();
});

test("화면 왼쪽에 반쯤 잘린 봉이 가장 높아도 최고 꼬리표는 화면 안의 가장 높은 봉에 붙는다", async ({ page, scenario }) => {
  const day = 86_400;
  const start = Date.parse("2025-01-01T00:00:00+09:00") / 1000;
  const bars = Array.from({ length: 300 }, (_, i) => {
    const h = 100_000 - i * 100;
    return { t: start + i * day, o: h - 200, h, l: h - 500, c: h - 300, v: 1000 };
  });
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === "D",
    { body: { symbol: "005930", venue: "combined", period: "D", bars, current: null, nextBefore: null, seq: null } });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0]!, symbol: "005930", venue: "combined", period: "D",
    chartSettings: { ...saved(scenario), visibleBars: 60, showExtremes: true } }] });
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
});
