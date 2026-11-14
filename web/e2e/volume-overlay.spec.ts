import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { parseChartSettings } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, test, firstChart, withFirstChart } from "./harness";

const VOLUME = { id: "volume", spec: { kind: "volume", maPeriod: null }, panel: "p-volume", visible: true, style: { colors: ["ind-1"], width: 1 } };
const RSI = { id: "rsi", spec: { kind: "rsi", period: 14, signal: null }, panel: "p-rsi", visible: true, style: { colors: ["ind-2"], width: 1 } };

const saved = (scenario: Scenario) => parseChartSettings(firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings);
const savedVolume = (scenario: Scenario) => saved(scenario).indicators.find((i) => i.id === "volume");
const row = (page: Page, id: string) => cell(page).locator(`[data-indicator-row="${id}"]`);
const priceRow = (page: Page, id: string) => cell(page).locator(`.chart-legend [data-indicator-row="${id}"]`);
const paneCount = (page: Page) => page.evaluate(() => window.chartProbe.chart.panes().length);
const popover = (page: Page) => page.getByRole("dialog", { name: "거래량 설정", exact: true });
const overlaySwitch = (page: Page) => popover(page).getByRole("switch", { name: "가격 패널에 겹치기", exact: true });
const opacitySlider = (page: Page) => popover(page).getByRole("slider", { name: "막대 불투명도", exact: true });

function volumeBars(page: Page) {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const chart = window.chartProbe.chart;
    const panes = chart.panes();
    const found = panes.flatMap((pane, index) => pane.getSeries().map((series) => ({ series, index }))).find(({ series }) => series.seriesType() === "Histogram");
    if (!found) return null;
    const data = found.series.data() as readonly { value?: number; color?: string }[];
    const range = chart.timeScale().getVisibleLogicalRange();
    const from = Math.max(0, Math.ceil(range?.from ?? 0));
    const to = Math.min(data.length - 1, Math.floor(range?.to ?? data.length - 1));
    const max = Math.max(...data.slice(from, to + 1).map((d) => d.value ?? 0));
    const alphas = [...new Set(data.map((d) => Number(/,\s*([\d.]+)\)$/.exec(d.color ?? "")?.[1])))];
    return { pane: found.index, height: panes[found.index]!.getHeight(), top: found.series.priceToCoordinate(max), bottom: found.series.priceToCoordinate(0), alphas, count: data.length };
  });
}

async function open(page: Page, scenario: Scenario, indicators: object[] = [VOLUME], panels: object[] = [{ id: "p-volume", stretch: 0.25 }]) {
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators, panels };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D", chartSettings }) });
  await page.addInitScript(installChartProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => volumeBars(page).then((bars) => bars?.count ?? 0)).toBeGreaterThan(0);
}

async function openPopover(page: Page) {
  await row(page, "volume").getByRole("button", { name: /설정 열기/ }).click();
  await expect(popover(page)).toBeVisible();
}

async function setScale(page: Page, name: "%" | "로그" | "일반", attribute: string) {
  const settings = page.getByRole("dialog", { name: "차트 설정", exact: true });
  if (!(await settings.isVisible())) await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "차트 설정", exact: true }).click();
  await settings.getByRole("group", { name: "가격 축" }).getByRole("button", { name, exact: true }).click();
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", attribute);
}

test("가격 패널에 겹친 거래량은 아래 20%에 자기 축으로 그리고 범례·저장·새로고침·가격축 방식을 따른다", async ({ page, scenario }) => {
  await open(page, scenario);
  expect(await paneCount(page)).toBe(2);
  await expect(row(page, "volume")).toHaveCount(1);
  await expect(priceRow(page, "volume")).toHaveCount(0);
  expect(await volumeBars(page)).toMatchObject({ pane: 1, alphas: [0.38] });

  await openPopover(page);
  await expect(overlaySwitch(page)).toHaveAttribute("aria-checked", "false");
  await overlaySwitch(page).click();
  await expect(overlaySwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => paneCount(page)).toBe(1);
  await expect(priceRow(page, "volume")).toHaveCount(1);
  await expect(priceRow(page, "volume")).toContainText(/\d/);
  await expect.poll(() => savedVolume(scenario)?.panel).toBe("price");
  expect(saved(scenario).panels).toEqual([]);
  await popover(page).getByRole("button", { name: "설정 닫기", exact: true }).click();
  await expect(popover(page)).toHaveCount(0);

  const bars = await volumeBars(page);
  if (!bars || bars.top === null || bars.bottom === null) throw new Error("겹친 거래량 막대가 없습니다");
  expect(bars.pane).toBe(0);
  expect(bars.top).toBeGreaterThanOrEqual(bars.height * 0.75);
  expect(bars.bottom).toBeLessThanOrEqual(bars.height);
  expect(bars.alphas).toEqual([0.38]);

  for (const [name, attribute] of [["%", "percent"], ["로그", "log"], ["일반", "normal"]] as const) {
    await setScale(page, name, attribute);
    const scaled = await volumeBars(page);
    expect(scaled?.top).toBeCloseTo(bars.top, 0);
    expect(scaled?.bottom).toBeCloseTo(bars.bottom, 0);
  }

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => volumeBars(page).then((shown) => shown?.pane)).toBe(0);
  expect(await paneCount(page)).toBe(1);
  await expect(priceRow(page, "volume")).toHaveCount(1);
});

test("겹치기를 끄면 거래량 패널이 가격 패널 바로 아래 기본 높이로 돌아온다", async ({ page, scenario }) => {
  await open(page, scenario, [{ ...VOLUME, panel: "price" }, RSI], [{ id: "p-rsi", stretch: 0.4 }]);
  expect(await paneCount(page)).toBe(2);
  await expect(priceRow(page, "volume")).toHaveCount(1);
  await openPopover(page);
  await expect(overlaySwitch(page)).toHaveAttribute("aria-checked", "true");
  await overlaySwitch(page).click();
  await expect.poll(() => paneCount(page)).toBe(3);
  await expect.poll(() => volumeBars(page).then((bars) => bars?.pane)).toBe(1);
  await expect(priceRow(page, "volume")).toHaveCount(0);
  await expect.poll(() => saved(scenario).panels.map((p) => p.stretch)).toEqual([0.25, 0.4]);
  expect(saved(scenario).panels.map((p) => p.id)).toEqual([savedVolume(scenario)!.panel, "p-rsi"]);
  const [volumeBox, rsiBox] = await Promise.all([row(page, "volume").boundingBox(), row(page, "rsi").boundingBox()]);
  expect(volumeBox!.y).toBeLessThan(rsiBox!.y);
});

test("막대 불투명도는 막대 색의 알파로 저장·복원된다", async ({ page, scenario }) => {
  await open(page, scenario);
  await openPopover(page);
  await expect(opacitySlider(page)).toHaveValue("38");
  await expect(popover(page).getByText("38%", { exact: true })).toBeVisible();
  await opacitySlider(page).focus();
  for (let i = 0; i < 42; i++) await page.keyboard.press("ArrowRight");
  await expect(opacitySlider(page)).toHaveValue("80");
  await expect(popover(page).getByText("80%", { exact: true })).toBeVisible();
  await expect.poll(() => volumeBars(page).then((bars) => bars?.alphas)).toEqual([0.8]);
  await expect.poll(() => savedVolume(scenario)?.style.barOpacity).toBe(0.8);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => volumeBars(page).then((bars) => bars?.alphas)).toEqual([0.8]);
});

test("범례 팝오버에서 겹치기를 켠 뒤 Esc는 별도 패널로 되돌린다", async ({ page, scenario }) => {
  await open(page, scenario);
  await openPopover(page);
  await overlaySwitch(page).click();
  await expect.poll(() => paneCount(page)).toBe(1);
  await opacitySlider(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => savedVolume(scenario)?.style.barOpacity).toBe(0.37);
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect.poll(() => paneCount(page)).toBe(2);
  await expect.poll(() => volumeBars(page).then((bars) => ({ pane: bars?.pane, alphas: bars?.alphas }))).toEqual({ pane: 1, alphas: [0.38] });
  await expect.poll(() => savedVolume(scenario)?.panel).toBe("p-volume");
  expect(saved(scenario).panels).toEqual([{ id: "p-volume", stretch: 0.25 }]);
  expect(savedVolume(scenario)?.style).toEqual(VOLUME.style);
  await expect(row(page, "volume").getByRole("button", { name: /설정 열기/ })).toBeFocused();
});

test("겹치기를 켰다 끈 뒤 Esc는 열 때의 패널 순서와 높이로 되돌린다", async ({ page, scenario }) => {
  const panels = [{ id: "p-rsi", stretch: 0.4 }, { id: "p-volume", stretch: 0.3 }];
  await open(page, scenario, [RSI, VOLUME], panels);
  await openPopover(page);
  await overlaySwitch(page).click();
  await expect.poll(() => savedVolume(scenario)?.panel).toBe("price");
  await overlaySwitch(page).click();
  await expect.poll(() => saved(scenario).panels.map((p) => p.stretch)).toEqual([0.25, 0.4]);
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect.poll(() => saved(scenario).panels).toEqual(panels);
  expect(savedVolume(scenario)?.panel).toBe("p-volume");
  await expect(row(page, "volume").getByRole("button", { name: /설정 열기/ })).toBeFocused();
});

test("차트 옆 지표 창에서 겹치기를 건드리지 않고 Esc를 누르면 그사이 옮긴 다른 패널 순서를 지킨다", async ({ page, scenario }) => {
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), indicatorWindow: "inspector" });
  await open(page, scenario, [RSI, VOLUME], [{ id: "p-rsi", stretch: 0.4 }, { id: "p-volume", stretch: 0.3 }]);
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "지표", exact: true }).click();
  const inspector = page.getByRole("region", { name: "지표", exact: true });
  await inspector.getByRole("button", { name: "거래량 설정", exact: true }).click();
  const slider = inspector.getByRole("slider", { name: "막대 불투명도", exact: true });
  await expect(slider).toBeVisible();
  await row(page, "rsi").getByRole("button", { name: "RSI 14 패널 아래로" }).dispatchEvent("click");
  await expect.poll(() => saved(scenario).panels.map((p) => p.id)).toEqual(["p-volume", "p-rsi"]);
  await slider.focus();
  await page.keyboard.press("Escape");
  await expect(slider).toHaveCount(0);
  await row(page, "rsi").getByRole("button", { name: "RSI 14 숨기기" }).dispatchEvent("click");
  await expect.poll(() => saved(scenario).indicators.find((i) => i.id === "rsi")?.visible).toBe(false);
  expect(saved(scenario).panels).toEqual([{ id: "p-volume", stretch: 0.3 }, { id: "p-rsi", stretch: 0.4 }]);
});

test("지표 창에서 겹치기를 켜고 더한 거래량은 가격 패널에 겹쳐 더해진다", async ({ page, scenario }) => {
  await open(page, scenario);
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  await dialog.getByRole("combobox", { name: "지표·비교 찾기" }).fill("거래량");
  const toggle = dialog.getByRole("switch", { name: "가격 패널에 겹치기", exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => paneCount(page)).toBe(3);
  await toggle.click();
  await expect.poll(() => paneCount(page)).toBe(2);
  await dialog.getByRole("button", { name: "거래량 추가", exact: true }).click();
  await expect.poll(() => saved(scenario).indicators.map((i) => [i.spec.kind, i.panel])).toEqual([["volume", "p-volume"], ["volume", "price"]]);
  expect(saved(scenario).panels).toEqual([{ id: "p-volume", stretch: 0.25 }]);
  expect(await paneCount(page)).toBe(2);
});

test("1024×768 창에서 범례 팝오버의 두 조작이 창 안에 있다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, scenario);
  await openPopover(page);
  for (const control of [overlaySwitch(page), opacitySlider(page)]) {
    const box = await control.boundingBox();
    if (!box) throw new Error("조작이 보이지 않습니다");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1024);
    expect(box.y + box.height).toBeLessThanOrEqual(768);
  }
});
