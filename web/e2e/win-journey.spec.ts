import type { Locator, Page, TestInfo } from "@playwright/test";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { Bar } from "../src/api/generated/Bar";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { toChartTime } from "../src/chart/time";
import { windowId } from "../src/layout/kinds";
import { type DockNode, parsePlacement } from "../src/layout/placement";
import { installChartProbe } from "./chart-probe";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, type Scenario, test, pollSaved } from "./harness";

test.use({ clockStart: "20261109100000", actionTimeout: 10_000 });
test.describe.configure({ mode: "parallel" });

const MODES = ["dock", "canvas"] as const;
const VIEWPORTS = [{ width: 1024, height: 768 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1280, height: 300 }];
const SHOTS = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }] as const;
const NOV9 = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 40 };
const topbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const layoutButton = (page: Page) => topbar(page).getByRole("button", { name: /^레이아웃:/ });
const layoutMenu = (page: Page) => page.getByRole("menu", { name: "레이아웃", exact: true });
const tab = (page: Page, id: string) => page.locator(`[role=tab][data-window-id="${id}"]`);
const head = (page: Page, id: string) => page.locator(`[data-window-header="${id}"]`);
const frame = (page: Page, id: string) => page.locator(`[data-canvas-window="${id}"], [data-dock-float="${id}"]`);
const group = (page: Page, id: string) => page.locator("[data-dock-group]").filter({ has: tab(page, id) });
const placement = (scenario: Scenario, id = DEFAULT_LAYOUT_ID) => parsePlacement(scenario.documents.layout(id).placement);
const windows = (scenario: Scenario) => scenario.documents.layout().windows;
const charts = (scenario: Scenario) => windows(scenario).filter((window) => window.kind === "chart");
const chartWindow = (id: string, symbol = "005930"): LayoutWindow => ({ id, kind: "chart", link: null, symbol, venue: "combined", period: "D", chartSettings: SETTINGS });
const bar = (price: number): Bar => ({ t: NOV9, o: price, h: price + 100, l: price - 100, c: price, v: 1200 });

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("작업 영역의 요소가 보이지 않습니다");
  return box;
}

function seed(scenario: Scenario, count = 2, mode: typeof MODES[number] = "dock", sideWindows = true) {
  const base = scenario.documents.layout();
  const next = [...Array.from({ length: count }, (_, i) => chartWindow(`cell-${i}`)), ...(sideWindows ? base.windows.filter((window) => window.kind !== "chart") : [])];
  scenario.documents.saveLayout({ ...base, windows: next, placement: {}, revision: base.revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: mode });
  const watchlists = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ ...watchlists, lists: watchlists.lists.map((list) => ({ ...list, symbols: ["035420", "000660"] })) });
}

async function ready(page: Page, count = 1) {
  for (let n = 1; n <= count; n++) {
    await expect(cell(page, n)).toHaveAttribute("aria-busy", "false");
    await expect(chartOf(cell(page, n))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  }
}

async function setMode(page: Page, next: typeof MODES[number]) {
  await layoutButton(page).click();
  const button = page.getByRole("group", { name: "창 배치 방식" }).getByRole("button", { name: next === "dock" ? "도킹" : "캔버스", exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
}

async function chooseLayout(page: Page, name: string) {
  await layoutButton(page).click();
  await layoutMenu(page).getByRole("menuitemradio", { name, exact: true }).click();
  await expect(layoutButton(page)).toHaveAccessibleName(`레이아웃: ${name}`);
}

async function addChart(page: Page) {
  await topbar(page).getByRole("button", { name: "창 더하기", exact: true }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^차트/ }).click();
}

async function drag(page: Page, source: Locator, to: { x: number; y: number }, drop = true) {
  const box = await boxOf(source);
  await page.mouse.move(box.x + Math.min(60, box.width / 2), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  if (drop) await page.mouse.up();
}

async function detach(page: Page, id: string) {
  await tab(page, id).press("Shift+F10");
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "띄우기", exact: true }).click();
  await expect(head(page, id)).toBeVisible();
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function atSizes(page: Page, testInfo: TestInfo, name: string) {
  for (const size of SHOTS) {
    await page.setViewportSize(size);
    await shot(page, testInfo, `${name}-${size.width}x${size.height}`);
  }
  await page.setViewportSize(SHOTS[0]);
}

async function linked(page: Page, id: string) {
  const actual = await head(page, id).count() ? head(page, id).getByRole("button", { name: /^연동 색:/ }) : tab(page, id).locator("+ .link-dot");
  await expect(actual).toHaveAccessibleName("연동 색: 끔");
  await chooseLink(page, actual, "A");
  await expect(actual).toHaveAccessibleName("연동 색: A");
}

async function noScroll(page: Page) {
  await expect.poll(() => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight])).toEqual([0, 0]);
}

async function within(inner: Locator, outer: Locator) {
  const a = await boxOf(inner), b = await boxOf(outer);
  expect(a.x).toBeGreaterThanOrEqual(b.x - 1);
  expect(a.y).toBeGreaterThanOrEqual(b.y - 1);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1);
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + b.height + 1);
}

async function tabTo(page: Page, target: Locator, key: "Tab" | "Shift+Tab" = "Tab") {
  for (let step = 0; step < 240; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      await expect(target).toBeInViewport({ ratio: 1 });
      return;
    }
    await page.keyboard.press(key);
  }
  throw new Error(`Tab으로 ${await target.getAttribute("aria-label")}에 닿지 못했습니다`);
}

async function exposed(target: Locator) {
  await expect.poll(() => target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
}

function chartGrid(ids: string[]): DockNode {
  if (ids.length === 1) {
    const id = windowId(ids[0]!);
    return { kind: "group", id: `group-${id}`, tabs: [id], active: id };
  }
  const half = Math.ceil(ids.length / 2);
  return { kind: "split", dir: ids.length > 4 ? "column" : "row", ratio: half / ids.length, first: chartGrid(ids.slice(0, half)), second: chartGrid(ids.slice(half)) };
}

test("하루의 창 편집을 두 방식과 이름 저장·다시 열기·새로고침으로 이어간다", async ({ page, scenario }, testInfo) => {
  seed(scenario, 1);
  await page.goto("/");
  await ready(page);
  await addChart(page);
  await addChart(page);
  await pollSaved(() => charts(scenario).length).toBe(3);
  const added = charts(scenario).filter((window) => window.id !== "cell-0");
  const first = added[0], second = added[1];
  if (!first || !second) throw new Error("더한 차트 창을 찾지 못했습니다");
  await ready(page, 3);
  const target = await boxOf(group(page, "cell-0"));
  await drag(page, tab(page, second.id), { x: target.x + target.width / 2, y: target.y + target.height - 45 }, false);
  await expect(page.locator("[data-dock-preview]")).toContainText("아래에 나눠 놓기");
  await page.mouse.up();
  expect((await boxOf(group(page, second.id))).y).toBeGreaterThan((await boxOf(group(page, "cell-0"))).y);
  await linked(page, "watchlist");
  await linked(page, "cell-0");
  await linked(page, first.id);
  await page.getByRole("complementary", { name: "관심종목" }).locator('li[data-code="035420"] [data-main]').click();
  await expect(cell(page)).toHaveAttribute("aria-label", /NAVER/);
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /NAVER/);
  await detach(page, "screener");
  await pollSaved(() => placement(scenario).dock?.floats.length).toBe(1);
  const dock = placement(scenario).dock;
  await setMode(page, "canvas");
  await expect(frame(page, "cell-0")).toBeVisible();
  const source = await boxOf(head(page, "cell-0"));
  await drag(page, head(page, first.id), { x: source.x + 100, y: source.y + 60 });
  await expect(page.getByRole("button", { name: /^가지런히/ }).locator(".ui-badge")).toHaveCount(1);
  await page.getByRole("button", { name: /^가지런히/ }).click();
  await expect(page.getByRole("button", { name: /^가지런히/ }).locator(".ui-badge")).toHaveCount(0);
  await pollSaved(() => placement(scenario).canvas).not.toBeNull();
  await layoutButton(page).click();
  await layoutMenu(page).getByRole("menuitem", { name: "새 이름으로 저장…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새 이름으로 저장", exact: true });
  await dialog.getByRole("textbox", { name: "레이아웃 이름" }).fill("복기");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  const copy = scenario.documents.layoutSummaries().find((entry) => entry.name === "복기");
  if (!copy) throw new Error("저장한 복기 레이아웃이 없습니다");
  await pollSaved(() => scenario.documents.layout(copy.id).windows.filter((window) => window.kind === "chart").map((window) => ({ id: window.id, symbol: window.symbol, link: window.link }))).toEqual([
    { id: "cell-0", symbol: "035420", link: "a" },
    { id: first.id, symbol: "035420", link: "a" },
    { id: second.id, symbol: "005930", link: null },
  ]);
  const expected = scenario.documents.layout(copy.id);
  expect(expected.windows.map((window) => window.kind)).toEqual(["chart", "watchlist", "screener", "chart", "chart"]);
  expect(parsePlacement(expected.placement).dock).toEqual(dock);
  expect(parsePlacement(expected.placement).canvas?.order).toHaveLength(5);
  await chooseLayout(page, "기본");
  await chooseLayout(page, "복기");
  await page.reload();
  await ready(page, 3);
  await expect(layoutButton(page)).toHaveAccessibleName("레이아웃: 복기");
  await expect(cell(page)).toHaveAttribute("aria-label", /NAVER/);
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /NAVER/);
  await expect(cell(page, 3)).toHaveAttribute("aria-label", /삼성전자/);
  expect(scenario.documents.layout(copy.id).windows).toEqual(expected.windows);
  expect(placement(scenario, copy.id)).toEqual(parsePlacement(expected.placement));
  for (const id of ["watchlist", "cell-0", first.id]) await expect(head(page, id).getByRole("button", { name: "연동 색: A" })).toBeVisible();
  await setMode(page, "dock");
  await expect(frame(page, "screener")).toBeVisible();
  await ready(page, 3);
  expect(placement(scenario, copy.id).dock).toEqual(dock);
  await shot(page, testInfo, "day-restored-dock");
});

test("숨긴 연동 차트와 창 범위 드로잉은 떠 있는 창과 캔버스를 거쳐 같은 창을 따른다", async ({ page, scenario }, testInfo) => {
  seed(scenario);
  const base = scenario.documents.layout();
  scenario.documents.saveLayout({ ...base, windows: base.windows.map((window) => ["cell-0", "cell-1", "watchlist"].includes(window.id) ? { ...window, link: "a" } : window), placement: { v: 1, canvas: null, dock: { root: { kind: "split", dir: "row", ratio: .72, first: { kind: "group", id: "charts", tabs: ["cell-0", "cell-1"], active: "cell-0" }, second: { kind: "group", id: "side", tabs: ["watchlist", "screener"], active: "watchlist" } }, floats: [] } } });
  const drawingId = "01900000-0000-7000-8000-0000000000d8";
  scenario.documents.saveDrawing({ id: drawingId, symbol: "035420", tool: "hline", points: [{ t: NOV9, price: 70_000 }], style: {}, text: null, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: "cell-1" }, revision: 1 });
  await page.goto("/");
  await ready(page);
  await page.getByRole("complementary", { name: "관심종목" }).locator('li[data-code="035420"] [data-main]').click();
  await expect(tab(page, "cell-1")).toContainText("NAVER");
  await expect(tab(page, "cell-1")).toHaveAttribute("aria-selected", "false");
  await pollSaved(() => charts(scenario).map((window) => window.symbol)).toEqual(["035420", "035420"]);
  await tab(page, "cell-1").click();
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await expect(chartOf(cell(page, 2)).locator(".drawing-mirror")).toHaveAttribute("data-drawings", new RegExp(drawingId));
  const other = await boxOf(group(page, "watchlist"));
  await drag(page, tab(page, "cell-1"), { x: other.x + 40, y: other.y + other.height / 2 });
  await expect(chartOf(cell(page, 2)).locator(".drawing-mirror")).toHaveAttribute("data-drawings", new RegExp(drawingId));
  await detach(page, "cell-1");
  await expect(chartOf(cell(page, 2)).locator(".drawing-mirror")).toHaveAttribute("data-drawings", new RegExp(drawingId));
  await expect(head(page, "cell-1").getByRole("button", { name: "연동 색: A" })).toBeVisible();
  await chooseLink(page, head(page, "cell-1").getByRole("button", { name: "연동 색: A" }), "B");
  await expect(head(page, "cell-1").getByRole("button", { name: "연동 색: B" })).toBeVisible();
  await atSizes(page, testInfo, "dock-float");
  await setMode(page, "canvas");
  await ready(page, 2);
  await expect(head(page, "cell-1").getByRole("button", { name: "연동 색: B" })).toBeVisible();
  await chooseLink(page, head(page, "cell-1").getByRole("button", { name: "연동 색: B" }), "C");
  await expect(head(page, "cell-1").getByRole("button", { name: "연동 색: C" })).toBeVisible();
  await expect(chartOf(cell(page, 2)).locator(".drawing-mirror")).toHaveAttribute("data-drawings", new RegExp(drawingId));
  await expect(chartOf(cell(page)).locator(".drawing-mirror")).not.toHaveAttribute("data-drawings", new RegExp(drawingId));
  const firstHead = await boxOf(head(page, "cell-0"));
  await drag(page, head(page, "cell-1"), { x: firstHead.x + 100, y: firstHead.y + 65 });
  await atSizes(page, testInfo, "canvas-overlap");
  await frame(page, "cell-1").getByRole("button", { name: "차트 닫기" }).click();
  await expect(frame(page, "cell-1")).toHaveCount(0);
  await expect(head(page, "cell-0")).toBeFocused();
  await exposed(head(page, "cell-0"));
  await pollSaved(() => scenario.documents.drawings("035420")[0]?.scope).toEqual({ kind: "layout", layoutId: DEFAULT_LAYOUT_ID });
  await expect(chartOf(cell(page)).locator(".drawing-mirror")).toHaveAttribute("data-drawings", new RegExp(drawingId));
});

for (const mode of MODES) {
  test(`${mode}: 차트 여덟 개에 봉·실시간·십자선이 함께 작동하고 아홉째는 거절한다`, async ({ page, scenario }) => {
    seed(scenario, 8, mode, false);
    const base = scenario.documents.layout();
    scenario.documents.saveLayout({ ...base, placement: { v: 1, dock: { root: chartGrid(base.windows.map((window) => window.id)), floats: [] }, canvas: null } });
    const bars = Array.from({ length: 80 }, (_, i) => ({ ...bar(70_000 + i * 10), t: NOV9 - (79 - i) * 86400 }));
    scenario.reply("/api/bars", { body: { symbol: "005930", venue: "combined", period: "D", bars, current: null, nextBefore: null, seq: null } satisfies BarsPage });
    await page.addInitScript(installChartProbe);
    await page.goto("/");
    await ready(page, 8);
    if (mode === "canvas") await page.getByRole("button", { name: /^가지런히/ }).click();
    await pollSaved(() => scenario.live.subscriptions().length).toBe(8);
    expect(scenario.live.bar("005930", bar(88_800))).toBe(8);
    for (let n = 1; n <= 8; n++) await expect(chartOf(cell(page, n))).toHaveAttribute("data-last-close", "88800");
    await expect.poll(() => page.evaluate(() => window.chartProbes?.length)).toBe(8);
    const point = await page.evaluate((time) => {
      const probe = window.chartProbes.find((item) => item.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
      if (!probe) throw new Error("십자선을 보낼 차트가 없습니다");
      const x = probe.chart.timeScale().timeToCoordinate(time);
      const rect = probe.chart.chartElement().getBoundingClientRect();
      if (x === null) throw new Error("십자선을 보낼 봉이 없습니다");
      return { x: rect.x + x, y: rect.y + rect.height * .65 };
    }, toChartTime(NOV9 - 86400));
    await page.mouse.move(point.x, point.y);
    for (let n = 2; n <= 8; n++) await expect(chartOf(cell(page, n)).locator("[data-synced-crosshair]")).toBeVisible();
    await topbar(page).getByRole("button", { name: "창 더하기", exact: true }).click();
    await expect(page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^차트/ })).toBeDisabled();
    await page.keyboard.press("Escape");
    if (mode === "canvas") await expect(page.getByRole("navigation", { name: "창 종류" }).getByRole("button", { name: "차트 창 더하기" })).toBeDisabled();
    expect(charts(scenario)).toHaveLength(8);
  });

  test(`${mode}: 지표 버튼은 기존 창을 드러내고 활성 칸의 내용을 따른다`, async ({ page, scenario }) => {
    seed(scenario, 2, mode);
    scenario.documents.saveUiState({ ...scenario.documents.uiState(), indicatorWindow: "inspector" });
    await page.goto("/");
    await ready(page, 2);
    await topbar(page).getByRole("button", { name: "지표", exact: true }).click();
    const inspector = page.getByRole("region", { name: "지표", exact: true });
    await expect(inspector).toBeVisible();
    await inspector.getByRole("searchbox").fill("이평 9");
    await inspector.getByRole("button", { name: "이동평균 단순 9 추가", exact: true }).click();
    await inspector.getByRole("searchbox").fill("");
    await expect(cell(page).getByRole("button", { name: "이동평균 단순 9 설정 열기", exact: true })).toBeVisible();
    if (mode === "dock") await tab(page, "cell-1").click();
    else await head(page, "cell-1").click({ position: { x: 60, y: 17 } });
    await topbar(page).getByRole("button", { name: "지표", exact: true }).click();
    await expect(inspector.getByRole("button", { name: "이동평균 단순 9 설정", exact: true })).toHaveCount(0);
    if (mode === "dock") await tab(page, "cell-0").click();
    else await head(page, "cell-0").click({ position: { x: 60, y: 17 } });
    await topbar(page).getByRole("button", { name: "지표", exact: true }).click();
    await expect(inspector.getByRole("button", { name: "이동평균 단순 9 설정", exact: true })).toBeVisible();
    if (mode === "dock") {
      await detach(page, "indicators");
      await detach(page, "screener");
      await pollSaved(() => placement(scenario).dock?.floats.at(-1)?.window).toBe("screener");
      await topbar(page).getByRole("button", { name: "지표", exact: true }).click();
      await pollSaved(() => placement(scenario).dock?.floats.at(-1)?.window).toBe("indicators");
    } else {
      await head(page, "watchlist").click({ position: { x: 60, y: 17 } });
      await topbar(page).getByRole("button", { name: "지표", exact: true }).click();
      await pollSaved(() => placement(scenario).canvas?.order.at(-1)).toBe("indicators");
    }
  });

  test(`${mode}: 끄는 중 저장 실패에도 배치를 지키고 다시 시도로 마지막 배치를 저장한다`, async ({ page, scenario }) => {
    seed(scenario, 1, mode);
    await page.goto("/");
    await ready(page);
    const pending = scenario.hold((url, request) => url.pathname === `/api/layouts/${DEFAULT_LAYOUT_ID}` && request.method() === "PUT");
    await topbar(page).getByRole("button", { name: "주", exact: true }).click();
    await pollSaved(() => scenario.requests.filter((request) => request.method() === "PUT" && new URL(request.url()).pathname === `/api/layouts/${DEFAULT_LAYOUT_ID}`).length).toBeGreaterThan(0);
    await pending.received;
    const source = mode === "dock" ? tab(page, "screener") : head(page, "watchlist");
    const original = await boxOf(mode === "dock" ? group(page, "screener") : frame(page, "watchlist"));
    const target = await boxOf(mode === "dock" ? group(page, "cell-0") : head(page, "cell-0"));
    await drag(page, source, { x: target.x + 150, y: target.y + target.height / 2 }, false);
    const draft = mode === "dock" ? page.locator("[data-dock-preview]") : frame(page, "watchlist");
    const dragging = await boxOf(draft);
    pending.reply({ status: 503, body: { error: { code: "internal", message: "저장 연결 끊김" } } });
    await expect(page.getByRole("contentinfo")).toContainText("저장하지 못했습니다");
    expect(await boxOf(draft)).toEqual(dragging);
    await page.mouse.up();
    const moved = await boxOf(mode === "dock" ? group(page, "screener") : frame(page, "watchlist"));
    expect(moved).not.toEqual(original);
    await expect(page.getByRole("contentinfo")).toContainText("저장하지 못했습니다");
    if (mode === "canvas") await page.getByRole("navigation", { name: "창 종류" }).getByRole("button", { name: "지표 창 더하기" }).click();
    else {
      await topbar(page).getByRole("button", { name: "창 더하기", exact: true }).click();
      await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^지표/ }).click();
    }
    await page.getByRole("button", { name: "지표 닫기", exact: true }).click();
    await expect.poll(() => page.getByRole("button", { name: "지표 닫기", exact: true }).count()).toBe(0);
    await expect(page.getByRole("contentinfo")).toContainText("저장하지 못했습니다");
    scenario.on((url, request) => url.pathname === `/api/layouts/${DEFAULT_LAYOUT_ID}` && request.method() === "PUT", (request) => ({ body: scenario.documents.saveLayout(request.postDataJSON()) }));
    await page.getByRole("contentinfo").getByRole("button", { name: "다시 시도" }).click();
    await expect(page.getByRole("contentinfo")).toContainText("자동 저장됨");
    expect(await boxOf(mode === "dock" ? group(page, "screener") : frame(page, "watchlist"))).toEqual(moved);
    expect(windows(scenario).map((window) => window.kind)).toEqual(["chart", "watchlist", "screener"]);
    const saved = placement(scenario);
    await page.reload();
    await ready(page);
    expect(await boxOf(mode === "dock" ? group(page, "screener") : frame(page, "watchlist"))).toEqual(moved);
    expect(placement(scenario)).toEqual(saved);
  });

  test(`${mode}: 다른 탭의 더 새 저장 순서는 오래된 창 편집을 덮어쓰지 않는다`, async ({ page, context, scenario }) => {
    seed(scenario, 1, mode);
    await page.goto("/");
    await ready(page);
    const second = await context.newPage();
    await second.clock.install({ time: new Date("2030-01-01T00:00:00+09:00") });
    await second.goto("/");
    await ready(second);
    await topbar(second).getByRole("button", { name: "주", exact: true }).click();
    await pollSaved(() => charts(scenario)[0]?.period).toBe("W");
    const stale = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/layouts/${DEFAULT_LAYOUT_ID}` && response.request().method() === "PUT" && response.status() === 409);
    await topbar(page).getByRole("button", { name: "월", exact: true }).click();
    expect(await (await stale).json()).toMatchObject({ error: { code: "stale_revision" } });
    await expect(page.getByRole("contentinfo")).toContainText("저장하지 못했습니다");
    expect(charts(scenario)[0]?.period).toBe("W");
    await expect(cell(page)).toHaveAttribute("aria-label", / 월$/);
    await expect.poll(() => page.evaluate(() => {
      const raw = localStorage.getItem("vv.unsaved.layout");
      return raw ? JSON.parse(raw).body : null;
    })).toContain('"period":"M"');
    await page.reload();
    await expect(cell(page)).toHaveAttribute("aria-label", / 주$/);
    await second.close();
  });

  test(`${mode}: 빈 옛 placement는 기본으로 열고 첫 배치 편집을 새 모양으로 저장한다`, async ({ page, scenario }) => {
    seed(scenario, 1, mode);
    await page.goto("/");
    await ready(page);
    const source = mode === "dock" ? tab(page, "screener") : head(page, "watchlist");
    await expect(source).toBeVisible();
    const before = scenario.requests.filter((request) => request.method() === "PUT" && new URL(request.url()).pathname === `/api/layouts/${DEFAULT_LAYOUT_ID}`);
    if (mode === "dock") expect(before).toHaveLength(0);
    if (mode === "dock") await tab(page, "screener").click();
    else await head(page, "watchlist").press("ArrowLeft");
    await pollSaved(() => placement(scenario)[mode]).not.toBeNull();
    expect(scenario.documents.layout().placement).toMatchObject({ v: 1 });
    const saved = placement(scenario);
    await page.reload();
    await ready(page);
    expect(placement(scenario)).toEqual(saved);
  });

  for (const viewport of VIEWPORTS) {
    test(`${mode}: ${viewport.width}x${viewport.height}에서 위 막대·드로잉·창 머리를 모두 쓴다`, async ({ page, scenario }, testInfo) => {
      seed(scenario, 1, mode);
      await page.setViewportSize(viewport);
      await page.goto("/");
      await ready(page);
      await noScroll(page);
      const area = page.getByRole("main", { name: "작업 영역" });
      const headers = mode === "dock" ? page.getByRole("tablist", { name: /^창 묶음 / }) : page.locator("[data-window-header]");
      for (const item of await headers.all()) await within(item, area);
      for (const button of await topbar(page).getByRole("button").all()) {
        if (!await button.isVisible() || !await button.isEnabled()) continue;
        await within(button, topbar(page));
        await button.click({ trial: true });
      }
      await topbar(page).getByRole("button", { name: "창 더하기", exact: true }).click();
      await expect(page.getByRole("menu", { name: "창 더하기" })).toBeVisible();
      await page.keyboard.press("Escape");
      await layoutButton(page).click();
      await expect(layoutMenu(page)).toBeVisible();
      await page.keyboard.press("Escape");
      const tools = page.getByRole("navigation", { name: "드로잉 도구" });
      await tools.hover();
      await expect(tools.getByRole("button", { name: "드로잉 단축키 도움말" })).toBeVisible();
      for (const button of await tools.getByRole("button").all()) {
        if (!await button.isVisible() || !await button.isEnabled()) continue;
        await button.scrollIntoViewIfNeeded();
        await button.click({ trial: true });
      }
      await tools.getByRole("button", { name: "드로잉 단축키 도움말" }).click();
      await expect(page.getByRole("dialog", { name: "드로잉 단축키" })).toBeVisible();
      await page.keyboard.press("Escape");
      await noScroll(page);
      if (viewport.width !== 1280) await shot(page, testInfo, `${mode}-basic-${viewport.width}x${viewport.height}`);
    });
  }

  test(`${mode}: 차트 넷과 옆 창의 배치를 두 화면 크기로 기록한다`, async ({ page, scenario }, testInfo) => {
    seed(scenario, 4, mode);
    await page.goto("/");
    await ready(page, mode === "dock" ? 3 : 4);
    if (mode === "dock") {
      await page.locator("#window-tab-cell-3").click();
      await expect(cell(page, 4)).toHaveAttribute("aria-busy", "false");
      await expect(chartOf(cell(page, 4))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
    }
    if (mode === "canvas") await page.getByRole("button", { name: /^가지런히/ }).click();
    await atSizes(page, testInfo, `${mode}-four-charts`);
    await noScroll(page);
  });
}

test("기본 휴대폰 화면과 데스크톱 캔버스의 여러 차트는 활성 칸 하나를 그린다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await ready(page);
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 코스피 일");
  await expect(topbar(page)).toBeHidden();
  await expect(page.getByRole("tablist", { name: /^창 묶음 / })).toHaveCount(0);
  await noScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  seed(scenario, 3, "canvas");
  await page.goto("/");
  await ready(page, 3);
  await setMode(page, "canvas");
  await head(page, "cell-2").click({ position: { x: 60, y: 17 } });
  await expect(frame(page, "cell-2")).toHaveAttribute("data-active-cell", "");
  const before = placement(scenario);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cell(page, 3)).toBeVisible();
  await expect(chartOf(cell(page, 3))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await expect(topbar(page)).toBeHidden();
  await expect(page.locator("[data-canvas-window]")).toHaveCount(0);
  await noScroll(page);
  expect(placement(scenario)).toEqual(before);
  await page.reload();
  await expect(page.locator('section[aria-label^="칸 "]')).toHaveCount(1);
  await expect(chartOf(page.locator('section[aria-label^="칸 "]'))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
});

test("키보드만으로 창 더하기·탭·나누기·경계·캔버스·닫기·레이아웃을 이어 쓴다", async ({ page, scenario }) => {
  seed(scenario, 1);
  const base = scenario.documents.layout();
  scenario.documents.saveLayout({ ...base, id: "01900000-0000-7000-8000-0000000000b8", name: "복기" });
  await page.goto("/");
  await ready(page);
  await tabTo(page, topbar(page).getByRole("button", { name: "창 더하기", exact: true }));
  await page.keyboard.press("Enter");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await pollSaved(() => charts(scenario).length).toBe(2);
  const added = charts(scenario).find((window) => window.id !== "cell-0");
  if (!added) throw new Error("키보드로 더한 창이 없습니다");
  await tabTo(page, tab(page, "watchlist"));
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "screener")).toBeFocused();
  await page.keyboard.press("Shift+F10");
  const down = page.getByRole("menuitem", { name: "아래에 나눠 놓기", exact: true });
  for (let i = 0; i < 6 && !await down.evaluate((element) => element === document.activeElement); i++) await page.keyboard.press("ArrowDown");
  await expect(down).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tab(page, "screener")).toBeFocused();
  const divider = page.getByRole("separator", { name: "좌우 창 경계" }).first();
  await tabTo(page, divider);
  const old = Number(await divider.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBe(old - 16);
  await tabTo(page, layoutButton(page));
  await page.keyboard.press("Enter");
  await expect(layoutMenu(page).getByRole("menuitemradio").first()).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("group", { name: "창 배치 방식" }).getByRole("button", { name: "캔버스", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await tabTo(page, head(page, added.id));
  await exposed(head(page, added.id));
  const before = await boxOf(frame(page, added.id));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  const moved = await boxOf(frame(page, added.id));
  expect(moved.x).toBeGreaterThan(before.x);
  expect(moved.width).toBeGreaterThan(before.width);
  await expect(head(page, added.id)).toBeFocused();
  await expect(head(page, added.id)).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(frame(page, added.id).getByRole("button", { name: "차트 닫기" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(frame(page, added.id)).toHaveCount(0);
  await expect(page.locator(":focus")).toBeVisible();
  await expect(page.locator(":focus")).not.toHaveJSProperty("tagName", "BODY");
  await tabTo(page, layoutButton(page));
  await page.keyboard.press("Enter");
  await expect(layoutMenu(page).getByRole("menuitemradio").first()).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(layoutButton(page)).toHaveAccessibleName("레이아웃: 복기");
  await expect(layoutButton(page)).toBeFocused();
});

for (const media of [
  { motion: "no-preference", transparency: "reduce" },
  { motion: "reduce", transparency: "reduce" },
]) {
  test(`움직임 ${media.motion}·투명도 ${media.transparency}에서도 머리·놓을 곳·안내선·연동 색을 읽는다`, async ({ page, scenario, context }, testInfo) => {
    seed(scenario, 2);
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: media.motion }, { name: "prefers-reduced-transparency", value: media.transparency }] });
    await page.goto("/");
    await ready(page, 2);
    expect(await page.evaluate(() => [matchMedia("(prefers-reduced-motion: reduce)").matches, matchMedia("(prefers-reduced-transparency: reduce)").matches])).toEqual([media.motion === "reduce", media.transparency === "reduce"]);
    const target = await boxOf(group(page, "cell-0"));
    await drag(page, tab(page, "screener"), { x: target.x + target.width / 2, y: target.y + target.height - 40 }, false);
    const preview = page.locator("[data-dock-preview]");
    await expect(preview).toBeVisible();
    await expect(preview.locator(".dock-drop-caption").filter({ has: page.locator("[data-dock-preview-label]") })).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await shot(page, testInfo, "reduced-dock-preview");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await setMode(page, "canvas");
    await linked(page, "cell-0");
    await expect(head(page, "cell-0")).toHaveCSS("backdrop-filter", "none");
    await expect(head(page, "cell-0").getByRole("button", { name: "연동 색: A" })).toHaveText("A");
    const first = await boxOf(frame(page, "cell-0")), second = await boxOf(frame(page, "cell-1"));
    await drag(page, head(page, "cell-1"), { x: first.x + 64, y: second.y + 47 }, false);
    const guide = page.locator('[data-canvas-guide="x"]');
    await expect(guide).toBeVisible();
    await expect(guide).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await shot(page, testInfo, "reduced-canvas-guide");
    await page.mouse.up();
    await session.detach();
  });
}

for (const surface of ["canvas", "dock-float"] as const) {
  test(`${surface}: Tab으로 가려진 창 머리를 드러내고 닫은 뒤 보이는 창에 초점을 돌린다`, async ({ page, scenario }) => {
    seed(scenario, 2, surface === "canvas" ? "canvas" : "dock", false);
    const base = scenario.documents.layout();
    const rect = { x: .15, y: .12, w: .6, h: .7 };
    scenario.documents.saveLayout({ ...base, windows: [...base.windows, { id: "screener", kind: "screener", link: null }], placement: {
      v: 1,
      canvas: { rects: { "cell-0": rect, "cell-1": rect, screener: rect }, order: ["cell-0", "cell-1", "screener"] },
      dock: { root: { kind: "group", id: "chart", tabs: ["cell-0"], active: "cell-0" }, floats: [{ window: "cell-1", rect }, { window: "screener", rect }] },
    } });
    await page.goto("/");
    await ready(page, 2);
    await tabTo(page, head(page, "cell-1"));
    await exposed(head(page, "cell-1"));
    await expect(head(page, "cell-1")).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Delete");
    await expect(head(page, "cell-1")).toHaveCount(0);
    const successor = surface === "canvas" ? head(page, "cell-0") : head(page, "screener");
    await expect(successor).toBeFocused();
    await exposed(successor);
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toBeInViewport({ ratio: 1 });
  });
}

for (const mode of MODES) {
  for (const destination of ["button", "input", "body"] as const) {
    test(`${mode}: 창 닫기 뒤 ${destination} 초점에서 새 입력을 보존하고 잃은 초점만 복구한다`, async ({ page, scenario }) => {
      const base = scenario.documents.layout();
      const watch = { x: .05, y: .1, w: .4, h: .6 }, screener = { x: .55, y: .2, w: .4, h: .6 };
      scenario.documents.saveLayout({ ...base, windows: [chartWindow("cell-0"), { id: "watchlist", kind: "watchlist", link: null }, { id: "screener", kind: "screener", link: null }], placement: {
        v: 1, canvas: { rects: { "cell-0": watch, watchlist: watch, screener }, order: ["cell-0", "watchlist", "screener"] },
        dock: { root: { kind: "group", id: "chart", tabs: ["cell-0"], active: "cell-0" }, floats: [{ window: "watchlist", rect: watch }, { window: "screener", rect: screener }] },
      } });
      scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: mode });
      await page.goto("/");
      await ready(page);
      if (destination === "input") {
        await frame(page, "watchlist").getByRole("button", { name: /^관심종목 목록: / }).click();
        await page.getByRole("menuitem", { name: "새 그룹", exact: true }).click();
      }
      const target = destination === "input" ? frame(page, "watchlist").getByRole("textbox", { name: "그룹 이름", exact: true }) : destination === "button" ? topbar(page).getByRole("button", { name: "창 더하기", exact: true }) : page.locator("body");
      await expect(target).toBeVisible();
      expect(await target.evaluate(async (target, destination) => {
        const header = document.querySelector<HTMLElement>('[data-window-header="screener"]');
        if (!header || !(target instanceof HTMLElement)) throw new Error("닫기 초점 대상을 찾지 못했습니다");
        header.focus();
        header.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
        if (destination !== "body") target.focus();
        await Promise.resolve();
        return document.activeElement === target;
      }, destination)).toBe(true);
      await expect(head(page, "screener")).toHaveCount(0);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (destination === "body") {
        await expect(page.locator(":focus")).not.toHaveJSProperty("tagName", "BODY");
        await exposed(page.locator(":focus"));
      } else {
        await expect(target).toBeFocused();
      }
    });
  }
}

for (const mode of MODES) {
  for (const closing of ["screener", "cell-1"] as const) {
    test(`${mode}: 가려진 차트가 있는 창 닫기는 보이는 초점과 한 번의 되돌리기를 보존한다 (${closing})`, async ({ page, scenario }) => {
      const base = scenario.documents.layout();
      const rect = { x: .15, y: .12, w: .6, h: .7 };
      const original: LayoutWindow[] = [chartWindow("cell-0"), { id: "indicators", kind: "indicators", link: null }, { id: "screener", kind: "screener", link: null }, ...(closing === "cell-1" ? [chartWindow("cell-1")] : []), { id: "watchlist", kind: "watchlist", link: null }];
      scenario.documents.saveLayout({ ...base, windows: original, placement: {
        v: 1,
        canvas: { rects: Object.fromEntries(original.map((window) => [window.id, rect])), order: original.map((window) => window.id) },
        dock: { root: { kind: "group", id: "side", tabs: ["watchlist"], active: "watchlist" }, floats: original.filter((window) => window.id !== "watchlist").map((window) => ({ window: window.id, rect })) },
      } });
      scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: mode });
      await page.goto("/");
      await ready(page, closing === "cell-1" ? 2 : 1);
      await tabTo(page, head(page, closing));
      await exposed(head(page, closing));
      await tabTo(page, head(page, "indicators").getByRole("button", { name: "지표 닫기", exact: true }), "Shift+Tab");
      await exposed(page.locator(":focus"));
      await tabTo(page, head(page, closing));
      await exposed(head(page, closing));
      await page.keyboard.press("Tab");
      await expect(head(page, closing).getByRole("button").first()).toBeFocused();
      await exposed(page.locator(":focus"));
      await page.keyboard.press("Shift+Tab");
      await expect(head(page, closing)).toBeFocused();
      await pollSaved(() => mode === "canvas" ? placement(scenario).canvas?.order.at(-1) : placement(scenario).dock?.floats.at(-1)?.window).toBe(closing);
      const before = placement(scenario);
      await page.keyboard.press("Delete");
      await expect(head(page, closing)).toHaveCount(0);
      await expect(frame(page, "cell-0")).toHaveAttribute("data-active-cell", "");
      await expect(page.locator(":focus")).toBeInViewport({ ratio: 1 });
      await exposed(page.locator(":focus"));
      const undo = page.getByRole("status").filter({ hasText: `${closing === "cell-1" ? "차트" : "스크리너"} 창을 닫았습니다` }).getByRole("button", { name: "되돌리기", exact: true });
      await expect(undo).toBeEnabled({ timeout: 1500 });
      await undo.click();
      await expect(head(page, closing)).toBeVisible();
      await pollSaved(() => windows(scenario).map((window) => window.id)).toEqual(original.map((window) => window.id));
      await pollSaved(() => placement(scenario)).toEqual(before);
    });
  }
}

test("떠 있는 차트를 닫고 가려진 교체 탭 대신 보이는 창 머리에 초점을 둔다", async ({ page, scenario }) => {
  const base = scenario.documents.layout();
  const rect = { x: 0, y: 0, w: .8, h: .8 };
  const original: LayoutWindow[] = [chartWindow("cell-0"), { id: "screener", kind: "screener", link: null }, chartWindow("cell-1")];
  scenario.documents.saveLayout({ ...base, windows: original, placement: { v: 1, canvas: null, dock: {
    root: { kind: "group", id: "chart", tabs: ["cell-0"], active: "cell-0" }, floats: [{ window: "screener", rect }, { window: "cell-1", rect }],
  } } });
  await page.goto("/");
  await ready(page, 2);
  await tabTo(page, head(page, "cell-1"));
  await pollSaved(() => placement(scenario).dock?.floats.at(-1)?.window).toBe("cell-1");
  const before = placement(scenario);
  await page.keyboard.press("Delete");
  await expect(head(page, "cell-1")).toHaveCount(0);
  await expect(head(page, "screener")).toBeFocused();
  await exposed(page.locator(":focus"));
  await expect(tab(page, "cell-0")).toHaveAttribute("data-active-cell", "");
  const undo = page.getByRole("status").filter({ hasText: "차트 창을 닫았습니다" }).getByRole("button", { name: "되돌리기", exact: true });
  await expect(undo).toBeEnabled({ timeout: 1500 });
  await undo.click();
  await expect(head(page, "cell-1")).toBeVisible();
  await pollSaved(() => windows(scenario).map((window) => window.id)).toEqual(original.map((window) => window.id));
  await pollSaved(() => placement(scenario)).toEqual(before);
});

test("가로로 스크롤한 도킹 탭에서 옆 창을 닫으면 선택된 탭으로 초점을 돌린다", async ({ page, scenario }) => {
  const base = scenario.documents.layout();
  const original: LayoutWindow[] = [...Array.from({ length: 8 }, (_, index) => chartWindow(`cell-${index}`)), { id: "watchlist", kind: "watchlist", link: null }, { id: "screener", kind: "screener", link: null }];
  scenario.documents.saveLayout({ ...base, windows: original, placement: { v: 1, canvas: null, dock: {
    root: { kind: "group", id: "tabs", tabs: original.filter((window) => window.id !== "screener").map((window) => window.id), active: "watchlist" }, floats: [{ window: "screener", rect: { x: .15, y: .12, w: .6, h: .7 } }],
  } } });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  const selected = tab(page, "watchlist");
  for (let step = 0; step < 240 && !await selected.evaluate((element) => element === document.activeElement); step++) await page.keyboard.press("Tab");
  await expect(selected).toBeFocused();
  await tabTo(page, head(page, "screener"));
  await page.keyboard.press("Delete");
  await expect(head(page, "screener")).toHaveCount(0);
  await expect(tab(page, "watchlist")).toBeFocused();
  await expect(tab(page, "watchlist")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "watchlist")).toBeInViewport({ ratio: 1 });
  await exposed(tab(page, "watchlist"));
  await expect(tab(page, "cell-0")).toHaveAttribute("data-active-cell", "");
  const undo = page.getByRole("status").filter({ hasText: "스크리너 창을 닫았습니다" }).getByRole("button", { name: "되돌리기", exact: true });
  await expect(undo).toBeEnabled({ timeout: 1500 });
  await undo.click();
  await expect(head(page, "screener")).toBeVisible();
});

for (const mode of MODES) {
  test(`${mode}: 키보드에서 뒤 창의 크기 조작으로 넘어가 취소해도 순서와 기록은 같다`, async ({ page, scenario }) => {
    const base = scenario.documents.layout();
    const rear = { x: .05, y: .1, w: .4, h: .6 }, front = { x: .55, y: .2, w: .4, h: .6 };
    scenario.documents.saveLayout({ ...base, windows: [chartWindow("cell-0"), { id: "indicators", kind: "indicators", link: null }, { id: "screener", kind: "screener", link: null }], placement: {
      v: 1, canvas: { rects: { "cell-0": rear, indicators: rear, screener: front }, order: ["cell-0", "indicators", "screener"] },
      dock: { root: { kind: "group", id: "chart", tabs: ["cell-0"], active: "cell-0" }, floats: [{ window: "indicators", rect: rear }, { window: "screener", rect: front }] },
    } });
    scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: mode });
    await page.goto("/");
    await ready(page);
    await tabTo(page, layoutButton(page));
    const beforeStyle = await frame(page, "indicators").getAttribute("style");
    if (!beforeStyle) throw new Error("창의 배치가 없습니다");
    const before = placement(scenario);
    const handle = await boxOf(frame(page, "indicators").locator('[data-resize-handle="se"]'));
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 40, handle.y + 40, { steps: 5 });
    const stage = mode === "canvas" ? page.locator("[data-canvas-stage]") : page.getByRole("main", { name: "작업 영역" });
    const dragging = mode === "canvas" ? "data-canvas-dragging" : "data-dock-dragging";
    await expect(stage).toHaveAttribute(dragging, "");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(stage).not.toHaveAttribute(dragging);
    await expect(frame(page, "indicators")).toHaveAttribute("style", beforeStyle);
    expect(placement(scenario)).toEqual(before);
    await layoutButton(page).click();
    await expect(layoutMenu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true })).toBeDisabled();
    expect(placement(scenario)).toEqual(before);
  });
}

async function chooseLink(page: Page, dot: Locator, name: string) {
  await dot.click();
  await page.getByRole("menu", { name: "연동 색" }).getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
}
