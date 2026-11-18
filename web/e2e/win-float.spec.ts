import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { parsePlacement } from "../src/layout/placement";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, test, type Scenario, pollSaved } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const frame = (page: Page, id = "screener") => page.locator(`[data-dock-float="${id}"]`);
const head = (page: Page, id = "screener") => frame(page, id).locator("[data-window-header]");
const area = (page: Page) => page.getByRole("main", { name: "작업 영역" });
const groups = (page: Page) => page.locator("[data-dock-group]");
const preview = (page: Page) => page.locator("[data-dock-preview]");
const saved = (scenario: Scenario) => parsePlacement(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement);
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const NOV9 = Date.parse("2026-11-09T00:00:00+09:00") / 1000;

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 창의 자리를 찾았습니다");
  return box;
}
async function detach(page: Page, name = "스크리너", id = "screener") {
  await tab(page, name).press("Shift+F10");
  await page.getByRole("menuitem", { name: "띄우기", exact: true }).click();
  await expect(frame(page, id)).toBeVisible();
  await expect(tab(page, name)).toHaveCount(0);
}
async function start(page: Page, source: Locator) {
  const box = await boxOf(source);
  const point = { x: box.x + Math.min(60, box.width / 2), y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
}
async function shiftMove(page: Page, id: string, dx: number, dy: number, release = true) {
  await page.keyboard.down("Shift");
  const point = await start(page, head(page, id));
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 8 });
  if (release) { await page.mouse.up(); await page.keyboard.up("Shift"); }
}
async function undo(page: Page) {
  await page.getByRole("button", { name: /^레이아웃:/ }).click();
  await page.getByRole("menuitem", { name: "배치 되돌리기", exact: true }).click();
}
function twoCharts(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "cell-1", link: "b", kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((window) => window.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

test("메뉴로 띄운 스크리너는 불투명한 창으로 탭 위에 남고 새로고침 뒤에도 같은 자리다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page);
  const before = await boxOf(frame(page));
  await pollSaved(() => saved(scenario).dock?.floats.length).toBe(1);
  const persisted = saved(scenario).dock!.floats[0]!.rect;
  expect(persisted.w).toBeCloseTo(before.width / (await boxOf(area(page))).width, 4);
  expect(await frame(page).locator(".window-panel").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await page.reload();
  await expect(frame(page)).toBeVisible();
  expect(await boxOf(frame(page))).toEqual(before);
});

test("머리 이동은 가장자리에 달라붙고 크기·키보드 조작과 되돌리기는 한 단계씩 저장한다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page);
  const original = await boxOf(frame(page));
  const room = await boxOf(area(page));
  await shiftMove(page, "screener", room.x - original.x + 5, 100, false);
  await expect(page.locator('[data-dock-guide="x"]')).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect((await boxOf(frame(page))).x).toBe(room.x);
  await undo(page);
  expect(await boxOf(frame(page))).toEqual(original);
  const handle = await boxOf(frame(page).locator('[data-resize-handle="se"]'));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 800, handle.y - 800, { steps: 8 });
  await page.mouse.up();
  const minimum = await boxOf(frame(page));
  expect(minimum.width).toBe(280);
  expect(minimum.height).toBe(274);
  await expect(page.getByRole("status").filter({ hasText: "스크리너 창은 280×274" })).toBeVisible();
  await undo(page);
  expect(await boxOf(frame(page))).toEqual(original);
  await head(page).focus();
  await page.keyboard.press("ArrowLeft");
  expect((await boxOf(frame(page))).x).toBe(original.x - 16);
  await page.keyboard.press("Shift+ArrowRight");
  expect((await boxOf(frame(page))).width).toBe(original.width + 16);
  await pollSaved(() => saved(scenario).dock?.floats[0]?.rect.w).toBeCloseTo((original.width + 16) / room.width, 4);
  const persisted = saved(scenario).dock;
  await page.setViewportSize({ width: 1100, height: 760 });
  await expect(head(page)).toBeVisible();
  expect(saved(scenario).dock).toEqual(persisted);
  expect((await boxOf(head(page))).y).toBeGreaterThanOrEqual((await boxOf(area(page))).y);
});

test("떠 있는 머리를 차트 아래로 놓아 붙이고 한 번 되돌리면 원래 떠 있던 자리다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page);
  const original = await boxOf(frame(page));
  const chart = await boxOf(groups(page).first());
  await start(page, head(page));
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 60, { steps: 10 });
  await expect(preview(page)).toContainText("아래에 나눠 놓기");
  const predicted = await boxOf(preview(page));
  await page.mouse.up();
  await expect(frame(page)).toHaveCount(0);
  const group = groups(page).filter({ has: tab(page, "스크리너") });
  expect(await boxOf(group)).toEqual(predicted);
  await pollSaved(() => saved(scenario).dock?.floats.length).toBe(0);
  await undo(page);
  expect(await boxOf(frame(page))).toEqual(original);
});

test("Shift 전환은 포인터가 멈춰 있어도 미리 보기를 바꾸며 영역 밖 일반 탭 놓기는 아무것도 바꾸지 않는다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = await boxOf(groups(page).first());
  await start(page, tab(page, "스크리너"));
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height / 2, { steps: 8 });
  await expect(preview(page)).toContainText("탭으로 넣기");
  await page.keyboard.down("Shift");
  await expect(preview(page)).toContainText("띄우기");
  await page.keyboard.up("Shift");
  await expect(preview(page)).toContainText("탭으로 넣기");
  await page.keyboard.down("Shift");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(frame(page)).toBeVisible();
  await start(page, head(page));
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 60, { steps: 8 });
  await expect(preview(page)).toContainText("아래에 나눠 놓기");
  await page.keyboard.down("Shift");
  await expect(preview(page)).toHaveCount(0);
  await page.keyboard.up("Shift");
  await expect(preview(page)).toContainText("아래에 나눠 놓기");
  await page.keyboard.down("Shift");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(frame(page)).toBeVisible();
  await frame(page).getByRole("button", { name: "스크리너 붙이기" }).click();
  await start(page, tab(page, "스크리너"));
  await page.mouse.move(700, 30, { steps: 8 });
  await page.mouse.up();
  await expect(frame(page)).toHaveCount(0);
  await expect(tab(page, "스크리너")).toBeVisible();
});

test("띄운 차트는 같은 노드·봉·드로잉·구독을 유지하고 활성 칸이 창을 따르고 도구 막대는 창 밖에 그대로 있다", async ({ page, scenario }) => {
  twoCharts(scenario);
  const drawingId = "01900000-0000-7000-8000-0000000000d1";
  scenario.documents.saveDrawing({ id: drawingId, symbol: "000660", tool: "hline", points: [{ t: NOV9, price: 100000 }], style: {}, text: null, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: "cell-1" }, revision: 1 });
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await pollSaved(() => scenario.live.subscriptions().length).toBeGreaterThanOrEqual(2);
  const node = await chartOf(cell(page, 2)).elementHandle();
  if (!node) throw new Error("띄울 차트가 없습니다");
  const subscriptions = scenario.live.messages.length;
  await detach(page, "SK하이닉스", "cell-1");
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  expect(await chartOf(cell(page, 2)).evaluate((element, previous) => element === previous, node)).toBe(true);
  expect(scenario.live.messages.slice(subscriptions).filter((message) => message.type === "subscribe" || message.type === "unsubscribe")).toEqual([]);
  const bar: Bar = { t: NOV9, o: 201500, h: 201500, l: 201500, c: 201500, v: 1000 };
  scenario.live.bar("000660", bar);
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-close", "201500");
  await expect(chartOf(cell(page, 2)).locator(".drawing-mirror")).toHaveAttribute("data-drawings", new RegExp(drawingId));
  await head(page, "cell-1").click({ position: { x: 60, y: 17 } });
  await expect(frame(page, "cell-1")).toHaveAttribute("data-active-cell", "");
  await expect(frame(page, "cell-1").getByRole("navigation", { name: "드로잉 도구" })).toHaveCount(0);
  const toolbar = await boxOf(page.getByRole("navigation", { name: "드로잉 도구" }));
  const floated = await boxOf(frame(page, "cell-1"));
  expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(floated.x);
  await shiftMove(page, "cell-1", 250 - floated.x, 160 - floated.y);
  const visible = await boxOf(frame(page, "cell-1"));
  expect(visible.y + visible.height).toBeLessThan((await boxOf(area(page))).y + (await boxOf(area(page))).height);
  await mkdir(path.resolve("../target/ux-screens"), { recursive: true });
  await page.screenshot({ path: path.resolve("../target/ux-screens/win-float.png") });
  await frame(page, "cell-1").getByRole("button", { name: "차트 붙이기" }).click();
  expect(await chartOf(cell(page, 2)).evaluate((element, previous) => element === previous, node)).toBe(true);
});

test("떠 있는 창은 가려진 차트 입력을 막고 가리지 않은 차트는 드로잉을 받는다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page);
  const chart = await boxOf(chartOf(cell(page)));
  const floated = await boxOf(frame(page));
  await shiftMove(page, "screener", chart.x + 220 - floated.x, chart.y + 180 - floated.y);
  const cover = await boxOf(frame(page));
  await cell(page).focus();
  await page.keyboard.press("T");
  await page.mouse.move(cover.x + 50, cover.y + cover.height - 80);
  await page.mouse.down();
  await page.mouse.move(cover.x + 120, cover.y + cover.height - 45, { steps: 8 });
  await page.mouse.up();
  expect(scenario.documents.drawings("005930")).toHaveLength(0);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-dock-float]")?.getAttribute("data-dock-float"), { x: cover.x + 60, y: cover.y + 200 })).toBe("screener");
  await cell(page).focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("T");
  await page.mouse.move(chart.x + 60, chart.y + chart.height * .4);
  await page.mouse.down();
  await page.mouse.move(chart.x + 160, chart.y + chart.height * .52, { steps: 8 });
  await page.mouse.up();
  await pollSaved(() => scenario.documents.drawings("005930").length).toBe(1);
});

test("띄우기 되돌리기와 기본 배치로는 모두 붙이고 첫 캔버스 전환은 자리와 앞 차례를 보존한다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page);
  await undo(page);
  await expect(frame(page)).toHaveCount(0);
  await expect(tab(page, "스크리너")).toBeVisible();
  await detach(page);
  await page.getByRole("button", { name: /^레이아웃:/ }).click();
  await page.getByRole("menuitem", { name: "기본 배치로", exact: true }).click();
  await expect(page.locator("[data-dock-float]")).toHaveCount(0);
  await detach(page);
  const before = await boxOf(frame(page));
  await page.getByRole("button", { name: /^레이아웃:/ }).click();
  await page.getByRole("group", { name: "창 배치 방식" }).getByRole("button", { name: "캔버스", exact: true }).click();
  await page.keyboard.press("Escape");
  const canvas = page.locator('[data-canvas-window="screener"]');
  await expect(canvas).toBeVisible();
  expect(await boxOf(canvas)).toEqual(before);
  await pollSaved(() => saved(scenario).canvas?.order.at(-1)).toBe("screener");
});

test("마지막 도킹 창의 띄우기는 비활성이고 Shift 끌기도 거절한다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, windows: layout.windows.filter((window) => window.kind === "chart" || window.kind === "screener"), placement: {}, revision: layout.revision + 1 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page);
  const chartTab = page.getByRole("tab");
  await chartTab.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: /^띄우기/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.down("Shift");
  const point = await start(page, chartTab);
  await page.mouse.move(point.x + 100, point.y + 100, { steps: 8 });
  await expect(preview(page)).toHaveAttribute("data-dock-preview", "blocked");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator("[data-dock-float]")).toHaveCount(1);
  await expect(chartTab).toBeVisible();
});

test("작은 나누기 거절은 떠 있던 위치와 기록을 그대로 둔다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 450 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page);
  const before = await boxOf(frame(page));
  await pollSaved(() => saved(scenario).dock?.floats.length).toBe(1);
  const persisted = saved(scenario).dock;
  const chart = await boxOf(groups(page).first());
  await start(page, head(page));
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 45, { steps: 8 });
  await expect(preview(page)).toHaveAttribute("data-dock-preview", "blocked");
  await page.mouse.up();
  expect(await boxOf(frame(page))).toEqual(before);
  expect(saved(scenario).dock).toEqual(persisted);
  await expect(page.getByRole("status").filter({ hasText: "자리가 작아 나눌 수 없습니다" })).toBeVisible();
  await undo(page);
  await expect(frame(page)).toHaveCount(0);
});

test("취소·캡처 상실·초점 상실·영역 변경은 떠 있는 창의 임시 배치를 버린다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page);
  const before = await boxOf(frame(page));
  await pollSaved(() => saved(scenario).dock?.floats.length).toBe(1);
  for (const reason of ["Escape", "pointercancel", "capture", "blur"]) {
    await shiftMove(page, "screener", -100, 80, false);
    await expect(area(page)).toHaveAttribute("data-dock-dragging", "");
    if (reason === "Escape") await page.keyboard.press("Escape");
    if (reason === "pointercancel") await head(page).dispatchEvent("pointercancel", { pointerId: 1 });
    if (reason === "capture") { await head(page).evaluate((el) => el.releasePointerCapture(1)); await page.mouse.move(before.x - 50, before.y + 100); }
    if (reason === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(area(page)).not.toHaveAttribute("data-dock-dragging");
    expect(await boxOf(frame(page))).toEqual(before);
  }
  const persisted = saved(scenario).dock;
  await shiftMove(page, "screener", -100, 80, false);
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(area(page)).not.toHaveAttribute("data-dock-dragging");
  expect(saved(scenario).dock).toEqual(persisted);
  await undo(page);
  await expect(frame(page)).toHaveCount(0);
});


test("새로고침 뒤에도 붙이기는 살아 있는 사용자 묶음으로 돌아가고 머리 가운데 놓기는 탭으로 넣는다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = await boxOf(groups(page).first());
  await start(page, tab(page, "스크리너"));
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height / 2, { steps: 8 });
  await page.mouse.up();
  const origin = await tab(page, "스크리너").locator("xpath=ancestor::*[@data-dock-group]").getAttribute("data-dock-group");
  await detach(page);
  await page.reload();
  await expect(frame(page)).toBeVisible();
  await frame(page).getByRole("button", { name: "스크리너 붙이기" }).click();
  await expect(frame(page)).toHaveCount(0);
  await expect(tab(page, "스크리너")).toHaveAttribute("aria-selected", "true");
  expect(await tab(page, "스크리너").locator("xpath=ancestor::*[@data-dock-group]").getAttribute("data-dock-group")).toBe(origin);
  await detach(page);
  const side = await boxOf(groups(page).filter({ has: tab(page, "관심종목") }));
  await start(page, head(page));
  await page.mouse.move(side.x + side.width / 2, side.y + side.height / 2, { steps: 8 });
  await expect(preview(page)).toContainText("탭으로 넣기");
  await page.mouse.up();
  await expect(groups(page).filter({ has: tab(page, "관심종목") }).getByRole("tab", { name: "스크리너" })).toHaveAttribute("aria-selected", "true");
});

test("떠 있는 창끼리 달라붙고 머리 클릭은 앞 차례만 한 번 바꾼다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page);
  const room = await boxOf(area(page));
  const initial = await boxOf(frame(page));
  await shiftMove(page, "screener", room.x + 200 - initial.x, 100);
  await detach(page, "관심종목", "watchlist");
  const screener = await boxOf(frame(page));
  const watchlist = await boxOf(frame(page, "watchlist"));
  await shiftMove(page, "watchlist", screener.x + screener.width + 6 - watchlist.x + 5, screener.y - watchlist.y, false);
  await expect(page.locator('[data-dock-guide="x"]')).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect((await boxOf(frame(page, "watchlist"))).x).toBe(screener.x + screener.width + 6);
  await pollSaved(() => saved(scenario).dock?.floats.at(-1)?.window).toBe("watchlist");
  await head(page).click({ position: { x: 60, y: 17 } });
  await pollSaved(() => saved(scenario).dock?.floats.at(-1)?.window).toBe("screener");
  await undo(page);
  await pollSaved(() => saved(scenario).dock?.floats.at(-1)?.window).toBe("watchlist");
});

test("놓을 때 실제 포인터 위치와 Shift 상태로 다시 판정한다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page);
  const chart = await boxOf(groups(page).first());
  await shiftMove(page, "screener", -200, 120, false);
  await expect(preview(page)).toHaveCount(0);
  await head(page).dispatchEvent("pointerup", { pointerId: 1, isPrimary: true, clientX: chart.x + chart.width / 2, clientY: chart.y + chart.height / 2, shiftKey: false });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(frame(page)).toHaveCount(0);
  await expect(groups(page).first().getByRole("tab", { name: "스크리너" })).toHaveAttribute("aria-selected", "true");
});


test("마지막 도킹 보조 창을 닫아도 나머지 떠 있는 창은 자리와 차례를 지킨다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, windows: layout.windows.filter((window) => ["chart", "screener", "watchlist"].includes(window.kind)), placement: {}, revision: layout.revision + 1 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await detach(page, "코스피", "cell-0");
  await detach(page, "관심종목", "watchlist");
  const before = await boxOf(frame(page, "watchlist"));
  await page.getByRole("button", { name: "스크리너 닫기", exact: true }).click();
  await expect(frame(page, "watchlist")).toBeVisible();
  expect(await boxOf(frame(page, "watchlist"))).toEqual(before);
  await undo(page);
  expect(await boxOf(frame(page, "watchlist"))).toEqual(before);
});

test("머리의 연동 색 점을 누르면 색 변경과 함께 떠 있는 차트를 활성화하고 앞으로 올린다", async ({ page, scenario }) => {
  twoCharts(scenario);
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, placement: { v: 1, canvas: null, dock: { root: { kind: "group", id: "g1", tabs: ["cell-0", "watchlist"], active: "cell-0" }, floats: [{ window: "cell-1", rect: { x: .05, y: .1, w: .5, h: .5 } }, { window: "screener", rect: { x: .6, y: .25, w: .25, h: .5 } }] } } });
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await cell(page).click({ position: { x: 50, y: 20 } });
  await expect(frame(page, "cell-1")).not.toHaveAttribute("data-active-cell");
  const link = frame(page, "cell-1").getByRole("button", { name: /^연동 색:/ });
  await expect(link).toHaveAccessibleName("연동 색: B");
  await chooseLink(page, link, "C");
  await expect(link).toHaveAccessibleName("연동 색: C");
  await expect(frame(page, "cell-1")).toHaveAttribute("data-active-cell", "");
  await pollSaved(() => saved(scenario).dock?.floats.at(-1)?.window).toBe("cell-1");
});

test("화면에서 최소 크기로 커진 떠 있는 창은 캔버스로 전환해도 머리와 위치가 같다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, placement: { v: 1, canvas: null, dock: { root: { kind: "group", id: "g1", tabs: ["cell-0", "watchlist"], active: "cell-0" }, floats: [{ window: "screener", rect: { x: .8, y: .8, w: .12, h: .12 } }] } } });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = await boxOf(frame(page));
  await page.getByRole("button", { name: /^레이아웃:/ }).click();
  await page.getByRole("group", { name: "창 배치 방식" }).getByRole("button", { name: "캔버스", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-canvas-window="screener"]')).toBeVisible();
  expect(await boxOf(page.locator('[data-canvas-window="screener"]'))).toEqual(before);
});

test("일반 차트 탭을 영역 밖이나 거절한 자리에 놓으면 활성 칸과 배치가 바뀌지 않는다", async ({ page, scenario }) => {
  twoCharts(scenario);
  await page.setViewportSize({ width: 1440, height: 450 });
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await page.locator("#window-tab-cell-1").click();
  const active = page.locator("#window-tab-cell-1");
  await expect(active).toHaveAttribute("data-active-cell", "");
  for (const outside of [true, false]) {
    const group = await boxOf(groups(page).last());
    await start(page, page.locator("#window-tab-cell-0"));
    await page.mouse.move(outside ? 700 : group.x + group.width / 2, outside ? 20 : group.y + group.height - 45, { steps: 8 });
    if (!outside) await expect(preview(page)).toHaveAttribute("data-dock-preview", "blocked");
    await page.mouse.up();
    await expect(active).toHaveAttribute("data-active-cell", "");
  }
});

async function chooseLink(page: Page, dot: Locator, name: string) {
  await dot.click();
  await page.getByRole("menu", { name: "연동 색" }).getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
}
