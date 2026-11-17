import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

test.use({ clockStart: "20261109100000" });

const NOV9 = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const SCREENS = path.resolve("../target/ux-screens");
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };

type Box = { x: number; y: number; width: number; height: number };

const workspace = (page: Page) => page.getByRole("main", { name: "작업 영역" });
const group = (page: Page, n: number) => page.locator("[data-dock-group]").nth(n - 1);
const tabs = (page: Page, n: number) => page.getByRole("tablist", { name: `창 묶음 ${n}` });
const tab = (page: Page, n: number, name: string) => tabs(page, n).getByRole("tab", { name: new RegExp(`^${name}`) });
const divider = (page: Page) => page.getByRole("separator", { name: "좌우 창 경계" });
const pageScroll = (page: Page) => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight]);
const currentSymbol = (topbar: Locator) => topbar.getByRole("button", { name: "종목·지표·명령 찾기", exact: true });
const bar = (t: number, c: number): Bar => ({ t, o: c, h: c, l: c, c, v: 1000 });

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

const inside = (inner: Box, outer: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const width = async (locator: Locator) => (await boxOf(locator)).width;

function twoCharts(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "cell-1", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "W", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

const savedDock = async (scenario: Scenario) => (scenario.documents.layout(DEFAULT_LAYOUT_ID).placement as { dock?: { root?: unknown } }).dock?.root;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("기본 레이아웃은 왼쪽 묶음에 차트, 오른쪽 묶음에 관심종목·스크리너·개체 목록 탭을 겹치지 않게 놓는다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("[data-dock-group]")).toHaveCount(2);
  await expect(tabs(page, 1).getByRole("tab")).toHaveCount(1);
  await expect(group(page, 1).getByRole("region", { name: /^칸 1: / })).toBeVisible();
  await expect(tabs(page, 2).getByRole("tab")).toHaveText([/^관심종목/, /^스크리너/, /^개체 목록/]);
  await expect(tab(page, 2, "관심종목")).toHaveAttribute("aria-selected", "true");
  await expect(group(page, 2).getByRole("complementary", { name: "관심종목" })).toBeVisible();
  await expect(tabs(page, 1).getByRole("tab")).toHaveAttribute("data-active-cell", "");

  const area = await boxOf(workspace(page));
  const left = await boxOf(group(page, 1));
  const right = await boxOf(group(page, 2));
  const topbar = await boxOf(page.getByRole("toolbar", { name: "차트 도구 막대" }));
  const footer = await boxOf(page.getByRole("contentinfo"));
  expect(inside(left, area) && inside(right, area)).toBe(true);
  expect(overlaps(left, right)).toBe(false);
  expect(left.x + left.width).toBeLessThan(right.x);
  expect(topbar.y + topbar.height).toBeLessThanOrEqual(area.y);
  expect(footer.y).toBeGreaterThanOrEqual(area.y + area.height);
  expect(footer.y + footer.height).toBeLessThanOrEqual(900);
  expect(await pageScroll(page)).toEqual([0, 0]);
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, "win-shell-default-1440x900.png") });
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(() => pageScroll(page)).toEqual([0, 0]);
  await page.screenshot({ path: path.join(SCREENS, "win-shell-default-1024x768.png") });
});

test("탭을 누르면 창 내용이 바뀌고 키보드로도 옮기며 새로고침 뒤에도 고른 탭이 남는다", async ({ page, scenario }) => {
  await page.goto("/");
  await tab(page, 2, "스크리너").click();
  await expect(tab(page, 2, "스크리너")).toHaveAttribute("aria-selected", "true");
  await expect(group(page, 2).getByRole("complementary", { name: "스크리너" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "관심종목" })).toHaveCount(0);
  await expect.poll(async () => JSON.stringify(await savedDock(scenario))).toContain('"active":"screener"');
  await page.reload();
  await expect(tab(page, 2, "스크리너")).toHaveAttribute("aria-selected", "true");
  await expect(group(page, 2).getByRole("complementary", { name: "스크리너" })).toBeVisible();

  await tab(page, 2, "스크리너").press("ArrowRight");
  await expect(tab(page, 2, "개체 목록")).toBeFocused();
  await expect(tab(page, 2, "개체 목록")).toHaveAttribute("aria-selected", "true");
  await expect(group(page, 2).getByRole("region", { name: "개체 목록" })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(tab(page, 2, "관심종목")).toBeFocused();
  await page.keyboard.press("End");
  await expect(tab(page, 2, "개체 목록")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, 2, "관심종목")).toHaveAttribute("aria-selected", "true");
});

test("경계를 끌면 두 묶음의 폭이 바뀌어 저장되고 최소 크기에서 멈춰 알리며 화살표로도 옮긴다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = [await width(group(page, 1)), await width(group(page, 2))];
  const handle = await boxOf(divider(page));
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y, { steps: 6 });
  await expect.poll(() => width(group(page, 1))).toBe(before[0]! - 120);
  expect(await savedDock(scenario)).toBeUndefined();
  await page.mouse.up();
  expect(await width(group(page, 2))).toBe(before[1]! + 120);
  await expect.poll(async () => JSON.stringify(await savedDock(scenario))).toContain('"kind":"split"');
  await page.reload();
  await expect.poll(() => width(group(page, 1))).toBe(before[0]! - 120);
  expect(await width(group(page, 2))).toBe(before[1]! + 120);

  const moved = await boxOf(divider(page));
  await page.mouse.move(moved.x + moved.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(1430, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: "오른쪽 창은 폭" })).toBeVisible();
  const narrowest = await width(group(page, 2));
  const least = Number(await divider(page).getAttribute("aria-valuemax"));
  expect(Number(await divider(page).getAttribute("aria-valuenow"))).toBe(least);
  expect(narrowest).toBeGreaterThanOrEqual(280);
  expect(narrowest).toBeLessThan(before[1]!);

  const wide = await width(group(page, 1));
  await divider(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => width(group(page, 1))).toBe(wide - 16);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => width(group(page, 1))).toBe(wide);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("status").filter({ hasText: "오른쪽 창은 폭" })).toBeVisible();
  expect(await width(group(page, 1))).toBe(wide);
});

test("차트 창 두 개는 각자 봉을 그리고, 실시간 봉은 그 종목의 차트에만 반영된다", async ({ page, scenario }) => {
  twoCharts(scenario);
  await page.goto("/");
  const first = cell(page, 1);
  const second = cell(page, 2);
  await expect(first).toHaveAttribute("aria-busy", "false");
  await expect(second).toHaveAttribute("aria-busy", "false");
  await expect(first).toHaveAttribute("aria-label", /삼성전자.* 일$/);
  await expect(second).toHaveAttribute("aria-label", /SK하이닉스.* 주$/);
  await expect.poll(async () => Number(await chartOf(first).getAttribute("data-bar-count"))).toBeGreaterThan(0);
  await expect.poll(async () => Number(await chartOf(second).getAttribute("data-bar-count"))).toBeGreaterThan(0);
  await expect(page.locator("[data-dock-group]")).toHaveCount(3);
  await expect.poll(() => scenario.live.subscriptions().map((s) => s.symbol).sort()).toEqual(["000660", "005930"]);
  const firstClose = await chartOf(first).getAttribute("data-last-close");
  scenario.live.bar("000660", bar(NOV9, 123_400));
  await expect(chartOf(second)).toHaveAttribute("data-last-close", "123400");
  expect(await chartOf(first).getAttribute("data-last-close")).toBe(firstClose);
  scenario.live.bar("005930", bar(NOV9, 56_700));
  await expect(chartOf(first)).toHaveAttribute("data-last-close", "56700");
  await expect(chartOf(second)).toHaveAttribute("data-last-close", "123400");
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, "win-shell-two-charts-1440x900.png") });
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(() => pageScroll(page)).toEqual([0, 0]);
  await page.screenshot({ path: path.join(SCREENS, "win-shell-two-charts-1024x768.png") });
});

test("둘째 차트를 누르면 위 막대·봉 주기·관심종목·드로잉 도구 막대·개체 목록이 둘째 차트를 따른다", async ({ page, scenario }) => {
  twoCharts(scenario);
  const lists = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: lists.lists.map((list, i) => (i === 0 ? { ...list, symbols: ["000810"] } : list)), revision: lists.revision + 1 });
  const drawing: DrawingInput = { id: "01900000-0000-7000-8000-0000000000c1", symbol: "000660", tool: "hline", points: [{ t: NOV9, price: 100_000 }], style: {}, text: null, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 0 };
  scenario.documents.saveDrawing(drawing);
  await page.goto("/");
  const first = cell(page, 1);
  const second = cell(page, 2);
  const topbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
  const periods = topbar.getByRole("group", { name: "봉 주기" });
  const toolbar = page.getByRole("navigation", { name: "드로잉 도구" });
  await expect(second).toHaveAttribute("aria-busy", "false");
  await expect(currentSymbol(topbar)).toContainText("삼성전자");
  expect(inside(await boxOf(toolbar), await boxOf(group(page, 1)))).toBe(true);

  await tab(page, 3, "개체 목록").click();
  const objects = page.getByRole("region", { name: "개체 목록" });
  await expect(objects).toContainText(/005930 드로잉\s*0/);
  const area = await boxOf(second);
  await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
  await expect(currentSymbol(topbar)).toContainText("SK하이닉스");
  await expect(periods.getByRole("button", { name: "주", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(tab(page, 2, "SK하이닉스")).toHaveAttribute("data-active-cell", "");
  await expect(tab(page, 1, "삼성전자")).not.toHaveAttribute("data-active-cell", "");
  await expect(objects).toContainText(/000660 드로잉\s*1/);
  const bar = await boxOf(toolbar);
  const chartGroup = await boxOf(group(page, 2));
  expect(inside(bar, chartGroup)).toBe(true);
  expect(Math.abs(bar.x + bar.width / 2 - (chartGroup.x + chartGroup.width / 2))).toBeLessThanOrEqual(2);

  await tab(page, 1, "삼성전자").click();
  await expect(currentSymbol(topbar)).toContainText("삼성전자");
  await expect(tab(page, 1, "삼성전자")).toHaveAttribute("data-active-cell", "");
  await tab(page, 2, "SK하이닉스").click();
  await expect(currentSymbol(topbar)).toContainText("SK하이닉스");

  await periods.getByRole("button", { name: "월", exact: true }).click();
  await expect(second).toHaveAttribute("aria-label", /SK하이닉스.* 월$/);
  await expect(first).toHaveAttribute("aria-label", /삼성전자.* 일$/);

  await tab(page, 3, "관심종목").click();
  await page.getByRole("complementary", { name: "관심종목" }).locator('li[data-code="000810"] [data-main]').click();
  await expect(second).toHaveAttribute("aria-label", /^칸 2: 삼성화재/);
  await expect(first).toHaveAttribute("aria-label", /^칸 1: 삼성전자/);
  await expect(currentSymbol(topbar)).toContainText("삼성화재");
});

test("한 묶음에 쌓인 차트 탭 가운데 고른 탭이 새로고침 뒤에도 활성 칸이고 위 막대와 단축키가 그 차트에 적용된다", async ({ page, scenario }) => {
  twoCharts(scenario);
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const side = layout.windows.filter((w) => w.kind !== "chart").map((w) => w.id);
  const root = { kind: "split", dir: "row", ratio: 0.72, first: { kind: "group", id: "g1", tabs: ["cell-0", "cell-1"], active: "cell-0" }, second: { kind: "group", id: "g2", tabs: side, active: side[0] } };
  scenario.documents.saveLayout({ ...layout, placement: { v: 1, dock: { root, floats: [] }, canvas: null }, revision: layout.revision + 1 });
  await page.goto("/");
  const topbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
  await tab(page, 1, "SK하이닉스").click();
  await expect(currentSymbol(topbar)).toContainText("SK하이닉스");
  await expect.poll(async () => JSON.stringify(await savedDock(scenario))).toContain('"active":"cell-1"');
  await page.reload();
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect(currentSymbol(topbar)).toContainText("SK하이닉스");
  await expect(tab(page, 1, "SK하이닉스")).toHaveAttribute("data-active-cell", "");
  await expect(page.getByRole("navigation", { name: "드로잉 도구" })).toHaveCount(1);
  await cell(page, 2).focus();
  await page.keyboard.press("KeyM");
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /월$/);
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((w) => w.id === "cell-0")).toMatchObject({ period: "D" });
});

test("지표 창 방식이 차트 옆이면 지표 버튼이 지표 창을 보이고, 가운데 창으로 되돌리면 가운데 창을 연다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const topbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
  const settings = page.getByRole("dialog", { name: "차트 설정", exact: true });
  await topbar.getByRole("button", { name: "차트 설정", exact: true }).click();
  await settings.getByRole("button", { name: "차트 옆", exact: true }).click();
  await settings.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(tabs(page, 2).getByRole("tab", { name: /^지표/ })).toHaveCount(0);
  await topbar.getByRole("button", { name: "지표", exact: true }).click();
  await expect(tab(page, 2, "지표")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox", { name: "지표·비교 찾기" })).toBeFocused();
  await expect(page.getByRole("dialog", { name: "지표·비교 입력창", exact: true })).toHaveCount(0);

  await topbar.getByRole("button", { name: "차트 설정", exact: true }).click();
  await settings.getByRole("button", { name: "가운데 창", exact: true }).click();
  await settings.getByRole("button", { name: "닫기", exact: true }).click();
  await tab(page, 2, "관심종목").click();
  await topbar.getByRole("button", { name: "지표", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "지표·비교 입력창", exact: true })).toBeVisible();
  await expect(tab(page, 2, "관심종목")).toHaveAttribute("aria-selected", "true");
});

test("범례 지표 설정 팝오버는 처음 열 때와 창 크기가 바뀐 뒤에도 자기 줄 아래에 있어 그 줄의 숨기기를 누를 수 있다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings = { v: 2, style: "candle", scale: "normal", compare: [], panels: [{ id: "p-rsi", stretch: 0.25 }], indicators: [
    { id: "ma", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } },
    { id: "rsi", spec: { kind: "rsi", period: 14, signal: null }, panel: "p-rsi", visible: true, style: { colors: ["ind-2"], width: 1 } },
  ] };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: layout.windows.map((w) => (w.kind === "chart" ? { ...w, symbol: "005930", venue: "combined", period: "D", chartSettings } : w)) });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const row = cell(page).locator('[data-indicator-row="ma"]');
  await row.getByRole("button", { name: /설정 열기/ }).click();
  const popup = page.getByRole("dialog", { name: /설정$/ });
  const below = async () => (await boxOf(popup)).y - ((await boxOf(row)).y + (await boxOf(row)).height);
  await expect.poll(below).toBeGreaterThanOrEqual(0);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(below).toBeGreaterThanOrEqual(0);
  await row.getByRole("button", { name: /숨기기/ }).click();
  await expect(popup).toHaveCount(0);
  await expect(row.getByRole("button", { name: /보이기/ })).toHaveCount(1);
});

test("Alt+W는 관심종목 탭을 고른다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await tab(page, 2, "개체 목록").click();
  await cell(page).focus();
  await page.keyboard.press("Alt+KeyW");
  await expect(tab(page, 2, "관심종목")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("complementary", { name: "관심종목" })).toBeVisible();
});

test("작은 데스크톱 창에서도 문서가 넘치지 않는다", async ({ page, scenario }) => {
  twoCharts(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 300 }]) {
    await page.setViewportSize(size);
    await expect.poll(() => pageScroll(page)).toEqual([0, 0]);
    const area = await boxOf(workspace(page));
    for (const n of [1, 2, 3]) expect(inside(await boxOf(group(page, n)), area)).toBe(true);
  }
});

test("휴대폰 화면은 머리·봉 주기 칩·차트·아래 탭을 그대로 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "봉 주기" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "휴대폰 탭" })).toBeVisible();
  await expect(cell(page)).toBeVisible();
  await expect(workspace(page)).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: /^창 묶음/ })).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "차트 도구 막대" })).toBeHidden();
  await expect(page.getByRole("contentinfo")).toBeHidden();
  expect(await pageScroll(page)).toEqual([0, 0]);
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, "win-shell-phone-390x844.png") });
});
