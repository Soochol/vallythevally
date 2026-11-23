import type { Locator, Page } from "@playwright/test";
import type { ChartSettings } from "../src/chart/settings";
import { financialTest } from "./financial-update-helpers";
import { selectOption } from "./select-option";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, test, withFirstChart } from "./harness";

test.use({ clockStart: "20261109100030" });

const MOVING_AVERAGE = { id: "ma", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } } satisfies ChartSettings["indicators"][number];

function seed(scenario: Scenario, over: Partial<ChartSettings>, period: "D" | "Y" = "D") {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings = { v: 2, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], ...over };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period, chartSettings }) });
}

async function open(page: Page) {
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
  seed(scenario, {});
  await open(page);
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

financialTest("재무 상태 팝오버는 줄 표로 보이고 날짜는 YYYY-MM-DD HH:MM이다", async ({ page, scenario }) => {
  seed(scenario, { indicators: [{ id: "revenue", spec: { kind: "revenue" }, panel: "revenue", visible: true, style: { colors: ["ind-2"], width: 1 } }], panels: [{ id: "revenue", stretch: 0.3 }] }, "Y");
  await open(page);
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
  await expect(table).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  await expect(table).not.toContainText(/오전|오후/);
});

test("비교 종목 줄 버튼은 24px이다", async ({ page, scenario }) => {
  seed(scenario, { compare: ["006400"], indicators: [MOVING_AVERAGE] });
  await open(page);
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
  seed(scenario, {});
  await open(page);
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
