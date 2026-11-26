import type { Locator, Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import type { ChartSettings } from "../src/chart/settings";
import { financialValue } from "../src/chart/financials";
import { financialTest } from "./financial-update-helpers";
import { installChartProbe } from "./chart-probe";
import { installFrameProbe } from "./frame-probe";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, pollSaved, test, withFirstChart } from "./harness";
import { selectOption } from "./select-option";

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const settingsButton = (page: Page) => toolbar(page).getByRole("button", { name: "차트 설정", exact: true });
const settingsPopover = (page: Page) => page.getByRole("dialog", { name: "차트 설정", exact: true });
const indicatorButton = (page: Page) => toolbar(page).getByRole("button", { name: "지표", exact: true });
const commandDialog = (page: Page) => page.getByRole("dialog", { name: "지표·비교 입력창", exact: true });
const inspector = (page: Page) => page.getByRole("region", { name: "지표", exact: true });
const colorWindow = (page: Page) => page.getByRole("dialog", { name: "선 색", exact: true });
const legendRow = (page: Page, id: string) => cell(page).locator(`[data-indicator-row="${id}"]`);

const saveIndicatorWindow = (scenario: Scenario, indicatorWindow: "dialog" | "inspector" | null) =>
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), indicatorWindow });

function seedMovingAverage(scenario: Scenario) {
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: [
    { id: "ma", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-3"], width: 1 } },
  ], panels: [] };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "D", chartSettings }) });
}

async function open(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.addInitScript(installChartProbe);
  await page.addInitScript(installFrameProbe);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

const mainSeriesTypes = (page: Page) => page.evaluate(() => window.frameProbe.snapshot().filter((series) => series.data.length > 100).map((series) => series.type));

test("1280x600에서 차트 설정 창은 화면 가운데에 다 들어오고 폭이 360px 이하이다", async ({ page }) => {
  await open(page, { width: 1280, height: 600 });
  await settingsButton(page).click();
  await expect(settingsPopover(page)).toBeVisible();
  const popover = (await settingsPopover(page).boundingBox())!;
  expect(popover.width).toBeLessThanOrEqual(360);
  expect(popover.x).toBeGreaterThanOrEqual(0);
  expect(popover.x + popover.width).toBeLessThanOrEqual(1280);
  expect(popover.y).toBeGreaterThanOrEqual(0);
  expect(popover.y + popover.height).toBeLessThanOrEqual(600);
  expect(Math.abs(popover.x + popover.width / 2 - 1280 / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(popover.y + popover.height / 2 - 600 / 2)).toBeLessThanOrEqual(2);
  await expect(settingsPopover(page).locator("xpath=..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  for (const groupName of ["봉 모양", "가격 축"] as const) {
    const group = settingsPopover(page).getByRole("group", { name: groupName, exact: true });
    const selected = group.locator("[aria-pressed=true]");
    const groupBox = (await group.boundingBox())!;
    const itemBox = (await selected.boundingBox())!;
    expect(itemBox.x).toBeGreaterThanOrEqual(groupBox.x - 1);
    expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(groupBox.x + groupBox.width + 1);
    expect(Math.abs(itemBox.y - groupBox.y)).toBeLessThanOrEqual(1);
    await expect(selected).toHaveCSS("border-bottom-width", "2px");
    await expect(selected).toHaveCSS("border-bottom-color", "rgb(243, 241, 236)");
  }
  await expect(settingsPopover(page).getByRole("region", { name: "지표 창", exact: true })).toBeInViewport();
});

test("800px에서 더 보기로 연 차트 설정 창도 화면 가운데에서 열린다", async ({ page }) => {
  await open(page, { width: 800, height: 900 });
  const more = toolbar(page).getByRole("button", { name: "더 보기", exact: true });
  await more.click();
  await page.getByRole("menuitem", { name: "차트 설정", exact: true }).click();
  await expect(settingsPopover(page)).toBeVisible();
  const popover = (await settingsPopover(page).boundingBox())!;
  expect(Math.abs(popover.x + popover.width / 2 - 800 / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(popover.y + popover.height / 2 - 900 / 2)).toBeLessThanOrEqual(2);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(async () => {
    const box = (await settingsPopover(page).boundingBox())!;
    return Math.abs(box.x + box.width / 2 - 900 / 2);
  }).toBeLessThanOrEqual(2);
});

test("봉 모양을 바꾸면 팝오버가 열린 채 차트에 바로 반영된다", async ({ page }) => {
  await open(page, { width: 1440, height: 900 });
  await expect.poll(() => mainSeriesTypes(page)).not.toContain("Line");
  await settingsButton(page).click();
  const style = settingsPopover(page).getByRole("group", { name: "봉 모양", exact: true });
  await style.getByRole("button", { name: "라인", exact: true }).click();
  await expect(settingsPopover(page)).toBeVisible();
  await expect(style.getByRole("button", { name: "라인", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => mainSeriesTypes(page)).toContain("Line");
  await style.getByRole("button", { name: "캔들", exact: true }).click();
  await expect(settingsPopover(page)).toBeVisible();
  await expect.poll(() => mainSeriesTypes(page)).not.toContain("Line");
});

test("1440px에서 저장된 선택이 없으면 지표 버튼이 차트 옆 지표 창을 열고 가운데 창을 고른 사용자는 가운데 창이 열린다", async ({ page, scenario }) => {
  expect(scenario.documents.uiState()).not.toHaveProperty("indicatorWindow");
  await open(page, { width: 1440, height: 900 });
  await indicatorButton(page).click();
  await expect(inspector(page)).toBeVisible();
  await expect(commandDialog(page)).toHaveCount(0);

  await settingsButton(page).click();
  const windows = settingsPopover(page).getByRole("group", { name: "지표 창", exact: true });
  await expect(windows.getByRole("button", { name: "차트 옆", exact: true })).toHaveAttribute("aria-pressed", "true");
  await windows.getByRole("button", { name: "가운데 창", exact: true }).click();
  await pollSaved(() => scenario.documents.uiState().indicatorWindow).toBe("dialog");
  await settingsPopover(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(settingsPopover(page)).toBeHidden();
  await indicatorButton(page).click();
  await expect(commandDialog(page)).toBeVisible();
});

test("가운데 지표 창은 폭이 760px 이하로 화면 가운데에 열리고 흐림 필터와 하단 적용 버튼이 없다", async ({ page, scenario }) => {
  saveIndicatorWindow(scenario, "dialog");
  await open(page, { width: 1440, height: 900 });
  await indicatorButton(page).click();
  const dialog = commandDialog(page);
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(760);
  expect(Math.abs(box.x + box.width / 2 - 1440 / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y + box.height / 2 - 900 / 2)).toBeLessThanOrEqual(2);
  expect(await dialog.evaluate((node) => getComputedStyle(node).backdropFilter)).toBe("none");
  await expect(dialog.locator("xpath=..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(dialog.getByRole("button", { name: "거래량 설정", exact: true })).toBeVisible();
  const footer = dialog.locator("footer");
  await expect(footer.getByText("Tab", { exact: true })).toBeVisible();
  await expect(footer.getByRole("button")).toHaveCount(0);
  await expect(dialog.getByRole("tab", { name: "비교 종목", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "입력창 닫기", exact: true }).click();
  await toolbar(page).getByRole("button", { name: "비교", exact: true }).click();
  const compareDialog = commandDialog(page);
  const compareFooter = compareDialog.locator("footer");
  await expect(compareFooter.getByText("Tab", { exact: true })).toHaveCount(0);
  await expect(compareFooter.getByRole("button")).toHaveCount(0);
});

test("범례에서 연 지표 팝오버는 높이가 360px 이하이고 색 더 보기를 누르면 색상표가 보인다", async ({ page, scenario }) => {
  saveIndicatorWindow(scenario, "dialog");
  seedMovingAverage(scenario);
  await open(page, { width: 1440, height: 900 });
  await expect(legendRow(page, "ma")).toContainText("이동평균");
  await legendRow(page, "ma").getByRole("button", { name: /설정 열기/ }).click();
  const popup = page.getByRole("dialog", { name: /이동평균.*설정/ });
  await expect(popup).toBeVisible();
  expect((await popup.boundingBox())!.height).toBeLessThanOrEqual(360);
  const palette = popup.getByRole("group", { name: "색상표", exact: true });
  await expect(palette).toHaveCount(0);
  await expect(popup.getByRole("group", { name: "테마 색", exact: true })).toBeVisible();
  await popup.getByRole("button", { name: "색 더 보기", exact: true }).click();
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("button")).toHaveCount(40);
  expect((await popup.boundingBox())!.height).toBeLessThanOrEqual(360);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await legendRow(page, "ma").getByRole("button", { name: /설정 열기/ }).click();
  await expect(page.getByRole("dialog", { name: /이동평균.*설정/ }).getByRole("group", { name: "색상표", exact: true })).toBeVisible();
});

test("지표와 드로잉에서 연 색 창의 제목이 같다", async ({ page, scenario }) => {
  saveIndicatorWindow(scenario, "dialog");
  await open(page, { width: 1440, height: 900 });
  await indicatorButton(page).click();
  const command = commandDialog(page);
  await command.getByRole("tab", { name: "지표 추가", exact: true }).click();
  await command.getByRole("button", { name: "선 색 및 굵기 설정", exact: true }).click();
  await expect(colorWindow(page)).toBeVisible();
  const indicatorTitle = await colorWindow(page).getByRole("heading").first().textContent();
  await page.keyboard.press("Escape");
  await expect(colorWindow(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(command).toHaveCount(0);

  const chart = (await chartOf(cell(page)).boundingBox())!;
  await cell(page).focus();
  await page.keyboard.press("T");
  await page.mouse.move(chart.x + chart.width * 0.76, chart.y + chart.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(chart.x + chart.width * 0.86, chart.y + chart.height * 0.25, { steps: 10 });
  await page.mouse.up();
  await page.getByRole("toolbar", { name: "드로잉 스타일" }).getByRole("button", { name: "선 색 선택", exact: true }).click();
  await expect(colorWindow(page)).toBeVisible();
  const drawingTitle = await colorWindow(page).getByRole("heading").first().textContent();
  expect(indicatorTitle).toBe("선 색");
  expect(drawingTitle).toBe(indicatorTitle);
  const topbar = (await toolbar(page).boundingBox())!;
  expect((await colorWindow(page).boundingBox())!.y).toBeGreaterThanOrEqual(topbar.y + topbar.height);
});

test.describe("차트 도구 후속", () => {
  test.use({ clockStart: "20261109100030" });

  const MOVING_AVERAGE = { id: "ma", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } } satisfies ChartSettings["indicators"][number];

  function seedFollowup(scenario: Scenario, over: Partial<ChartSettings>, period: "D" | "Y" = "D") {
    const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
    const chartSettings = { v: 2, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], ...over };
    scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period, chartSettings }) });
  }

  async function openFollowup(page: Page) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  }

  const rail = (page: Page) => page.getByRole("navigation", { name: "드로잉 도구", exact: true });

  async function holdAndReleaseOutside(page: Page, button: Locator, menu: Locator) {
    const box = await button.boundingBox();
    if (!box) throw new Error("누를 버튼이 없습니다");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(menu).toBeVisible();
    await page.mouse.move(box.x + box.width + 400, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  }

  test("길게 눌러 그룹 메뉴를 연 뒤 버튼 밖에서 놓아도 다음 키보드 활성화가 먹는다", async ({ page, scenario }) => {
    seedFollowup(scenario, {});
    await openFollowup(page);
    const group = rail(page).locator(".draw-group").filter({ has: page.getByRole("button", { name: "선 도구 펼치기", exact: true }) });
    const tool = group.locator("button[aria-haspopup=menu]").first();
    await expect(tool).toHaveAttribute("aria-pressed", "false");
    await holdAndReleaseOutside(page, tool, page.getByRole("menu", { name: "선 도구", exact: true }));
    await tool.focus();
    await page.keyboard.press("Enter");
    await expect(tool).toHaveAttribute("aria-pressed", "true");

    const magnet = rail(page).getByRole("button", { name: "자석", exact: true });
    const before = await magnet.getAttribute("aria-pressed");
    await holdAndReleaseOutside(page, magnet, page.getByRole("menu", { name: "자석 세기", exact: true }));
    await magnet.focus();
    await page.keyboard.press("Enter");
    await expect(magnet).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
  });

  financialTest("재무 상태 팝오버는 줄 표로 보이고 날짜는 YYYY-MM-DD HH:MM이다", async ({ page, scenario, financial }) => {
    seedFollowup(scenario, { indicators: [{ id: "revenue", spec: { kind: "revenue" }, panel: "revenue", visible: true, style: { colors: ["ind-2"], width: 1 } }], panels: [{ id: "revenue", stretch: 0.3 }] }, "Y");
    await openFollowup(page);
    const row = cell(page).locator('[data-indicator-row="revenue"]');
    await expect(row).toContainText("확인 완료");
    await row.locator("summary").click();
    await selectOption(row.getByRole("combobox", { name: "보고기간 자료" }), { index: 1 });
    const table = row.locator("details dl");
    await expect(table).toBeVisible();
    const lines = table.locator(":scope > div");
    await expect.poll(() => lines.count()).toBeGreaterThan(3);
    const cells = await lines.evaluateAll((divs) => divs.map((div) => ({ tags: Array.from(div.children).map((child) => child.tagName), name: div.querySelector("dt")?.textContent ?? "" })));
    for (const line of cells) {
      expect(line.tags).toEqual(["DT", "DD"]);
      expect(line.name.trim()).not.toBe("");
    }
    const report = financial.page("005930", "Y").series.find((series) => series.metric === "revenue")!.points[0]!;
    const input = report.inputs[0]!;
    const valueOf = (name: string) => lines.filter({ has: page.locator("dt").getByText(name, { exact: true }) }).locator("dd").first();
    await expect(valueOf("표시값")).toHaveText(report.value === null ? "—" : financialValue(report.value, "revenue", report.currency));
    await expect(valueOf("공시일")).toHaveText(input.disclosedAt ?? "미확인");
    await expect(valueOf("접수번호")).toHaveText(input.receipt ?? "미확인");
    await expect(valueOf("조회")).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    await expect(table).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    await expect(table).not.toContainText(/오전|오후/);
  });

  test("비교 종목 줄 버튼은 24px이다", async ({ page, scenario }) => {
    seedFollowup(scenario, { compare: ["006400"], indicators: [MOVING_AVERAGE] });
    await openFollowup(page);
    const compareRow = cell(page).locator('[data-compare-row="006400"]');
    const indicatorRow = cell(page).locator('[data-indicator-row="ma"]');
    await expect(compareRow).toBeVisible();
    await compareRow.hover();
    const buttons = compareRow.locator("button");
    await expect(buttons).not.toHaveCount(0);
    for (const box of await buttons.evaluateAll((all) => all.map((button) => button.getBoundingClientRect().toJSON() as DOMRect))) {
      expect(box.width).toBe(24);
      expect(box.height).toBe(24);
    }
    const indicatorButton = await indicatorRow.locator('button[data-indicator-command="edit"]').boundingBox();
    expect(indicatorButton?.width).toBe(24);
    const [compareHeight, indicatorHeight] = await Promise.all([compareRow.evaluate((el) => el.getBoundingClientRect().height), indicatorRow.evaluate((el) => el.getBoundingClientRect().height)]);
    expect(compareHeight).toBe(indicatorHeight);
  });

  test("축 방식 콤보는 일반·로그·%이고 단축키를 Kbd로 보인다", async ({ page, scenario }) => {
    seedFollowup(scenario, {});
    await openFollowup(page);
    await cell(page).getByRole("combobox", { name: "가격축 방식" }).click();
    const menu = page.getByRole("menu", { name: "가격축 방식", exact: true });
    const options = menu.getByRole("menuitemradio");
    await expect(options).toHaveCount(3);
    const shown = await options.evaluateAll((items) => items.map((item) => {
      const spans = Array.from(item.querySelectorAll(":scope > span"));
      const kbd = item.querySelector(":scope > kbd");
      return { label: spans[1]?.querySelector("span")?.textContent ?? "", hint: spans.at(-1)?.textContent ?? "", kbd: kbd?.textContent ?? null, kbdLast: item.lastElementChild === kbd };
    }));
    expect(shown.map((option) => option.label)).toEqual(["일반", "로그", "%"]);
    const log = shown[1]!;
    expect(log.kbd).toBe("L");
    expect(log.kbdLast).toBe(true);
    for (const option of shown) {
      expect(option.hint).not.toBe("");
      if (option.kbd) expect(option.hint).not.toContain(option.kbd);
    }
  });
});
