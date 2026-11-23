import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { cell, DEFAULT_LAYOUT_ID, expect, type Scenario, test } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 860 } });

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const menu = (page: Page) => page.getByRole("menu", { name: "창 배치" });
const sideways = (page: Page) => page.getByRole("separator", { name: "좌우 창 경계" }).first();
const junction = (page: Page) => page.locator("[data-dock-junction]");
const stage = (page: Page) => page.locator("[data-canvas-stage]");
const header = (page: Page, id: string) => page.locator(`[data-window-header="${id}"]`);

async function grabPoint(locator: Locator, fromLeft?: number) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return { x: box.x + (fromLeft === undefined ? box.width / 2 : Math.min(fromLeft, box.width / 2)), y: box.y + box.height / 2 };
}

async function pressAndMove(page: Page, target: Locator, dx: number, dy: number, fromLeft?: number) {
  const at = await grabPoint(target, fromLeft);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + dx, at.y + dy, { steps: 8 });
}

const loseCapture = (target: Locator) => target.evaluate((element) => {
  window.addEventListener("lostpointercapture", (event) => event.stopImmediatePropagation(), true);
  element.releasePointerCapture(1);
});

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

function seedCanvas(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "cell-1", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "watchlist", link: null, kind: "watchlist" },
  ];
  const canvas = { rects: { "cell-0": { x: .04, y: .04, w: .45, h: .54 }, "cell-1": { x: .22, y: .18, w: .45, h: .54 }, watchlist: { x: .72, y: .02, w: .25, h: .5 } }, order: ["cell-0", "watchlist", "cell-1"] };
  scenario.documents.saveLayout({ ...layout, windows, placement: { v: 1, dock: null, canvas }, revision: layout.revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "canvas" });
}

test.describe("잡기를 잃으면 다음 포인터 이벤트 없이도 끌기를 끝낸다", () => {
  test("창 경계", async ({ page }) => {
    await open(page);
    const handle = sideways(page);
    await pressAndMove(page, handle, 40, 0);
    await expect(handle).toHaveAttribute("data-dragging", "");
    await loseCapture(handle);
    await expect(handle).not.toHaveAttribute("data-dragging");
    await page.mouse.up();
  });

  test("교차점 손잡이", async ({ page }) => {
    await open(page);
    await tab(page, "스크리너").press("Shift+F10");
    await menu(page).getByRole("menuitem", { name: "코스피 일", exact: true }).click();
    await tab(page, "스크리너").press("Shift+F10");
    await menu(page).getByRole("menuitem", { name: "아래에 나눠 놓기", exact: true }).click();
    await expect(page.locator("[data-dock-group]")).toHaveCount(3);
    await pressAndMove(page, junction(page), -30, -30);
    await expect(junction(page)).toHaveAttribute("data-dragging", "");
    await loseCapture(junction(page));
    await expect(junction(page)).not.toHaveAttribute("data-dragging");
    await page.mouse.up();
  });

  test("캔버스 창 머리", async ({ page, scenario }) => {
    seedCanvas(scenario);
    await page.goto("/");
    await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
    await pressAndMove(page, header(page, "cell-1"), 100, 80, 60);
    await expect(stage(page)).toHaveAttribute("data-canvas-dragging", "");
    await loseCapture(header(page, "cell-1"));
    await expect(stage(page)).not.toHaveAttribute("data-canvas-dragging");
    await page.mouse.up();
  });
});
