import type { Locator, Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { parseChartSettings } from "../src/chart/settings";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, firstChart, pollSaved, test, withFirstChart, type Scenario } from "./harness";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const groups = (page: Page) => page.locator("[data-dock-group]");
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const rightPanel = (page: Page) => page.getByRole("complementary", { name: "차트 설정 패널", exact: true });
const settings = (scenario: Scenario) => parseChartSettings(firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings);

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소입니다");
  return box;
}

function seed(scenario: Scenario, indicators: object[]) {
  const current: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const { id, name, sync, placement, revision } = current;
  const chartSettings = { v: 2, style: "candle", scale: "normal", indicators, compare: [], panels: [] };
  scenario.documents.saveLayout({ id, name, sync, placement, revision: revision + 1, windows: withFirstChart(current, { symbol: "005930", venue: "combined", period: "D", chartSettings }) });
}

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("모든 창 헤더의 '+' 버튼은 탭 목록 바로 우측에 있고, 차트창 우측 상단에만 차트 설정 톱니 버튼이 있다", async ({ page }) => {
  await open(page);
  await expect(groups(page)).toHaveCount(2);

  const chartGroup = groups(page).first();
  const sideGroup = groups(page).last();

  for (const group of [chartGroup, sideGroup]) {
    const row = await boxOf(group.locator(".dock-tabs"));
    const lastTab = await boxOf(group.locator(".dock-tab-group").last());
    const add = await boxOf(group.locator(".dock-add"));
    expect(add.x).toBeGreaterThanOrEqual(lastTab.x + lastTab.width - 1);
    expect(add.x - (lastTab.x + lastTab.width)).toBeLessThanOrEqual(16);
    expect(add.x + add.width).toBeLessThan(row.x + row.width - 24);
  }

  const gear = chartGroup.getByRole("button", { name: "차트 설정 패널", exact: true });
  await expect(gear).toBeVisible();
  const chartRow = await boxOf(chartGroup.locator(".dock-tabs"));
  const gearBox = await boxOf(gear);
  expect(chartRow.x + chartRow.width - (gearBox.x + gearBox.width)).toBeLessThanOrEqual(16);

  await expect(sideGroup.getByRole("button", { name: "차트 설정 패널", exact: true })).toHaveCount(0);
  await expect(cell(page).locator("[data-chart-settings-open]")).toHaveCount(0);
});

test("좁은 폭에서 탭이 넘쳐도 '+'는 탭 목록 우측에 고정되고 탭 목록과 톱니 버튼이 겹치지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 760 });
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const chartGroup = groups(page).first();
  const add = chartGroup.getByRole("button", { name: "이 묶음에 창 더하기", exact: true });
  for (let i = 0; i < 5; i++) {
    await add.click();
    await page.getByRole("menu", { name: "창 더하기", exact: true }).getByRole("menuitem", { name: /^차트/ }).click();
  }
  await chartGroup.getByRole("tab", { name: /^삼성전자/ }).first().click();

  const tabList = chartGroup.locator(".dock-tab-list");
  await expect(tabList).toBeVisible();

  const row = await boxOf(chartGroup.locator(".dock-tabs"));
  const viewport = await boxOf(chartGroup.locator(".dock-tab-viewport"));
  const addBox = await boxOf(add);
  const listBox = await boxOf(tabList);
  const gearBox = await boxOf(chartGroup.getByRole("button", { name: "차트 설정 패널", exact: true }));

  expect(addBox.x).toBeGreaterThanOrEqual(viewport.x + viewport.width - 1);
  expect(addBox.x + addBox.width).toBeLessThanOrEqual(listBox.x + 1);
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(gearBox.x + 1);
  expect(gearBox.x + gearBox.width).toBeLessThanOrEqual(row.x + row.width + 1);
});

test("차트 설정 톱니 버튼은 300px 고정 도킹 패널을 지표 탭으로 열고, 차트 캔버스를 옆으로 밀어 가격축을 가리지 않는다", async ({ page, scenario }) => {
  seed(scenario, [{ id: "m20", spec: { kind: "ma", method: "sma", period: 20 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } }]);
  await open(page);

  const chartGroup = groups(page).first();
  const gear = chartGroup.getByRole("button", { name: "차트 설정 패널", exact: true });
  const chartBefore = await boxOf(chartOf(cell(page)));

  await gear.click();
  await expect(gear).toHaveAttribute("aria-pressed", "true");
  await expect(rightPanel(page)).toBeVisible();
  await expect(rightPanel(page)).not.toHaveAttribute("data-overlay", "true");
  await expect(rightPanel(page).getByRole("tab", { name: /^지표/ })).toHaveAttribute("aria-selected", "true");

  const panelBox = await boxOf(rightPanel(page));
  const chartAfter = await boxOf(chartOf(cell(page)));
  expect(Math.round(panelBox.width)).toBe(300);
  expect(chartAfter.x + chartAfter.width).toBeLessThanOrEqual(panelBox.x + 1);
  expect(Math.round(chartBefore.width - chartAfter.width)).toBe(300);

  const search = rightPanel(page).getByRole("combobox", { name: "지표·비교 찾기" });
  await search.fill("이평 60");
  await search.press("Enter");
  await pollSaved(() => settings(scenario).indicators.map((i) => i.spec)).toEqual([
    { kind: "ma", method: "sma", period: 20 },
    { kind: "ma", method: "sma", period: 60 },
  ]);

  await rightPanel(page).getByRole("tab", { name: "차트 설정", exact: true }).click();
  await expect(rightPanel(page).getByRole("tab", { name: "봉 · 선", exact: true })).toBeVisible();
  await expect(rightPanel(page).getByRole("tab", { name: "축 · 눈금", exact: true })).toBeVisible();
  await expect(rightPanel(page).getByRole("tab", { name: "시간", exact: true })).toBeVisible();

  await rightPanel(page).getByRole("tab", { name: "축 · 눈금", exact: true }).click();
  await rightPanel(page).getByRole("group", { name: "가격 축" }).getByRole("button", { name: "로그", exact: true }).click();
  await pollSaved(() => settings(scenario).scale).toBe("log");
  await expect(gear).toHaveAttribute("data-modified", "true");

  await rightPanel(page).getByRole("tab", { name: "시간", exact: true }).click();
  await rightPanel(page).getByRole("group", { name: "화면에 보이는 봉" }).getByRole("button", { name: "120", exact: true }).click();
  await pollSaved(() => settings(scenario).visibleBars).toBe(120);
});

test("범례 1줄 조작 말풍선과 우측 패널이 공존하고 Esc는 말풍선 다음 우측 패널 순으로 닫으며 바꾼 값을 유지한다", async ({ page, scenario }) => {
  seed(scenario, [{ id: "m20", spec: { kind: "ma", method: "sma", period: 20 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } }]);
  await open(page);

  const gear = groups(page).first().getByRole("button", { name: "차트 설정 패널", exact: true });
  await gear.click();
  await expect(rightPanel(page)).toBeVisible();

  await cell(page).locator('[data-indicator-row="m20"] [data-indicator-token]').click();
  const bubble = page.getByRole("dialog", { name: "이동평균 단순 20 설정", exact: true });
  await expect(bubble).toBeVisible();
  await expect(rightPanel(page)).toBeVisible();

  await bubble.getByRole("group", { name: "자주 쓰는 기간" }).getByRole("button", { name: "60", exact: true }).click();
  await pollSaved(() => settings(scenario).indicators[0]?.spec).toEqual({ kind: "ma", method: "sma", period: 60 });

  await page.keyboard.press("Escape");
  await expect(bubble).toBeHidden();
  await expect(rightPanel(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(rightPanel(page)).toBeHidden();
  await expect(gear).toHaveAttribute("aria-pressed", "false");
  expect(settings(scenario).indicators[0]?.spec).toEqual({ kind: "ma", method: "sma", period: 60 });
});

test("우측 패널이 열려 있으면 위 막대 지표·차트와 범례 +지표가 패널 탭을 전환하고, 좁은 칸에서는 --raised 오버레이로 열린다", async ({ page, scenario }) => {
  seed(scenario, [{ id: "m20", spec: { kind: "ma", method: "sma", period: 20 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } }]);
  await open(page);

  await groups(page).first().getByRole("button", { name: "차트 설정 패널", exact: true }).click();
  await expect(rightPanel(page)).toBeVisible();

  await toolbar(page).getByRole("button", { name: "차트 설정", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "차트 설정", exact: true })).toHaveCount(0);
  await expect(rightPanel(page).getByRole("tab", { name: "차트 설정", exact: true })).toHaveAttribute("aria-selected", "true");

  await cell(page).locator("[data-indicator-add]").click();
  await expect(page.getByRole("dialog", { name: "지표 더하기", exact: true })).toHaveCount(0);
  await expect(rightPanel(page).getByRole("tab", { name: /^지표/ })).toHaveAttribute("aria-selected", "true");

  await page.setViewportSize({ width: 820, height: 760 });
  await expect(rightPanel(page)).toHaveAttribute("data-overlay", "true");
  const matchesRaised = await rightPanel(page).evaluate((el) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--raised)";
    document.body.append(probe);
    const raised = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return getComputedStyle(el).backgroundColor === raised;
  });
  expect(matchesRaised).toBe(true);
});
