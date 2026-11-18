import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { parsePlacement } from "../src/layout/placement";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, test, type Scenario, desktopVenueCombo, expectDesktopVenue, pollSaved } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });
const screens = path.resolve("../target/ux-screens");
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const groups = (page: Page) => page.locator("[data-dock-group]");
const groupWith = (page: Page, name: string) => groups(page).filter({ has: tab(page, name) });
const preview = (page: Page) => page.locator("[data-dock-preview]");
const area = (page: Page) => page.getByRole("main", { name: "작업 영역" });
const menu = (page: Page) => page.getByRole("menu", { name: "창 배치" });
const saved = (scenario: Scenario) => parsePlacement(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement).dock;
const settings = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const NOV9 = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const bar = (price: number): Bar => ({ t: NOV9, o: price, h: price, l: price, c: price, v: 1000 });

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

async function startDrag(page: Page, source: Locator) {
  const box = await boxOf(source);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

async function dragTo(page: Page, source: Locator, destination: { x: number; y: number }) {
  await startDrag(page, source);
  await page.mouse.move(destination.x, destination.y, { steps: 12 });
  await page.mouse.up();
}

async function persistBaseline(page: Page, scenario: Scenario) {
  await tab(page, "스크리너").click();
  await tab(page, "관심종목").click();
  await pollSaved(() => saved(scenario)).not.toBeNull();
  await pollSaved(() => JSON.stringify(saved(scenario))).toContain('"active":"watchlist"');
}

async function undo(page: Page, source: Locator) {
  await source.press("Shift+F10");
  await menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true }).click();
}

function twoCharts(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: settings },
    { id: "cell-1", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: settings },
    ...layout.windows.filter((window) => window.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

test("스크리너를 차트 아래로 나누고 실제 미리 보기와 같은 자리에 놓아 저장한 뒤 가운데 탭으로 돌린다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = await boxOf(groups(page).first());
  await startDrag(page, tab(page, "스크리너"));
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 60, { steps: 12 });
  await expect(preview(page)).toContainText("아래에 나눠 놓기");
  const predicted = await boxOf(preview(page));
  await mkdir(screens, { recursive: true });
  await page.screenshot({ path: path.join(screens, "win-dock-preview.png") });
  await page.mouse.up();
  await expect(preview(page)).toHaveCount(0);
  await expect(groups(page)).toHaveCount(3);
  const screener = await boxOf(groupWith(page, "스크리너"));
  expect(screener).toEqual(predicted);
  const top = await boxOf(groups(page).first());
  const right = await boxOf(groupWith(page, "관심종목"));
  const room = await boxOf(area(page));
  expect(top.y + top.height + 6).toBe(screener.y);
  expect(screener.x).toBe(top.x);
  expect(screener.x + screener.width + 6).toBe(right.x);
  expect(screener.y + screener.height).toBe(room.y + room.height);
  expect(right.x + right.width).toBe(room.x + room.width);
  await page.screenshot({ path: path.join(screens, "win-dock-placed.png") });
  await pollSaved(() => saved(scenario)?.root.kind).toBe("split");
  await pollSaved(() => JSON.stringify(saved(scenario))).toContain('"id":"g3"');
  await page.reload();
  await expect(groups(page)).toHaveCount(3);
  const destination = await boxOf(groupWith(page, "관심종목"));
  await dragTo(page, tab(page, "스크리너"), { x: destination.x + destination.width / 2, y: destination.y + destination.height / 2 });
  await expect(groups(page)).toHaveCount(2);
  await expect(groupWith(page, "관심종목").getByRole("tab", { name: "스크리너" })).toHaveAttribute("aria-selected", "true");
});

test("전체 아래 가장자리는 전체 폭을 나누고 한 번의 배치 되돌리기로 돌아온다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await persistBaseline(page, scenario);
  const original = saved(scenario);
  const room = await boxOf(area(page));
  await startDrag(page, tab(page, "스크리너"));
  await page.mouse.move(room.x + room.width * 0.65, room.y + room.height - 8, { steps: 12 });
  await expect(preview(page)).toContainText("아래에 나눠 놓기");
  const predicted = await boxOf(preview(page));
  expect(predicted.width).toBe(room.width);
  await page.mouse.up();
  expect(await boxOf(groupWith(page, "스크리너"))).toEqual(predicted);
  await undo(page, tab(page, "스크리너"));
  await expect(groups(page)).toHaveCount(2);
  await pollSaved(() => saved(scenario)).toEqual(original);
  await tab(page, "스크리너").press("Shift+F10");
  await expect(menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true })).toBeDisabled();
});

test("두 차트를 바꾸어 놓아도 같은 차트 노드·봉·드로잉·구독이 이어지고 도구 막대가 옮겨진다", async ({ page, scenario }) => {
  twoCharts(scenario);
  scenario.documents.saveDrawing({ id: "01900000-0000-7000-8000-0000000000d1", symbol: "000660", tool: "hline", points: [{ t: NOV9, price: 100_000 }], style: {}, text: null, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: "cell-1" }, revision: 1 });
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await pollSaved(() => scenario.live.subscriptions().length).toBeGreaterThanOrEqual(2);
  const node = await chartOf(cell(page, 2)).elementHandle();
  if (!node) throw new Error("옮길 차트가 없습니다");
  const subscriptions = scenario.live.messages.length;
  const first = await boxOf(groupWith(page, "삼성전자"));
  await dragTo(page, tab(page, "SK하이닉스"), { x: first.x + 50, y: first.y + first.height / 2 });
  const left = await boxOf(groupWith(page, "SK하이닉스"));
  const right = await boxOf(groupWith(page, "삼성전자"));
  expect(left.x + left.width).toBeLessThan(right.x);
  expect(await chartOf(cell(page, 2)).evaluate((element, previous) => element === previous, node)).toBe(true);
  expect(scenario.live.messages.slice(subscriptions).filter((message) => message.type === "subscribe" || message.type === "unsubscribe")).toEqual([]);
  scenario.live.bar("000660", bar(201_500));
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-close", "201500");
  await expect(chartOf(cell(page, 2)).locator(".drawing-mirror")).toHaveAttribute("data-drawings", /0000000000d1/);
  await expect(groupWith(page, "SK하이닉스")).toHaveAttribute("data-active-cell", "");
  const toolbar = await boxOf(page.getByRole("navigation", { name: "드로잉 도구" }));
  expect(toolbar.x).toBeGreaterThanOrEqual(left.x);
  expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(left.x + left.width);
  expect(toolbar.y).toBeGreaterThan(left.y);
});

test("최소 크기 거절은 미리 보기와 메뉴에 이유를 보이고 배치 기록을 만들지 않는다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 450 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await persistBaseline(page, scenario);
  const original = saved(scenario);
  const chart = await boxOf(groups(page).first());
  await startDrag(page, tab(page, "스크리너"));
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 45, { steps: 10 });
  const reason = "자리가 작아 나눌 수 없습니다. 가운데에 놓아 탭으로 넣으세요";
  await expect(preview(page)).toHaveAttribute("data-dock-preview", "blocked");
  await expect(preview(page)).toContainText(reason);
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: reason })).toBeVisible();
  expect(saved(scenario)).toEqual(original);
  await tab(page, "스크리너").press("Shift+F10");
  await expect(menu(page).getByRole("menuitem", { name: /^아래에 나눠 놓기/ })).toBeDisabled();
  await expect(menu(page)).toContainText(reason);
  await expect(menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await startDrag(page, tab(page, "스크리너"));
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 45, { steps: 10 });
  await expect(preview(page)).toHaveAttribute("data-dock-preview", "blocked");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(preview(page)).toHaveAttribute("data-dock-preview", "change");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(saved(scenario)).toEqual(original);
});

test("5px 이하는 탭 고르기이고 Esc·영역 밖 놓기·포인터 취소는 선택과 배치 기록을 지킨다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const source = tab(page, "스크리너");
  const sourceBox = await boxOf(source);
  await startDrag(page, source);
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 4, sourceBox.y + sourceBox.height / 2);
  await expect(preview(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(source).toHaveAttribute("aria-selected", "true");
  await tab(page, "관심종목").click();
  await expect(tab(page, "관심종목")).toHaveAttribute("aria-selected", "true");
  await pollSaved(() => JSON.stringify(saved(scenario))).toContain('"active":"watchlist"');
  const original = saved(scenario);
  const chart = await boxOf(groups(page).first());
  for (const cancel of ["escape", "outside", "pointercancel"]) {
    await startDrag(page, source);
    await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 60, { steps: 10 });
    await expect(preview(page)).toBeVisible();
    await area(page).dispatchEvent("pointercancel", { pointerId: 2 });
    await expect(preview(page)).toBeVisible();
    if (cancel === "escape") await page.keyboard.press("Escape");
    if (cancel === "outside") await page.mouse.move(700, 30, { steps: 6 });
    if (cancel === "pointercancel") await area(page).dispatchEvent("pointercancel", { pointerId: 1 });
    await page.mouse.up();
    await expect(preview(page)).toHaveCount(0);
    await expect(tab(page, "관심종목")).toHaveAttribute("aria-selected", "true");
    expect(saved(scenario)).toEqual(original);
  }
  await source.press("Shift+F10");
  await expect(menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true })).toBeDisabled();
});

for (const cancellation of ["Escape", "pointercancel", "lostpointercapture"]) {
  test(`${cancellation} 취소 뒤 원래 비활성 탭에 늦게 놓아도 선택·배치·기록을 지킨다`, async ({ page, scenario }) => {
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await persistBaseline(page, scenario);
    const original = saved(scenario);
    const source = tab(page, "스크리너");
    const from = await boxOf(source);
    const chart = await boxOf(groups(page).first());
    await startDrag(page, source);
    await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 60, { steps: 12 });
    await expect(preview(page)).toBeVisible();
    if (cancellation === "Escape") await page.keyboard.press("Escape");
    else if (cancellation === "pointercancel") await area(page).dispatchEvent("pointercancel", { pointerId: 1 });
    else await area(page).evaluate((root) => root.releasePointerCapture(1));
    await expect(preview(page)).toHaveCount(0);
    await area(page).dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", isPrimary: false });
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(tab(page, "관심종목")).toHaveAttribute("aria-selected", "true");
    await expect(source).toHaveAttribute("aria-selected", "false");
    expect(saved(scenario)).toEqual(original);
    await expect(groups(page)).toHaveCount(2);
    expect(await boxOf(source)).toEqual(from);
    await source.press("Shift+F10");
    await expect(menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await source.press("Enter");
    await expect(source).toHaveAttribute("aria-selected", "true");
    await tab(page, "관심종목").click();
    await source.click();
    await expect(source).toHaveAttribute("aria-selected", "true");
  });
}

test("취소한 끌기의 클릭이 없어도 다음 키보드 선택과 새 포인터 클릭을 받는다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const source = tab(page, "스크리너");
  const chart = await boxOf(groups(page).first());
  await startDrag(page, source);
  await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height - 60, { steps: 12 });
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview(page)).toHaveCount(0);
  const elsewhere = await page.context().newPage();
  await elsewhere.bringToFront();
  await elsewhere.mouse.up();
  await elsewhere.close();
  await page.bringToFront();
  await source.press("Enter");
  await expect(source).toHaveAttribute("aria-selected", "true");
  await groupWith(page, "스크리너").getByRole("button", { name: "이 묶음에 창 더하기" }).click();
  await expect(page.getByRole("menu", { name: "창 더하기" })).toBeVisible();
  await page.keyboard.press("Escape");
  await tab(page, "관심종목").click();
  await source.click();
  await expect(source).toHaveAttribute("aria-selected", "true");
});

test("같은 줄에서 순서를 바꾸고 Alt 화살표·메뉴 키·우클릭으로 같은 이동을 한다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const screener = tab(page, "스크리너");
  const watch = await boxOf(tab(page, "관심종목"));
  await dragTo(page, screener, { x: watch.x + 8, y: watch.y + watch.height - 3 });
  await expect(groupWith(page, "스크리너").getByRole("tab")).toHaveText([/^스크리너/, /^관심종목/]);
  await screener.press("Alt+ArrowRight");
  await expect(groupWith(page, "스크리너").getByRole("tab")).toHaveText([/^관심종목/, /^스크리너/]);
  await expect(screener).toBeFocused();
  await screener.press("Shift+F10");
  await menu(page).getByRole("menuitem", { name: "아래에 나눠 놓기", exact: true }).click();
  await expect(groups(page)).toHaveCount(3);
  await expect(screener).toBeFocused();
  await expect(tab(page, "관심종목")).toHaveAttribute("aria-selected", "true");
  await screener.click({ button: "right" });
  await expect(menu(page)).toContainText("다른 묶음으로 옮기기");
  await menu(page).getByRole("menuitem", { name: "관심종목", exact: true }).click();
  await expect(groups(page)).toHaveCount(2);
  await expect(groupWith(page, "관심종목").getByRole("tab", { name: "스크리너" })).toHaveAttribute("aria-selected", "true");
});

test("묶음 더하기는 차트를 그 묶음에 더하고 기존 단일 창은 옮겨 오며 숨은 차트도 유지한다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const firstNode = await chartOf(cell(page)).elementHandle();
  if (!firstNode) throw new Error("처음 차트가 없습니다");
  const firstGroup = groups(page).first();
  await firstGroup.getByRole("button", { name: "이 묶음에 창 더하기" }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^차트/ }).click();
  await expect(firstGroup.getByRole("tab")).toHaveCount(2);
  await expect(cell(page, 2)).toBeVisible();
  expect(await firstNode.evaluate((node) => node.isConnected)).toBe(true);
  expect(await firstNode.isVisible()).toBe(false);
  await undo(page, firstGroup.getByRole("tab").last());
  await expect(firstGroup.getByRole("tab")).toHaveCount(1);
  expect(await chartOf(cell(page)).evaluate((node, previous) => node === previous, firstNode)).toBe(true);
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^지표/ }).click();
  await expect(groupWith(page, "관심종목").locator(".dock-tabs").getByRole("tab", { name: "지표" })).toBeVisible();
  await firstGroup.getByRole("button", { name: "이 묶음에 창 더하기" }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^지표/ }).click();
  await expect(firstGroup.locator(".dock-tabs").getByRole("tab", { name: "지표" })).toHaveAttribute("aria-selected", "true");
  await pollSaved(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.filter((window) => window.kind === "indicators").length).toBe(1);
  await undo(page, firstGroup.locator(".dock-tabs").getByRole("tab", { name: "지표" }));
  await expect(groupWith(page, "관심종목").locator(".dock-tabs").getByRole("tab", { name: "지표" })).toBeVisible();
});

test("끌 때 차트 드로잉과 관심종목·포털 도구 입력을 막고 놓은 뒤 정상 입력을 돌린다", async ({ page, scenario }) => {
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "main", name: "기본", symbols: ["000660"] }] });
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await cell(page).focus();
  await page.keyboard.press("T");
  const before = scenario.documents.drawings("005930").length;
  const chart = await boxOf(chartOf(cell(page)));
  await startDrag(page, tab(page, "스크리너"));
  await page.mouse.move(chart.x + chart.width * 0.7, chart.y + chart.height * 0.4, { steps: 10 });
  await expect(area(page)).toHaveAttribute("data-dock-dragging", "");
  await page.mouse.move(chart.x + chart.width * 0.8, chart.y + chart.height * 0.3, { steps: 10 });
  await page.mouse.wheel(0, 300);
  const exchange = desktopVenueCombo(page);
  await exchange.dispatchEvent("click");
  await expect(exchange).toHaveAttribute("aria-expanded", "false");
  await expectDesktopVenue(page, "통합");
  const watch = page.getByRole("complementary", { name: "관심종목" });
  const stock = watch.getByText("SK하이닉스", { exact: true }).first();
  const stockBox = await boxOf(stock);
  await page.mouse.move(stockBox.x + stockBox.width / 2, stockBox.y + stockBox.height / 2, { steps: 10 });
  await page.mouse.up();
  expect(scenario.documents.drawings("005930")).toHaveLength(before);
  await expect(cell(page)).toHaveAttribute("aria-label", /삼성전자/);
  await expect(preview(page)).toHaveCount(0);
  await expect(area(page)).not.toHaveAttribute("data-dock-dragging", "");
  await tab(page, "관심종목").click();
  await stock.click();
  await expect(cell(page)).toHaveAttribute("aria-label", /SK하이닉스/);
});

test("탭 중심의 수평 끌기는 순서를 바꾸고 위쪽으로 끌면 전체 가장자리를 나눈다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const watch = await boxOf(tab(page, "관심종목"));
  await dragTo(page, tab(page, "스크리너"), { x: watch.x + watch.width / 2, y: watch.y + watch.height / 2 });
  await expect(groups(page)).toHaveCount(2);
  await expect(groupWith(page, "관심종목").getByRole("tab")).toHaveText([/^스크리너/, /^관심종목/]);
  const movedWatch = await boxOf(tab(page, "관심종목"));
  await dragTo(page, tab(page, "스크리너"), { x: movedWatch.x + movedWatch.width / 2, y: movedWatch.y + movedWatch.height / 2 });
  await expect(groupWith(page, "관심종목").getByRole("tab")).toHaveText([/^관심종목/, /^스크리너/]);
  const source = await boxOf(tab(page, "스크리너"));
  const room = await boxOf(area(page));
  await startDrag(page, tab(page, "스크리너"));
  await page.mouse.move(source.x + source.width / 2, room.y + 5, { steps: 8 });
  await expect(preview(page)).toContainText("위에 나눠 놓기");
  expect((await boxOf(preview(page))).width).toBe(room.width);
  await page.mouse.up();
  await expect(groups(page)).toHaveCount(3);
  expect((await boxOf(groupWith(page, "스크리너"))).y).toBe(room.y);
});

const closeOf = (page: Page, name: string) => groups(page).getByRole("button", { name: new RegExp(`^${name}.* 닫기$`) });
const closeOpacity = (button: Locator) => button.evaluate((element) => Number(getComputedStyle(element).opacity));

test("닫기 버튼은 탭에 포인터를 올리거나 키보드 초점이 있을 때만 보이고 자리는 그대로다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const screener = tab(page, "스크리너");
  const watch = tab(page, "관심종목");
  await expect(watch).toHaveAttribute("aria-selected", "true");
  await page.mouse.move(0, 0);
  const selectedClose = closeOf(page, "관심종목");
  const otherClose = closeOf(page, "스크리너");
  await expect.poll(() => closeOpacity(selectedClose)).toBe(0);
  await expect.poll(() => closeOpacity(otherClose)).toBe(0);
  const screenerBox = await boxOf(screener);
  const before = await Promise.all([screener, watch].map(boxOf));
  await page.mouse.move(screenerBox.x + screenerBox.width / 2, screenerBox.y + screenerBox.height / 2);
  await expect.poll(() => closeOpacity(otherClose)).toBe(1);
  await expect.poll(() => closeOpacity(selectedClose)).toBe(0);
  const after = await Promise.all([screener, watch].map(boxOf));
  expect(after).toEqual(before);
  await page.mouse.move(0, 0);
  await expect.poll(() => closeOpacity(otherClose)).toBe(0);
  await watch.focus();
  await expect.poll(() => closeOpacity(selectedClose)).toBe(1);
  await selectedClose.focus();
  await expect.poll(() => closeOpacity(selectedClose)).toBe(1);
});

test("마지막 차트 창의 비활성 닫기 버튼도 같은 규칙으로 보이고 숨으며 흐림을 지킨다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const last = closeOf(page, "칸 1");
  await expect(last).toBeDisabled();
  await page.mouse.move(0, 0);
  await expect.poll(() => closeOpacity(last)).toBe(0);
  const box = await boxOf(page.locator(".dock-tab-group").filter({ has: page.getByRole("button", { name: /^칸 1.* 닫기$/ }) }).getByRole("tab"));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => closeOpacity(last)).toBeCloseTo(0.35, 2);
});

test.describe("포인터 올리기가 없는 화면", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("닫기 버튼이 늘 보인다", async ({ page }) => {
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    for (const name of ["스크리너", "관심종목"]) await expect.poll(() => closeOpacity(closeOf(page, name))).toBe(1);
  });
});
