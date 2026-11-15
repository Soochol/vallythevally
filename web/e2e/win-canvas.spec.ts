import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { windowId } from "../src/layout/kinds";
import { parsePlacement } from "../src/layout/placement";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, type Scenario, test } from "./harness";

test.use({ clockStart: "20261109100000" });
const SCREENS = path.resolve("../target/ux-screens");
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const stage = (page: Page) => page.locator("[data-canvas-stage]");
const frame = (page: Page, id: string) => page.locator(`[data-canvas-window="${id}"]`);
const header = (page: Page, id: string) => page.locator(`[data-window-header="${id}"]`);
const saved = (scenario: Scenario) => parsePlacement(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement);
const tidy = (page: Page) => page.getByRole("button", { name: /^가지런히/ });

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 창의 자리를 찾았습니다");
  return box;
}

async function screenshot(page: Page, name: string) {
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, `win-canvas-${name}.png`) });
}

async function mode(page: Page, next: "도킹" | "캔버스", keyboard = false) {
  await page.getByRole("button", { name: /^레이아웃:/ }).click();
  const button = page.getByRole("group", { name: "창 배치 방식" }).getByRole("button", { name: next, exact: true });
  await expect(button).toBeVisible();
  if (keyboard) { await page.keyboard.press("End"); await page.keyboard.press("Tab"); if (next === "캔버스") await page.keyboard.press("Tab"); await expect(button).toBeFocused(); await page.keyboard.press("Enter"); }
  else await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
}

async function drag(page: Page, target: Locator, dx: number, dy: number, drop = true) {
  const box = await boxOf(target);
  const x = box.x + Math.min(60, box.width / 2), y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  if (drop) await page.mouse.up();
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
  const ui = { ...scenario.documents.uiState(), layoutMode: "canvas" };
  scenario.documents.saveUiState(ui);
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }); });

test("실제 도킹 자리를 보존해 전환하고 차트 인스턴스와 두 배치를 새로고침 뒤에도 유지한다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const dockBoxes = await page.locator("[data-dock-group]").all();
  const before = await Promise.all(dockBoxes.map(boxOf));
  const dock = saved(scenario).dock;
  await chartOf(cell(page)).evaluate((el) => el.setAttribute("data-retained-probe", "same-chart"));
  const barsRequests = () => scenario.requests.filter((request) => new URL(request.url()).pathname === "/api/bars").length;
  const requests = barsRequests();
  await mode(page, "캔버스", true);
  await expect(frame(page, "cell-0")).toBeVisible();
  await screenshot(page, "initial");
  for (const [i, id] of ["cell-0", "watchlist"].entries()) {
    const after = await boxOf(frame(page, id));
    for (const axis of ["x", "y", "width", "height"] as const) expect(Math.abs(after[axis] - before[i]![axis])).toBeLessThanOrEqual(1);
  }
  await expect(chartOf(cell(page))).toHaveAttribute("data-retained-probe", "same-chart");
  expect(barsRequests()).toBe(requests);
  const lane = await boxOf(page.getByRole("navigation", { name: "창 종류" }));
  const area = await boxOf(stage(page));
  expect(lane.y).toBeGreaterThanOrEqual(area.y + area.height);
  await expect.poll(() => scenario.documents.uiPrefs().layoutMode).toBe("canvas");
  await drag(page, header(page, "cell-0"), 100, 50);
  await drag(page, frame(page, "cell-0").locator('[data-resize-handle="ne"]'), -80, 40);
  const moved = await boxOf(frame(page, "cell-0"));
  await expect.poll(() => saved(scenario).canvas?.rects[windowId("cell-0")]?.x).toBeGreaterThan(0);
  const canvas = saved(scenario).canvas;
  await mode(page, "도킹");
  await expect(page.locator("[data-dock-group]")).toHaveCount(2);
  if (dock) expect(saved(scenario).dock).toEqual(dock);
  expect(await Promise.all((await page.locator("[data-dock-group]").all()).map(boxOf))).toEqual(before);
  await expect(chartOf(cell(page))).toHaveAttribute("data-retained-probe", "same-chart");
  await mode(page, "캔버스");
  expect(await boxOf(frame(page, "cell-0"))).toEqual(moved);
  expect(saved(scenario).canvas).toEqual(canvas);
  await page.reload();
  await expect(frame(page, "cell-0")).toBeVisible();
  expect(await boxOf(frame(page, "cell-0"))).toEqual(moved);
});

test("두 차트의 저장되지 않은 기본 도킹은 첫 캔버스 왕복 뒤에도 같은 순서와 자리다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const first = layout.windows.find((window) => window.kind === "chart")!;
  scenario.documents.saveLayout({ ...layout, windows: [first, { ...first, id: "cell-1" }, ...layout.windows.filter((window) => window.kind !== "chart")], placement: { v: 1, dock: null, canvas: null }, revision: layout.revision + 1 });
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  const before = await Promise.all([boxOf(cell(page)), boxOf(cell(page, 2))]);
  expect(before[0]!.y).toBeLessThan(before[1]!.y);
  expect(saved(scenario)).toEqual({ v: 1, dock: null, canvas: null });
  await mode(page, "캔버스");
  await expect(frame(page, "cell-1")).toBeVisible();
  await expect.poll(() => saved(scenario).dock).not.toBeNull();
  await mode(page, "도킹");
  expect(await Promise.all([boxOf(cell(page)), boxOf(cell(page, 2))])).toEqual(before);
});

test("포털 안의 차트와 관심종목 내용을 실제로 누르면 그 창이 앞으로 온다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  await chart.evaluate((element) => element.setAttribute("data-retained-probe", "body-activation"));
  const body = await boxOf(chart);
  await page.mouse.click(body.x + 35, body.y + 60);
  await expect(frame(page, "cell-0")).toHaveCSS("z-index", "3");
  await expect(frame(page, "cell-0")).toHaveAttribute("data-active-cell", "");
  await expect(chart).toHaveAttribute("data-retained-probe", "body-activation");
  await frame(page, "watchlist").locator(".dock-window-host").click({ position: { x: 30, y: 80 } });
  await expect(frame(page, "watchlist")).toHaveCSS("z-index", "3");
  await expect(frame(page, "cell-0")).toHaveCSS("z-index", "2");
  await expect(frame(page, "cell-0")).toHaveAttribute("data-active-cell", "");
});

test("활성 차트를 닫은 알림의 되돌리기 한 번은 남은 차트가 다른 창 뒤에 있어도 원래 창과 자리를 돌린다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await header(page, "cell-1").click({ position: { x: 60, y: 17 } });
  await expect(frame(page, "cell-1")).toHaveAttribute("data-active-cell", "");
  const before = saved(scenario).canvas;
  const closing = await boxOf(frame(page, "cell-1"));
  await frame(page, "cell-1").getByRole("button", { name: "차트 닫기" }).click();
  await expect(frame(page, "cell-1")).toHaveCount(0);
  await expect(frame(page, "cell-0")).toHaveAttribute("data-active-cell", "");
  await expect(frame(page, "cell-0")).toHaveCSS("z-index", "2");
  await page.getByRole("status").filter({ hasText: "차트 창을 닫았습니다" }).getByRole("button", { name: "되돌리기" }).click();
  await expect(frame(page, "cell-1")).toHaveCount(1);
  expect(await boxOf(frame(page, "cell-1"))).toEqual(closing);
  await expect.poll(() => saved(scenario).canvas).toEqual(before);
});

test("크게 본 차트 위에서도 창 종류와 위 막대가 기존 관심종목을 드러낸다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  const before = saved(scenario).canvas!.rects;
  const original = await boxOf(frame(page, "cell-1"));
  for (const source of ["kind", "topbar"]) {
    await frame(page, "cell-1").getByRole("button", { name: "차트 크게 보기" }).click();
    await expect(frame(page, "cell-1")).toHaveAttribute("data-maximized", "");
    if (source === "kind") await page.getByRole("navigation", { name: "창 종류" }).getByRole("button", { name: "관심종목 창 더하기" }).click();
    else {
      await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" }).click();
      await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^관심종목/ }).click();
    }
    await expect(frame(page, "cell-1")).not.toHaveAttribute("data-maximized");
    expect(await boxOf(frame(page, "cell-1"))).toEqual(original);
    const requested = await boxOf(header(page, "watchlist"));
    await expect.poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-canvas-window]")?.getAttribute("data-canvas-window"), { x: requested.x + 60, y: requested.y + 17 })).toBe("watchlist");
    expect(saved(scenario).canvas!.rects).toEqual(before);
  }
});

test("뒤 차트를 Enter로 크게 보면 활성 칸과 도구 막대도 따라가고 다음 창 요청이 크게 보기를 끝낸다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await header(page, "cell-1").click({ position: { x: 60, y: 17 } });
  await expect(frame(page, "cell-1")).toHaveAttribute("data-active-cell", "");
  const before = saved(scenario).canvas!.rects;
  await header(page, "cell-0").focus();
  await page.keyboard.press("Enter");
  await expect(frame(page, "cell-0")).toHaveAttribute("data-maximized", "");
  await expect(frame(page, "cell-0")).toHaveAttribute("data-active-cell", "");
  await expect(frame(page, "cell-0").getByRole("navigation", { name: "드로잉 도구" })).toBeVisible();
  await page.getByRole("group", { name: "봉 주기", exact: true }).getByRole("button", { name: "주", exact: true }).click();
  await expect.poll(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((window) => window.id === "cell-0")).toMatchObject({ period: "W" });
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((window) => window.id === "cell-1")).toMatchObject({ period: "D" });
  await expect(frame(page, "cell-0")).toHaveAttribute("data-maximized", "");
  expect(saved(scenario).canvas!.rects).toEqual(before);
  await page.getByRole("navigation", { name: "창 종류" }).getByRole("button", { name: "관심종목 창 더하기" }).click();
  await expect(frame(page, "cell-0")).not.toHaveAttribute("data-maximized");
  await expect(frame(page, "watchlist")).toHaveCSS("z-index", "3");
});

test("실제 머리 끌기는 안내선으로 가장자리에 붙고 크기 조작은 최소 크기에서 멈춰 한 번 저장한다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  const first = await boxOf(frame(page, "cell-0"));
  const second = await boxOf(frame(page, "cell-1"));
  const before = saved(scenario).canvas;
  await drag(page, header(page, "cell-1"), first.x - second.x + 5, 30, false);
  await expect(page.locator('[data-canvas-guide="x"]')).toBeVisible();
  expect(saved(scenario).canvas).toEqual(before);
  await screenshot(page, "guides");
  await page.mouse.up();
  expect(Math.abs((await boxOf(frame(page, "cell-1"))).x - first.x)).toBeLessThanOrEqual(1);
  await expect.poll(() => saved(scenario).canvas).not.toEqual(before);
  await page.getByRole("button", { name: /^레이아웃:/ }).click();
  await page.getByRole("menuitem", { name: "배치 되돌리기" }).click();
  expect(await boxOf(frame(page, "cell-1"))).toEqual(second);
  await drag(page, header(page, "cell-1"), first.x - second.x + 5, 30);
  const handle = frame(page, "cell-1").locator('[data-resize-handle="se"]');
  const corner = await boxOf(handle);
  const previous = await boxOf(frame(page, "cell-1"));
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x - 800, corner.y - 800, { steps: 8 });
  await page.mouse.up();
  const minimum = await boxOf(frame(page, "cell-1"));
  expect(minimum.width).toBe(280);
  expect(minimum.height).toBe(194);
  expect(minimum.width).toBeLessThan(previous.width);
  await expect(page.getByRole("status").filter({ hasText: "차트 창은 280×194" })).toBeVisible();
  const east = await boxOf(frame(page, "cell-1").locator('[data-resize-handle="e"]'));
  await page.mouse.move(east.x + east.width / 2, east.y + east.height / 2);
  await page.mouse.down();
  await page.mouse.move(east.x + 70, east.y + east.height / 2, { steps: 6 });
  await page.mouse.up();
  expect((await boxOf(frame(page, "cell-1"))).width).toBeGreaterThan(340);
  await page.getByRole("button", { name: "레이아웃: 기본" }).click();
  await page.getByRole("menuitem", { name: "배치 되돌리기" }).click();
  expect(await boxOf(frame(page, "cell-1"))).toEqual(minimum);
});

test("겹친 창을 누르면 앞으로 오고 가지런히·기본 배치·크게 보기와 닫기 되돌리기가 작동한다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect(tidy(page).getByLabel("겹친 곳")).toHaveText("1");
  await screenshot(page, "overlap");
  await header(page, "cell-0").click({ position: { x: 60, y: 17 } });
  expect(Number(await frame(page, "cell-0").evaluate((el) => el.style.zIndex))).toBeGreaterThan(Number(await frame(page, "cell-1").evaluate((el) => el.style.zIndex)));
  await expect(frame(page, "cell-0")).toHaveAttribute("data-active-cell", "");
  const original = await boxOf(frame(page, "cell-0"));
  const originalPlacement = saved(scenario).canvas;
  await header(page, "cell-0").dblclick({ position: { x: 60, y: 17 } });
  expect(await boxOf(frame(page, "cell-0"))).toEqual(await boxOf(stage(page)));
  expect(saved(scenario).canvas).toEqual(originalPlacement);
  await cell(page).focus();
  await page.keyboard.press("Escape");
  expect(await boxOf(frame(page, "cell-0"))).toEqual(original);
  await frame(page, "cell-0").getByRole("button", { name: "차트 크게 보기" }).click();
  await expect(frame(page, "cell-0")).toHaveAttribute("data-maximized", "");
  await cell(page).focus();
  await frame(page, "cell-0").getByRole("navigation", { name: "드로잉 도구" }).getByRole("button", { name: "드로잉 단축키 도움말" }).click();
  await expect(page.getByRole("dialog", { name: "드로잉 단축키" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "드로잉 단축키" })).toHaveCount(0);
  await expect(frame(page, "cell-0")).toHaveAttribute("data-maximized", "");
  await cell(page).focus();
  await page.keyboard.press("Escape");
  await expect(frame(page, "cell-0")).not.toHaveAttribute("data-maximized");
  await frame(page, "cell-0").getByRole("button", { name: "차트 크게 보기" }).click();
  await frame(page, "cell-0").getByRole("button", { name: "차트 원래 크기로" }).click();
  expect(await boxOf(frame(page, "cell-0"))).toEqual(original);
  await tidy(page).click();
  await expect(tidy(page).getByLabel("겹친 곳")).toHaveText("0");
  const area = await boxOf(stage(page));
  for (const item of await page.locator("[data-canvas-window]").all()) {
    const box = await boxOf(item);
    expect(box.x).toBeGreaterThanOrEqual(area.x);
    expect(box.y).toBeGreaterThanOrEqual(area.y);
    expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height + 1);
  }
  await screenshot(page, "tidied");
  const closeRect = await boxOf(frame(page, "cell-1"));
  await frame(page, "cell-1").getByRole("button", { name: "차트 닫기" }).click();
  await expect(frame(page, "cell-1")).toHaveCount(0);
  await page.getByRole("status").filter({ hasText: "차트 창을 닫았습니다" }).getByRole("button", { name: "되돌리기" }).click();
  expect(await boxOf(frame(page, "cell-1"))).toEqual(closeRect);
  await drag(page, header(page, "cell-1"), 60, 30);
  await page.getByRole("button", { name: /^레이아웃:/ }).click();
  await page.getByRole("menuitem", { name: "기본 배치로" }).click();
  await expect(tidy(page).getByLabel("겹친 곳")).toHaveText("0");
});

test("창 종류와 위 막대는 가운데에 차트를 더하고 기존 창을 앞으로 올리며 닫은 차트는 도킹에서도 빠진다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  const dock = page.getByRole("navigation", { name: "창 종류" });
  await dock.getByRole("button", { name: "차트 창 더하기" }).click();
  await expect(page.locator("[data-canvas-window]")).toHaveCount(4);
  await expect(cell(page, 3)).toHaveAttribute("aria-busy", "false");
  const added = page.locator("[data-canvas-window]").filter({ has: cell(page, 3) });
  const area = await boxOf(stage(page)), box = await boxOf(added);
  expect(Math.abs(box.x + box.width / 2 - area.x - area.width / 2)).toBeLessThan(25);
  expect(Math.abs(box.y + box.height / 2 - area.y - area.height / 2)).toBeLessThan(25);
  await expect(added).toHaveAttribute("data-active-cell", "");
  await dock.getByRole("button", { name: "관심종목 창 더하기" }).click();
  await expect(page.locator("[data-canvas-window]")).toHaveCount(4);
  await expect.poll(() => saved(scenario).canvas?.order.at(-1)).toBe("watchlist");
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^차트/ }).click();
  await expect(cell(page, 4)).toHaveAttribute("aria-busy", "false");
  const topAdded = page.locator("[data-canvas-window]").filter({ has: cell(page, 4) });
  const topBox = await boxOf(topAdded);
  expect(Math.abs(topBox.x + topBox.width / 2 - area.x - area.width / 2)).toBeLessThan(50);
  await expect(topAdded).toHaveAttribute("data-active-cell", "");
  const closeId = await topAdded.getAttribute("data-canvas-window");
  await topAdded.getByRole("button", { name: "차트 닫기" }).click();
  await mode(page, "도킹");
  await expect(page.locator(`[data-window-id="${closeId}"]`)).toHaveCount(0);
  await expect(cell(page, 3)).toHaveAttribute("aria-busy", "false");
});

test("머리 키보드 조작과 화면 크기 변경은 비율을 보존하고 취소는 저장하거나 드로잉하지 않는다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await header(page, "cell-0").focus();
  const tabbedHeaders = ["cell-0"];
  for (let step = 0; step < 100 && tabbedHeaders.length < 3; step++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.getAttribute("data-window-header"));
    if (id && id !== tabbedHeaders.at(-1)) tabbedHeaders.push(id);
  }
  expect(tabbedHeaders).toEqual(["cell-0", "cell-1", "watchlist"]);
  await header(page, "cell-0").focus();
  const before = await boxOf(frame(page, "cell-0"));
  await page.keyboard.press("ArrowRight");
  expect((await boxOf(frame(page, "cell-0"))).x).toBe(before.x + 16);
  await page.keyboard.press("Shift+ArrowRight");
  expect((await boxOf(frame(page, "cell-0"))).width).toBe(before.width + 16);
  await page.keyboard.press("Enter");
  await expect(frame(page, "cell-0")).toHaveAttribute("data-maximized", "");
  await page.keyboard.press("Escape");
  await expect(frame(page, "cell-0")).not.toHaveAttribute("data-maximized");
  const current = await boxOf(frame(page, "cell-0"));
  const currentArea = await boxOf(stage(page));
  await expect.poll(() => saved(scenario).canvas?.rects[windowId("cell-0")]?.w).toBeCloseTo(current.width / currentArea.width, 4);
  await drag(page, header(page, "cell-0"), 80, 50, false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await boxOf(frame(page, "cell-0"))).toEqual(current);
  const persisted = saved(scenario).canvas;
  const oldArea = await boxOf(stage(page));
  await page.setViewportSize({ width: 1024, height: 768 });
  const newArea = await boxOf(stage(page));
  const resized = await boxOf(frame(page, "cell-0"));
  expect(Math.abs(resized.width - current.width * newArea.width / oldArea.width)).toBeLessThan(1);
  for (const item of await page.locator("[data-window-header]").all()) {
    const h = await boxOf(item);
    expect(h.y).toBeGreaterThanOrEqual(newArea.y);
    expect(h.y + h.height).toBeLessThanOrEqual(newArea.y + newArea.height + 1);
  }
  expect(saved(scenario).canvas).toEqual(persisted);
  await header(page, "cell-0").press("Delete");
  await expect(frame(page, "cell-0")).toHaveCount(0);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
});

test("겹친 차트는 맨 위만 그리기를 받고 가려진 차트도 실시간 봉을 받으며 팝오버는 창 위에 뜬다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => scenario.live.subscriptions().map((entry) => entry.symbol).sort()).toEqual(["000660", "005930"]);
  const first = chartOf(cell(page)), second = chartOf(cell(page, 2));
  const coveredBox = await boxOf(frame(page, "cell-0")), coverBox = await boxOf(frame(page, "cell-1"));
  await drag(page, header(page, "cell-1"), coveredBox.x - coverBox.x, coveredBox.y - coverBox.y);
  expect(await boxOf(frame(page, "cell-1"))).toEqual(await boxOf(frame(page, "cell-0")));
  const r = await boxOf(second);
  await cell(page, 2).focus();
  await page.keyboard.press("T");
  await page.mouse.move(r.x + r.width * .25, r.y + r.height * .4);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * .4, r.y + r.height * .52, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => scenario.documents.drawings("000660").length).toBe(1);
  expect(scenario.documents.drawings("005930")).toHaveLength(0);
  await cell(page, 2).focus();
  await page.keyboard.press("T");
  await drag(page, header(page, "cell-1"), 30, 20);
  await drag(page, header(page, "cell-1"), -30, -20);
  expect(scenario.documents.drawings("000660")).toHaveLength(1);
  expect(scenario.documents.drawings("005930")).toHaveLength(0);
  const bar: Bar = { t: Date.parse("2026-11-09T00:00:00+09:00") / 1000, o: 56700, h: 56700, l: 56700, c: 56700, v: 1000 };
  scenario.live.bar("005930", bar);
  await expect(first).toHaveAttribute("data-last-close", "56700");
  await drag(page, header(page, "cell-1"), 400, 200);
  await expect(first).toHaveAttribute("data-last-close", "56700");
  await header(page, "cell-0").click({ position: { x: 60, y: 17 } });
  const toolbar = frame(page, "cell-0").getByRole("navigation", { name: "드로잉 도구" });
  await expect(toolbar).toBeVisible();
  const toolbarBox = await boxOf(toolbar), frameBox = await boxOf(frame(page, "cell-0"));
  expect(toolbarBox.x).toBeGreaterThanOrEqual(frameBox.x);
  expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width + 1);
  await toolbar.getByRole("button", { name: "드로잉 단축키 도움말" }).click();
  const popup = page.getByRole("dialog", { name: "드로잉 단축키" });
  await expect(popup).toBeVisible();
  expect(await popup.evaluate((el) => el.matches(":popover-open"))).toBe(true);
  await popup.getByRole("button", { name: "도움말 닫기" }).click();
});

test("캔버스 설정이어도 휴대폰은 기존 화면을 유지한다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "휴대폰 탭" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "봉 주기" })).toBeVisible();
  await expect(page.locator("[data-canvas-window]")).toHaveCount(0);
  await expect(page.getByRole("main", { name: "작업 영역" })).toHaveCount(0);
  expect(scenario.documents.uiPrefs().layoutMode).toBe("canvas");
});

test("도킹 설정으로 캔버스만 저장된 레이아웃을 열면 앞 차트부터 첫 도킹 배치를 만들어 저장한다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  const ui = { ...scenario.documents.uiState(), layoutMode: "dock" };
  scenario.documents.saveUiState(ui);
  const before = saved(scenario).canvas;
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  const groups = page.locator("[data-dock-group]");
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0).getByRole("tab", { name: /^SK하이닉스/ })).toHaveCount(1);
  await expect(groups.nth(1).getByRole("tab", { name: /^삼성전자/ })).toHaveCount(1);
  await expect.poll(() => saved(scenario).dock).not.toBeNull();
  expect(saved(scenario).canvas).toEqual(before);
  await page.reload();
  await expect(groups.nth(0).getByRole("tab", { name: /^SK하이닉스/ })).toHaveCount(1);
});

test("포인터 취소·캡처 상실·초점 상실·작업 영역 변경은 임시 배치를 버리고 입력막을 치운다", async ({ page, scenario }) => {
  seedCanvas(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  const original = await boxOf(frame(page, "cell-1"));
  for (const reason of ["pointercancel", "capture", "blur"]) {
    await drag(page, header(page, "cell-1"), 100, 80, false);
    await expect(stage(page)).toHaveAttribute("data-canvas-dragging", "");
    if (reason === "pointercancel") await header(page, "cell-1").dispatchEvent("pointercancel", { pointerId: 1, bubbles: true });
    if (reason === "capture") {
      await header(page, "cell-1").evaluate((el) => el.releasePointerCapture(1));
      await page.mouse.move(original.x + 100, original.y + 100);
    }
    if (reason === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
    await expect(stage(page)).not.toHaveAttribute("data-canvas-dragging");
    expect(await boxOf(frame(page, "cell-1"))).toEqual(original);
    await page.getByRole("button", { name: /^레이아웃:/ }).click();
    await expect(page.getByRole("menuitem", { name: "배치 되돌리기" })).toBeDisabled();
    await page.keyboard.press("Escape");
  }
  const persisted = saved(scenario).canvas;
  await drag(page, header(page, "cell-1"), 100, 80, false);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.mouse.up();
  await expect(stage(page)).not.toHaveAttribute("data-canvas-dragging");
  expect(saved(scenario).canvas).toEqual(persisted);
  await header(page, "cell-1").click({ position: { x: 60, y: 17 } });
  await expect(frame(page, "cell-1")).toHaveAttribute("data-active-cell", "");
});
