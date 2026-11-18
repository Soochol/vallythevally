import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Period } from "../src/api/generated/Period";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, pollSaved, test } from "./harness";
import { chartPoint, drawingDock, settledMirror } from "./drawing-probe";

test.use({ clockStart: "20261109100000" });

const DAY = 86400;
const LAST = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 50 };
const bar = (t: number, i: number): Bar => ({ t, o: 50000 + i * 20, h: 50100 + i * 20, l: 49900 + i * 20, c: 50050 + i * 20, v: 1000 + i });
const daily = Array.from({ length: 80 }, (_, i) => bar(LAST - (79 - i) * DAY, i));

function seedCharts(scenario: Scenario, first: Period = "D", second: Period = "W") {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: first, chartSettings: SETTINGS },
    { id: "cell-1", link: "b", kind: "chart", symbol: "005930", venue: "combined", period: second, chartSettings: SETTINGS },
  ];
  const root = {
    kind: "split", dir: "row", ratio: 0.5,
    first: { kind: "group", id: "g1", tabs: ["cell-0"], active: "cell-0" },
    second: { kind: "group", id: "g2", tabs: ["cell-1"], active: "cell-1" },
  };
  scenario.documents.saveLayout({ ...layout, windows, placement: { v: 1, dock: { root, floats: [] }, canvas: null }, revision: layout.revision + 1 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.route("**/api/bars?**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { symbol: query.get("symbol"), venue: query.get("venue"), period: query.get("period"), bars: daily, current: null, nextBefore: null, seq: null } });
  });
});

async function ready(page: Page, scenario: Scenario) {
  seedCharts(scenario);
  await page.goto("/");
  for (const n of [1, 2]) {
    await expect(cell(page, n)).toHaveAttribute("aria-busy", "false");
    await expect(chartOf(cell(page, n))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  }
}

const rail = drawingDock;
const workspace = (page: Page) => page.getByRole("main", { name: "작업 영역" });
const placed = async (page: Page) => { const box = (await rail(page).boundingBox())!; return `${box.x},${box.y},${box.width},${box.height}`; };

test("막대는 칸 밖 작업 영역 왼쪽에 하나뿐이고 포인터 없이도 도구가 보인다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await expect(page.getByRole("navigation", { name: "드로잉 도구", exact: true })).toHaveCount(1);
  for (const n of [1, 2]) await expect(page.locator("section").filter({ has: cell(page, n) }).getByRole("navigation", { name: "드로잉 도구" })).toHaveCount(0);
  await expect(workspace(page).getByRole("navigation", { name: "드로잉 도구" })).toHaveCount(0);
  await page.mouse.move(800, 5);
  await expect(rail(page).getByRole("button", { name: "추세선", exact: true })).toBeVisible();
  const bar = (await rail(page).boundingBox())!;
  const area = (await workspace(page).boundingBox())!;
  expect(bar.x).toBeLessThan(area.x);
  expect(bar.x + bar.width).toBeLessThanOrEqual(area.x);
});

test("칸 2에서 막대로 고른 추세선은 칸 2에 그려지고 막대 자리는 활성 칸과 상관없다", async ({ page, scenario }) => {
  await ready(page, scenario);
  const first = await placed(page);
  const spot = await chartPoint(page, 0.5, 0.5, 2);
  await page.mouse.click(spot.x, spot.y);
  await rail(page).getByRole("button", { name: "추세선", exact: true }).click();
  await expect(rail(page).getByRole("button", { name: "추세선", exact: true })).toHaveAttribute("aria-pressed", "true");
  const a = await chartPoint(page, 0.3, 0.7, 2); const b = await chartPoint(page, 0.6, 0.4, 2);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await settledMirror(page, 2)).map((m) => m.tool)).toEqual(["trendline"]);
  expect(await placed(page)).toBe(first);
  const other = await chartPoint(page, 0.5, 0.5, 1);
  await page.mouse.click(other.x, other.y);
  await expect(cell(page, 1)).toBeVisible();
  expect(await placed(page)).toBe(first);
});

test("묶음 메뉴는 막대 오른쪽으로 열리고 고른 도구가 막대에서 눌린 상태가 된다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await rail(page).getByRole("button", { name: "선 도구 펼치기", exact: true }).click();
  const menu = page.getByRole("menu", { name: "선 도구" });
  await expect(menu).toBeVisible();
  const bar = (await rail(page).boundingBox())!;
  const opened = (await menu.boundingBox())!;
  expect(opened.x).toBeGreaterThanOrEqual(bar.x + bar.width);
  await menu.getByRole("menuitem").getByText("수평선", { exact: true }).click();
  await expect(rail(page).getByRole("button", { name: "수평선", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("숨기면 보이기 손잡이만 남고 작업 영역이 넓어지며 새로고침 뒤에도 남는다", async ({ page, scenario }) => {
  await ready(page, scenario);
  const narrow = (await workspace(page).boundingBox())!.width;
  await rail(page).getByRole("button", { name: "드로잉 도구 막대 숨기기", exact: true }).click();
  await expect(rail(page).getByRole("button", { name: "추세선", exact: true })).toHaveCount(0);
  await expect(rail(page).getByRole("button", { name: "드로잉 도구 막대 보이기", exact: true })).toBeVisible();
  await expect.poll(async () => (await workspace(page).boundingBox())!.width).toBeGreaterThan(narrow);
  await pollSaved(() => (scenario.documents.uiState().drawing as { toolbarHidden?: boolean } | undefined)?.toolbarHidden).toBe(true);
  await page.reload();
  await expect(rail(page).getByRole("button", { name: "드로잉 도구 막대 보이기", exact: true })).toBeVisible();
  await expect(rail(page).getByRole("button", { name: "추세선", exact: true })).toHaveCount(0);
  await rail(page).getByRole("button", { name: "드로잉 도구 막대 보이기", exact: true }).click();
  await expect(rail(page).getByRole("button", { name: "추세선", exact: true })).toBeVisible();
  await expect.poll(async () => (await workspace(page).boundingBox())!.width).toBe(narrow);
});

test("옛 설정의 dockAt이 있어도 막대가 보이고 오류가 없다", async ({ page, scenario }) => {
  seedCharts(scenario);
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, drawing: { ...scenario.documents.uiPrefs().drawing, dockAt: { x: 0.8, y: 0.8 } }, revision: state.revision + 1 } as typeof state);
  await page.goto("/");
  await expect(rail(page).getByRole("button", { name: "추세선", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".ui-toast")).toHaveCount(0);
});

test("보이는 차트 창이 없는 레이아웃에는 막대가 없고 차트 탭을 보면 나타난다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart: LayoutWindow = { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS };
  const watchlist = layout.windows.find((w) => w.kind === "watchlist")!;
  const root = { kind: "group", id: "g1", tabs: ["watchlist", "cell-0"], active: "watchlist" };
  scenario.documents.saveLayout({ ...layout, windows: [chart, watchlist], placement: { v: 1, dock: { root, floats: [] }, canvas: null }, revision: layout.revision + 1 });
  await page.goto("/");
  await expect(workspace(page)).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  await page.getByRole("tab", { name: /^삼성전자|^칸 1/ }).first().click();
  await expect(rail(page).getByRole("button", { name: "추세선", exact: true })).toBeVisible();
});

test("휴대폰 폭에는 막대가 없다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "드로잉 도구" })).toHaveCount(0);
});
