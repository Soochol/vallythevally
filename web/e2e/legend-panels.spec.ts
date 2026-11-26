import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { parseChartSettings } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { installFrameProbe } from "./frame-probe";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test, firstChart, withFirstChart, pollSaved } from "./harness";
import { useCenterIndicatorWindow } from "./indicator-window";

async function settings(scenario: Scenario) {
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  return parseChartSettings(firstChart(layout).chartSettings);
}

async function seed(scenario: Scenario) {
  useCenterIndicatorWindow(scenario);
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: [
    { id: "ma", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["#C7F36B"], width: 1 } },
    { id: "volume", spec: { kind: "volume", maPeriod: null }, panel: "p-volume", visible: true, style: { colors: ["ind-1"], width: 1 } },
    { id: "rsi", spec: { kind: "rsi", period: 14, signal: null }, panel: "p-rsi", visible: true, style: { colors: ["ind-2"], width: 1 } },
  ], panels: [{ id: "p-volume", stretch: 0.25 }, { id: "p-rsi", stretch: 0.25 }] };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D", chartSettings }) });
}

const row = (page: Page, id: string) => cell(page).locator(`[data-indicator-row="${id}"]`);
const heights = (page: Page) => page.evaluate(() => window.chartProbe.chart.panes().map((pane) => pane.getHeight()));
const maLine = (page: Page) => page.evaluate(() => window.frameProbe.snapshot().find((series) => series.type === "Custom" && series.scaleMode !== 2));

async function open(page: Page, scenario: Scenario) {
  await seed(scenario);
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installFrameProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(row(page, "ma")).toContainText("이동평균");
  await expect.poll(() => maLine(page).then((line) => line?.data.length ?? 0)).toBeGreaterThan(0);
}

async function resize(page: Page) {
  const handle = cell(page).locator('[data-panel-resize="p-volume"]');
  const box = await handle.boundingBox();
  if (!box) throw new Error("높이 손잡이가 없습니다");
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height / 2 - 45, { steps: 8 });
  await page.mouse.up();
}

test("범례 설정은 기간·색·굵기를 즉시 그리고 Esc로 처음 값과 선을 복원한다", async ({ page, scenario }) => {
  await open(page, scenario);
  const original = await maLine(page);
  await row(page, "ma").getByRole("button", { name: /설정 열기/ }).click();
  const popup = page.getByRole("dialog", { name: /이동평균.*설정/ });
  await popup.getByRole("button", { name: "색 더 보기", exact: true }).click();
  await popup.getByRole("textbox", { name: "기간", exact: true }).fill("10");
  await expect(row(page, "ma")).toContainText("10");
  await expect.poll(() => maLine(page).then((line) => line?.data)).not.toEqual(original?.data);
  const colors = popup.getByRole("group", { name: "색상표", exact: true });
  await expect(colors.getByRole("button")).toHaveCount(40);
  const swatch = colors.getByRole("button", { name: "진한 파랑 #4A7FE0", exact: true });
  const color = "#4A7FE0";
  await swatch.click();
  await expect(swatch).toHaveAttribute("aria-pressed", "true");
  await popup.getByRole("group", { name: "굵기", exact: true }).getByRole("button", { name: "5", exact: true }).click();
  await expect.poll(() => maLine(page).then((line) => line?.style)).toEqual({ color, width: 5 });
  await pollSaved(async () => (await settings(scenario)).indicators[0]?.style).toEqual({ colors: [color], width: 5 });
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect.poll(() => maLine(page).then((line) => ({ data: line?.data, style: line?.style }))).toEqual({ data: original?.data, style: original?.style });
  await pollSaved(async () => (await settings(scenario)).indicators[0]?.spec).toEqual({ kind: "ma", method: "sma", period: 5 });
  await pollSaved(async () => (await settings(scenario)).indicators[0]?.style).toEqual({ colors: ["#C7F36B"], width: 1 });
  await expect(row(page, "ma").getByRole("button", { name: /설정 열기/ })).toBeFocused();
});

test("높이와 접기를 저장하고 새로고침해 복원하며 접힌 패널은 최신 값 한 줄이다", async ({ page, scenario }) => {
  await open(page, scenario);
  const before = await heights(page);
  await resize(page);
  await expect.poll(() => heights(page).then((values) => values[1]! - before[1]!)).toBeGreaterThan(35);
  await pollSaved(async () => (await settings(scenario)).panels[0]?.stretch).toBeGreaterThan(0.25);
  const resized = await heights(page);
  await row(page, "volume").hover();
  await row(page, "volume").getByRole("button", { name: /패널 접기/ }).click();
  await expect.poll(() => heights(page).then((values) => values[1])).toBeLessThanOrEqual(31);
  await expect(row(page, "volume")).toContainText(/거래량.*\d/);
  await pollSaved(async () => (await settings(scenario)).panels[0]?.collapsed).toBe(true);

  await page.reload();
  await expect(row(page, "volume").getByRole("button", { name: /패널 펼치기/ })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => heights(page).then((values) => values[1])).toBeLessThanOrEqual(31);
  await row(page, "volume").hover();
  await row(page, "volume").getByRole("button", { name: /패널 펼치기/ }).click();
  await expect.poll(() => heights(page).then((values) => Math.abs(values[1]! - resized[1]!))).toBeLessThanOrEqual(2);
  const handle = cell(page).locator('[data-panel-resize="p-volume"]');
  await handle.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => heights(page).then((values) => values[1]! - resized[1]!)).toBeGreaterThan(10);
});

for (const key of ["T", "H"]) {
  test(`${key} 도구에서도 범례·팝오버·손잡이 입력은 드로잉 저장을 바꾸지 않는다`, async ({ page, scenario }) => {
    await open(page, scenario);
    const before = scenario.documents.drawings("005930");
    const mutations: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/drawings") && request.method() !== "GET") mutations.push(request.method()); });
    await cell(page).focus(); await page.keyboard.press(key);
    await row(page, "ma").getByRole("button", { name: /설정 열기/ }).click();
    const popup = page.getByRole("dialog", { name: /이동평균.*설정/ });
  await popup.getByRole("button", { name: "색 더 보기", exact: true }).click();
    await popup.getByRole("textbox", { name: "기간", exact: true }).fill("7");
    await popup.getByRole("button", { name: "직접 고르기" }).click();
    await expect(page.getByRole("dialog", { name: "선 색", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "선 색", exact: true })).toHaveCount(0);
    await expect(popup).toBeVisible();
    await popup.getByRole("group", { name: "굵기", exact: true }).getByRole("button", { name: "3", exact: true }).click();
    await popup.getByRole("button", { name: "설정 닫기" }).click();
    await row(page, "ma").hover();
    await row(page, "ma").getByRole("button", { name: /숨기기/ }).click();
    await resize(page);
    await row(page, "rsi").hover();
    await row(page, "rsi").getByRole("button", { name: /패널 접기/ }).click();
    await pollSaved(async () => (await settings(scenario)).panels[1]?.collapsed).toBe(true);
    expect(scenario.documents.drawings("005930")).toEqual(before);
    expect(mutations).toEqual([]);
    await page.reload();
    await expect(row(page, "ma")).toContainText("7");
    expect(scenario.documents.drawings("005930")).toEqual(before);
    expect(mutations).toEqual([]);
  });
}

test("손잡이 화살표는 고른 드로잉을 움직이지 않고 범례에서 검색 단축키도 열린다", async ({ page, scenario }) => {
  await open(page, scenario);
  const box = await cell(page).boundingBox();
  if (!box) throw new Error("차트가 없습니다");
  await cell(page).focus();
  await page.keyboard.press("H");
  await page.mouse.click(box.x + box.width * 0.7, box.y + 250);
  await expect(page.getByRole("toolbar", { name: "드로잉 스타일" })).toBeVisible();
  await pollSaved(async () => scenario.documents.drawings("005930").length).toBe(1);
  const before = scenario.documents.drawings("005930");
  const mutations: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/drawings") && request.method() !== "GET") mutations.push(request.method()); });
  const height = (await heights(page))[1]!;
  await cell(page).locator('[data-panel-resize="p-volume"]').focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => heights(page).then((values) => values[1]! - height)).toBeGreaterThan(10);
  await pollSaved(async () => (await settings(scenario)).panels[0]?.stretch).toBeGreaterThan(0.25);
  expect(scenario.documents.drawings("005930")).toEqual(before);
  expect(mutations).toEqual([]);
  await row(page, "ma").getByRole("button", { name: /설정 열기/ }).focus();
  await page.keyboard.press("/");
  await expect(page.getByRole("dialog", { name: "종목 검색", exact: true })).toBeVisible();
});

for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`범례 팝오버 화면 ${size.width}×${size.height}`, async ({ page, scenario }) => {
    await page.setViewportSize(size);
    await open(page, scenario);
    const fold = cell(page).locator("[data-indicator-fold]:visible");
    if (await fold.count()) await fold.first().hover();
    await row(page, "ma").hover();
    await row(page, "ma").getByRole("button", { name: /설정 열기/ }).click();
    await expect(page.getByRole("dialog", { name: /이동평균.*설정/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    if (process.env.VALLY_E2E_SCREENSHOTS === "1") { await mkdir(resolve("../target/ux-screens"), { recursive: true }); await page.screenshot({ path: resolve(`../target/ux-screens/legend-panels-${size.width}x${size.height}.png`) }); }
  });
}

for (const [id, label, period] of [["rsi", "아래 패널 지표", "9"], ["ma", "가격 패널 지표", "10"]] satisfies [string, string, string][]) {
  test(`${label}는 팝오버를 연 채 같은 줄의 숨기기를 한 번 눌러 숨기고 팝오버를 닫으며 고친 값을 유지한다`, async ({ page, scenario }) => {
    await open(page, scenario);
    await row(page, id).getByRole("button", { name: /설정 열기/ }).click();
    const popup = page.getByRole("dialog", { name: /설정$/ });
    await popup.getByRole("textbox", { name: "기간", exact: true }).fill(period);
    await pollSaved(async () => (await settings(scenario)).indicators.find((i) => i.id === id)?.spec).toMatchObject({ period: Number(period) });
    await row(page, id).getByRole("button", { name: /숨기기/ }).click();
    await expect(popup).toHaveCount(0);
    await expect(row(page, id).getByRole("button", { name: /보이기/ })).toHaveCount(1);
    await pollSaved(async () => (await settings(scenario)).indicators.find((i) => i.id === id)).toMatchObject({ visible: false, spec: { period: Number(period) } });
  });
}

test("팝오버를 연 채 차트의 빈 곳이나 다른 줄의 숨기기를 누르면 팝오버만 닫히고 그 클릭은 실행되지 않는다", async ({ page, scenario }) => {
  await open(page, scenario);
  const opened = async () => {
    await row(page, "rsi").getByRole("button", { name: /설정 열기/ }).click();
    const popup = page.getByRole("dialog", { name: /RSI.*설정/ });
    await expect(popup).toBeVisible();
    return popup;
  };
  let popup = await opened();
  await row(page, "ma").getByRole("button", { name: /숨기기/ }).evaluate((button) => {
    for (const type of ["pointerdown", "pointerup"]) button.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0 }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, detail: 1 }));
  });
  await expect(popup).toHaveCount(0);
  await expect(row(page, "ma").getByRole("button", { name: /숨기기/ })).toHaveCount(1);
  popup = await opened();
  const box = await cell(page).boundingBox();
  if (!box) throw new Error("차트가 없습니다");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await expect(popup).toHaveCount(0);
  expect((await settings(scenario)).indicators.map((i) => [i.id, i.visible])).toEqual([["ma", true], ["volume", true], ["rsi", true]]);
});

test("키보드 Enter로 숨기기는 팝오버와 상관없이 바로 숨긴다", async ({ page, scenario }) => {
  await open(page, scenario);
  await row(page, "rsi").getByRole("button", { name: /숨기기/ }).focus();
  await page.keyboard.press("Enter");
  await expect(row(page, "rsi").getByRole("button", { name: /보이기/ })).toHaveCount(1);
});

async function recordPointerEvents(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { seenPointerEvents: seen });
    for (const type of ["click", "contextmenu"]) document.addEventListener(type, () => seen.push(type), true);
  });
}
const seenPointerEvents = (page: Page) => page.evaluate(() => (window as unknown as { seenPointerEvents: string[] }).seenPointerEvents);

test("열린 팝오버 줄의 숨기기를 오른쪽 클릭하면 팝오버만 닫고 메뉴·숨기기를 실행하지 않는다", async ({ page, scenario }) => {
  await open(page, scenario);
  const popup = await openRsiPopup(page);
  await recordPointerEvents(page);
  await row(page, "rsi").getByRole("button", { name: /숨기기/ }).click({ button: "right" });
  await expect(popup).toHaveCount(0);
  expect(await seenPointerEvents(page)).toEqual([]);
  expect((await settings(scenario)).indicators.find((i) => i.id === "rsi")?.visible).toBe(true);
});

test("열린 팝오버 줄의 숨기기에서 눌러 다른 곳에서 떼면 숨기지 않고 click도 소비한다", async ({ page, scenario }) => {
  await open(page, scenario);
  const popup = await openRsiPopup(page);
  await recordPointerEvents(page);
  const button = await row(page, "rsi").getByRole("button", { name: /숨기기/ }).boundingBox();
  const chart = await cell(page).boundingBox();
  if (!button || !chart) throw new Error("범례 버튼이나 차트가 없습니다");
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await page.mouse.down();
  await page.mouse.move(chart.x + chart.width * 0.5, chart.y + chart.height * 0.3, { steps: 6 });
  await page.mouse.up();
  await expect(popup).toHaveCount(0);
  expect(await seenPointerEvents(page)).toEqual([]);
  expect((await settings(scenario)).indicators.find((i) => i.id === "rsi")?.visible).toBe(true);
});

async function openRsiPopup(page: Page) {
  await row(page, "rsi").getByRole("button", { name: /설정 열기/ }).click();
  const popup = page.getByRole("dialog", { name: /RSI.*설정/ });
  await expect(popup).toBeVisible();
  await row(page, "rsi").hover();
  return popup;
}

test.describe("범례 패널 회귀", () => {
  const layoutOf = async (scenario: Scenario): Promise<Layout> => scenario.documents.layout(DEFAULT_LAYOUT_ID);

  const openPanels = async (page: Page, scenario: Scenario, height = 900, stretches = Array.from({ length: 6 }, () => 0.25)) => {
    useCenterIndicatorWindow(scenario);
    const saved = await layoutOf(scenario);
    const chartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: [
      ...[5, 20].map((period, i) => ({ id: `ma${i}`, spec: { kind: "ma", method: "sma", period }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } })),
      ...stretches.map((_, i) => ({ id: `rsi${i}`, spec: { kind: "rsi", period: 14, signal: null }, panel: `p${i}`, visible: true, style: { colors: ["ind-2"], width: 1 } })),
    ], panels: stretches.map((stretch, i) => ({ id: `p${i}`, stretch })) };
    scenario.documents.saveLayout({ ...saved, revision: saved.revision + 1, windows: withFirstChart(saved, { symbol: "005930", venue: "combined", period: "D", chartSettings }) });
    await page.setViewportSize({ width: 1440, height });
    await page.addInitScript(installChartProbe);
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(cell(page).locator("[data-indicator-row]")).toHaveCount(8);
    await expect.poll(() => page.evaluate(() => window.chartProbe?.chart.panes().length)).toBe(7);
  };

  const panes = (page: Page) =>
    page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return window.chartProbe.chart.panes().map((pane) => ({ height: pane.getHeight(), stretch: pane.getStretchFactor() }));
    });

  for (const height of [300, 900]) {
    test(`높이 ${height}의 6개 패널은 손잡이 극한 조절에서도 양수와 인접 높이 합을 지킨다`, async ({ page, scenario }) => {
      await openPanels(page, scenario, height);
      for (const below of [2, 1]) {
        const handle = cell(page).locator(`[data-panel-resize="p${below - 1}"]`);
        const before = await panes(page);
        const pairHeight = before[below - 1]!.height + before[below]!.height;
        const pairShare = (before[below - 1]!.stretch + before[below]!.stretch) / before.reduce((sum, pane) => sum + pane.stretch, 0);
        const verify = async () => {
          const after = await panes(page);
          expect(after.every((pane) => Number.isFinite(pane.stretch) && pane.stretch > 0)).toBe(true);
          expect((after[below - 1]!.stretch + after[below]!.stretch) / after.reduce((sum, pane) => sum + pane.stretch, 0)).toBeCloseTo(pairShare, 10);
          expect(after[below - 1]!.height + after[below]!.height).toBe(pairHeight);
          expect(after.filter((_, i) => i !== below - 1 && i !== below).map((pane) => pane.height)).toEqual(before.filter((_, i) => i !== below - 1 && i !== below).map((pane) => pane.height));
          if (pairHeight < (below === 1 ? 80 : 48) + 48) expect(after).toEqual(before);
        };
        await handle.focus();
        for (const key of ["ArrowDown", "ArrowUp"]) {
          for (let i = 0; i < 12; i++) await page.keyboard.press(key);
          await verify();
        }
        for (const delta of [1000, -1000]) {
          const box = await handle.boundingBox();
          if (!box) throw new Error("패널 손잡이가 없습니다");
          const x = box.x + box.width * 0.65;
          const y = box.y + box.height / 2;
          await page.mouse.move(x, y); await page.mouse.down();
          await page.mouse.move(x, y + delta, { steps: 10 }); await page.mouse.up();
          await verify();
        }
        const rest = await panes(page);
        const box = await handle.boundingBox();
        if (!box) throw new Error("패널 손잡이가 없습니다");
        const x = box.x + box.width * 0.65;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x, y + 16, { steps: 3 });
        await page.mouse.move(x, y, { steps: 3 }); await page.mouse.up();
        expect((await panes(page)).map((pane) => pane.height)).toEqual(rest.map((pane) => pane.height));
      }
    });
  }

  test("음수·0으로 저장된 패널 높이는 다른 설정을 보존하며 기본 비율로 복구한다", async ({ page, scenario }) => {
    await openPanels(page, scenario, 900, [-0.1, 0, 0.3, 0.3, 0.3, 0.3]);
    const shown = await panes(page);
    expect(shown.map((pane) => pane.stretch)).toEqual([1, 0.25, 0.25, 0.3, 0.3, 0.3, 0.3]);
    await row(page, "ma1").hover();
    await row(page, "ma1").getByRole("button", { name: /숨기기/ }).click();
    await pollSaved(async () => firstChart(await layoutOf(scenario)).chartSettings).toMatchObject({ panels: [{ id: "p0", stretch: 0.25 }, { id: "p1", stretch: 0.25 }, { id: "p2", stretch: 0.3 }, { id: "p3", stretch: 0.3 }, { id: "p4", stretch: 0.3 }, { id: "p5", stretch: 0.3 }] });
  });

  test("같은 지표 이름을 다시 눌러도 Esc는 처음 연 설정으로 돌아간다", async ({ page, scenario }) => {
    await openPanels(page, scenario);
    const name = row(page, "ma0").getByRole("button", { name: /설정 열기/ });
    await row(page, "ma0").hover();
    await name.click();
    const popup = page.getByRole("dialog", { name: "이동평균 단순 5 설정", exact: true });
    await popup.getByRole("textbox", { name: "기간", exact: true }).fill("9");
    await expect(row(page, "ma0")).toContainText("단순 9");
    await name.click();
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row(page, "ma0")).toContainText("단순 5");
    await pollSaved(async () => firstChart(await layoutOf(scenario)).chartSettings).toMatchObject({ indicators: [ { id: "ma0", spec: { period: 5 } }, { id: "ma1", spec: { period: 20 } }, ...Array.from({ length: 6 }, (_, i) => ({ id: `rsi${i}` })) ] });
  });

  test("다른 지표 이름은 한 번 눌러 전환하고 각 창의 Esc 원본을 따로 유지한다", async ({ page, scenario }) => {
    await openPanels(page, scenario);
    await row(page, "ma0").hover();
    await row(page, "ma0").getByRole("button", { name: "이동평균 단순 5 설정", exact: true }).click();
    await page.getByRole("dialog", { name: "이동평균 단순 5 설정", exact: true }).getByRole("textbox", { name: "기간", exact: true }).fill("9");
    await expect(row(page, "ma0")).toContainText("단순 9");
    await row(page, "ma1").hover();
    await row(page, "ma1").getByRole("button", { name: /설정 열기/ }).click();
    const next = page.getByRole("dialog", { name: "이동평균 단순 20 설정", exact: true });
    await expect(next).toBeVisible();
    await expect(next.getByRole("textbox", { name: "기간", exact: true })).toHaveValue("20");
    await next.getByRole("textbox", { name: "기간", exact: true }).fill("25");
    await expect(row(page, "ma1")).toContainText("단순 25");
    await page.keyboard.press("Escape");
    await expect(row(page, "ma0")).toContainText("단순 9");
    await expect(row(page, "ma1")).toContainText("단순 20");
    await row(page, "ma0").hover();
    await row(page, "ma0").getByRole("button", { name: /설정 열기/ }).click();
    await page.getByRole("dialog", { name: "이동평균 단순 9 설정", exact: true }).getByRole("textbox", { name: "기간", exact: true }).fill("11");
    await page.keyboard.press("Escape");
    await expect(row(page, "ma0")).toContainText("단순 9");
  });

  test("보조지표 범례의 접기·이동 화살표는 평소 숨겨지고 호버 시 나타나며 접힌 상태에서는 펼치기 화살표만 보인다", async ({ page, scenario }) => {
    await open(page, scenario);
    const box = await cell(page).boundingBox();
    if (!box) throw new Error("차트가 없습니다");
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);

    const opacityOf = (id: string, command: string) =>
      row(page, id).locator(`[data-indicator-command="${command}"]`).evaluate((node) => getComputedStyle(node).opacity);

    for (const [id, command] of [["volume", "collapse"], ["volume", "up"], ["volume", "down"], ["rsi", "collapse"], ["rsi", "up"], ["rsi", "down"]] as const) {
      await expect.poll(() => opacityOf(id, command)).toBe("0");
    }

    await row(page, "volume").hover();
    await expect.poll(() => opacityOf("volume", "collapse")).toBe("1");
    await expect.poll(() => opacityOf("volume", "up")).toBe("0.4");
    await expect.poll(() => opacityOf("volume", "down")).toBe("1");

    await row(page, "rsi").hover();
    await expect.poll(() => opacityOf("rsi", "collapse")).toBe("1");
    await expect.poll(() => opacityOf("rsi", "up")).toBe("1");
    await expect.poll(() => opacityOf("rsi", "down")).toBe("0.4");

    await row(page, "rsi").getByRole("button", { name: /패널 접기/ }).click();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
    await expect.poll(() => opacityOf("rsi", "collapse")).toBe("1");
    await expect.poll(() => opacityOf("rsi", "down")).toBe("0");
  });
});
