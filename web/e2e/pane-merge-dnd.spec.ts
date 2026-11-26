import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { parseChartSettings } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, firstChart, pollSaved, test, withFirstChart } from "./harness";

const VOLUME = { id: "volume", spec: { kind: "volume", maPeriod: 20 }, panel: "p-volume", visible: true, style: { colors: ["ind-1"], width: 1 } };
const RSI = { id: "rsi", spec: { kind: "rsi", period: 14, signal: null }, panel: "p-rsi", visible: true, style: { colors: ["ind-2"], width: 1 } };
const MACD = { id: "macd", spec: { kind: "macd", fast: 12, slow: 26, signal: 9 }, panel: "p-macd", visible: true, style: { colors: ["ind-3"], width: 1 } };

const saved = (scenario: Scenario) => parseChartSettings(firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings);
const row = (page: Page, id: string) => cell(page).locator(`[data-indicator-row="${id}"]`);
const paneCount = (page: Page) => page.evaluate(() => window.chartProbe.chart.panes().length);
const leftAxisVisible = (page: Page) => page.evaluate(() => window.chartProbe.chart.priceScale("left").options().visible);

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

async function open(page: Page, scenario: Scenario, indicators: object[] = [VOLUME, RSI, MACD], panels: object[] = [
  { id: "p-volume", stretch: 0.25 },
  { id: "p-rsi", stretch: 0.25 },
  { id: "p-macd", stretch: 0.25 },
]) {
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators, panels };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D", chartSettings }) });
  await page.addInitScript(installChartProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => paneCount(page)).toBe(panels.length + 1);
}

async function dragRowTo(page: Page, id: string, targetX: number, targetY: number) {
  const grip = row(page, id).locator("[data-indicator-grip]");
  const box = await grip.boundingBox();
  if (!box) throw new Error(`그립 손잡이가 없습니다: ${id}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 10 });
  await page.mouse.up();
}

test("보조지표 범례를 다른 패널 중앙에 드롭하면 합쳐지고 좌측 Y축이 자동 활성화되며 새로고침 뒤에도 유지된다", async ({ page, scenario }) => {
  await open(page, scenario);
  expect(await leftAxisVisible(page)).toBe(false);

  const panes = await paneBoxes(page);
  const volPane = panes[1]!;
  await dragRowTo(page, "rsi", volPane.x + volPane.width * 0.45, volPane.top + volPane.height * 0.5);

  await expect.poll(() => paneCount(page)).toBe(3);
  await expect.poll(() => leftAxisVisible(page)).toBe(true);
  await expect(row(page, "volume").locator("[data-indicator-axis]")).toHaveText("R");
  await expect(row(page, "rsi").locator("[data-indicator-axis]")).toHaveText("L");
  await pollSaved(() => saved(scenario).panels.map((p) => p.id)).toEqual(["p-volume", "p-macd"]);
  await pollSaved(() => saved(scenario).indicators.map((i) => [i.id, i.panel])).toEqual([
    ["volume", "p-volume"],
    ["rsi", "p-volume"],
    ["macd", "p-macd"],
  ]);

  const [volBox, rsiBox] = await Promise.all([row(page, "volume").boundingBox(), row(page, "rsi").boundingBox()]);
  expect(rsiBox!.y).toBeGreaterThan(volBox!.y + 10);

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => paneCount(page)).toBe(3);
  await expect.poll(() => leftAxisVisible(page)).toBe(true);
  await expect(row(page, "rsi").locator("[data-indicator-axis]")).toHaveText("L");
});

test("합쳐진 패널에서 축 배지를 누르면 L→독립→R 순으로 전환하고 1클릭 분리로 독립 패널로 되돌린다", async ({ page, scenario }) => {
  await open(page, scenario, [VOLUME, { ...RSI, panel: "p-volume" }, MACD], [
    { id: "p-volume", stretch: 0.34 },
    { id: "p-macd", stretch: 0.25 },
  ]);
  await expect.poll(() => leftAxisVisible(page)).toBe(true);

  const axisBtn = row(page, "rsi").locator("[data-indicator-axis]");
  await expect(axisBtn).toHaveText("L");
  await axisBtn.click();
  await expect(axisBtn).toHaveText("독립");
  await expect.poll(() => leftAxisVisible(page)).toBe(false);
  await pollSaved(() => saved(scenario).indicators.find((i) => i.id === "rsi")?.axis).toBe("overlay");

  await axisBtn.click();
  await expect(axisBtn).toHaveText("R");
  await pollSaved(() => saved(scenario).indicators.find((i) => i.id === "rsi")?.axis).toBe("right");

  await row(page, "rsi").hover();
  await row(page, "rsi").getByRole("button", { name: /새 패널로 분리/ }).click();
  await expect.poll(() => paneCount(page)).toBe(4);
  await pollSaved(() => saved(scenario).panels.length).toBe(3);
  await expect(row(page, "rsi").locator("[data-indicator-axis]")).toBeHidden();
});

test("합쳐진 지표는 패널 경계선에 드롭해 분리하고 단독 패널은 경계선 드롭으로 순서를 바꾼다", async ({ page, scenario }) => {
  await open(page, scenario, [VOLUME, { ...RSI, panel: "p-volume" }, MACD], [
    { id: "p-volume", stretch: 0.34 },
    { id: "p-macd", stretch: 0.25 },
  ]);
  const panes = await paneBoxes(page);
  const macdPane = panes[2]!;

  await dragRowTo(page, "rsi", macdPane.x + macdPane.width * 0.45, macdPane.top + macdPane.height - 6);
  await expect.poll(() => paneCount(page)).toBe(4);
  await pollSaved(() => saved(scenario).panels.length).toBe(3);
  const splitOrder = saved(scenario).panels.map((p) => p.id);
  expect(splitOrder[0]).toBe("p-volume");
  expect(splitOrder[1]).toBe("p-macd");

  const updatedPanes = await paneBoxes(page);
  const topPane = updatedPanes[1]!;
  await dragRowTo(page, "macd", topPane.x + topPane.width * 0.45, topPane.top + 6);
  await pollSaved(() => saved(scenario).panels.map((p) => p.id)).toEqual(["p-macd", "p-volume", splitOrder[2]]);
});

test("거래량 범례를 가격 패널 중앙으로 끌면 가격 패널에 겹쳐지고 아래 경계선으로 끌면 다시 분리된다", async ({ page, scenario }) => {
  await open(page, scenario, [VOLUME, RSI], [
    { id: "p-volume", stretch: 0.25 },
    { id: "p-rsi", stretch: 0.25 },
  ]);
  const panes = await paneBoxes(page);
  const pricePane = panes[0]!;
  await dragRowTo(page, "volume", pricePane.x + pricePane.width * 0.5, pricePane.top + pricePane.height * 0.4);
  await expect.poll(() => paneCount(page)).toBe(2);
  await pollSaved(() => saved(scenario).indicators.find((i) => i.id === "volume")?.panel).toBe("price");

  const afterPanes = await paneBoxes(page);
  const rsiPane = afterPanes[1]!;
  await dragRowTo(page, "volume", rsiPane.x + rsiPane.width * 0.5, rsiPane.top + rsiPane.height - 6);
  await expect.poll(() => paneCount(page)).toBe(3);
  await pollSaved(() => saved(scenario).panels.length).toBe(2);
});
