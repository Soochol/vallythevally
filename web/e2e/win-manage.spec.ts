import type { Locator, Page } from "@playwright/test";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import type { Layout } from "../src/api/generated/Layout";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

test.use({ clockStart: "20261109100000" });

const NOV9 = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };

const topbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const addButton = (page: Page) => topbar(page).getByRole("button", { name: "창 더하기" });
const kindItem = (page: Page, name: string) => page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: new RegExp(`^${name}`) });
const groups = (page: Page) => page.locator("[data-dock-group]");
const groupWith = (page: Page, tabName: string) => groups(page).filter({ has: page.getByRole("tab", { name: new RegExp(`^${tabName}`) }) });
const tabsOf = (page: Page, tabName: string) => groupWith(page, tabName).getByRole("tablist");
const windowTabs = (page: Page) => groups(page).locator(".dock-tabs").getByRole("tab");
const tab = (page: Page, name: string) => windowTabs(page).filter({ hasText: new RegExp(`^${name}`) });
const closeButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} 닫기`, exact: true });
const toast = (page: Page) => page.getByRole("status").filter({ hasText: "창을 닫았습니다" });
const saved = (scenario: Scenario) => scenario.documents.layout(DEFAULT_LAYOUT_ID);

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

async function addWindow(page: Page, name: string) {
  await addButton(page).click();
  await kindItem(page, name).click();
}

function expectServerRules(layout: Layout) {
  const ids = layout.windows.map((w) => w.id);
  expect(ids.length).toBeGreaterThanOrEqual(1);
  expect(ids.length).toBeLessThanOrEqual(12);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  const charts = layout.windows.filter((w) => w.kind === "chart").length;
  expect(charts).toBeGreaterThanOrEqual(1);
  expect(charts).toBeLessThanOrEqual(8);
  for (const kind of ["watchlist", "screener", "objects", "indicators"]) expect(layout.windows.filter((w) => w.kind === kind).length).toBeLessThanOrEqual(1);
}

function twoSamsungCharts(scenario: Scenario) {
  const layout = saved(scenario);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "cell-1", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "W", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("창 더하기에서 차트를 고르면 활성 칸을 복사한 둘째 차트가 겹치지 않게 생기고 활성 칸이 되며 새로고침 뒤에도 남는다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addWindow(page, "차트");
  await expect(cell(page, 2)).toBeVisible();
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /^칸 2: .* 일$/);
  const first = groups(page).filter({ has: cell(page, 1) });
  const second = groups(page).filter({ has: cell(page, 2) });
  await expect(second).toHaveAttribute("data-active-cell", "");
  await expect(first).not.toHaveAttribute("data-active-cell", "");
  const [a, b] = [await boxOf(first), await boxOf(second)];
  expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);

  await expect.poll(() => saved(scenario).windows.filter((w) => w.kind === "chart").length).toBe(2);
  const layout = saved(scenario);
  expectServerRules(layout);
  const [source, copy] = layout.windows.filter((w) => w.kind === "chart");
  expect({ ...copy, id: source!.id }).toEqual(source);

  await page.reload();
  await expect(cell(page, 2)).toBeVisible();
  await expect(groups(page).filter({ has: page.getByRole("region", { name: /^칸 \d: / }) })).toHaveCount(2);
});

test("창 더하기에서 지표를 고르면 지표 창이 생기고, 다시 고르면 창 수는 그대로이고 그 탭을 고른다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addButton(page).click();
  await expect(kindItem(page, "지표")).not.toContainText("열려 있음");
  await expect(kindItem(page, "관심종목")).toContainText("열려 있음");
  await kindItem(page, "지표").click();
  await expect(tab(page, "지표")).toHaveAttribute("aria-selected", "true");
  await expect(windowTabs(page)).toHaveCount(5);

  await tab(page, "관심종목").click();
  await expect(tab(page, "지표")).toHaveAttribute("aria-selected", "false");
  await addWindow(page, "지표");
  await expect(tab(page, "지표")).toHaveAttribute("aria-selected", "true");
  await expect(windowTabs(page)).toHaveCount(5);
  await expect.poll(() => saved(scenario).windows.filter((w) => w.kind === "indicators").length).toBe(1);
  expectServerRules(saved(scenario));
});

test("스크리너 탭을 닫으면 탭이 사라지고 알림의 되돌리기를 누르면 같은 자리에 돌아온다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const side = tabsOf(page, "관심종목");
  await expect(side.getByRole("tab")).toHaveText([/^관심종목/, /^스크리너/, /^개체 목록/]);
  await closeButton(page, "스크리너").click();
  await expect(tab(page, "스크리너")).toHaveCount(0);
  await expect(side.getByRole("tab")).toHaveText([/^관심종목/, /^개체 목록/]);
  await expect.poll(() => saved(scenario).windows.some((w) => w.kind === "screener")).toBe(false);
  expectServerRules(saved(scenario));

  await toast(page).getByRole("button", { name: "되돌리기" }).click();
  await expect(side.getByRole("tab")).toHaveText([/^관심종목/, /^스크리너/, /^개체 목록/]);
  await expect.poll(() => saved(scenario).windows.some((w) => w.kind === "screener")).toBe(true);
});

test("오른쪽 묶음의 탭을 모두 닫으면 묶음이 사라지고 차트가 작업 영역을 채우며, 하나뿐인 차트는 닫을 수 없다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  for (const name of ["관심종목", "스크리너", "개체 목록"]) await closeButton(page, name).click();
  await expect(groups(page)).toHaveCount(1);
  const area = await boxOf(page.getByRole("main", { name: "작업 영역" }));
  const only = await boxOf(groups(page).first());
  expect(Math.abs(only.width - area.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(only.height - area.height)).toBeLessThanOrEqual(1);

  const chartClose = groups(page).first().getByRole("button", { name: /^칸 1 .+ 닫기$/ });
  await expect(chartClose).toBeDisabled();
  await expect(chartClose).toHaveAttribute("title", "차트 창은 하나 이상 있어야 합니다");
  await expect.poll(() => saved(scenario).windows.map((w) => w.kind)).toEqual(["chart"]);
  expectServerRules(saved(scenario));
});

test("이 칸 범위의 드로잉이 있는 차트 창을 닫으면 같은 종목의 다른 차트 창에서 이 레이아웃 범위로 보인다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  const drawing: DrawingInput = { id: "01900000-0000-7000-8000-0000000000d1", symbol: "005930", tool: "hline", points: [{ t: NOV9, price: 70_000 }], style: {}, text: null, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: "cell-1" }, revision: 3 };
  scenario.documents.saveDrawing(drawing);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await tab(page, "개체 목록").click();
  const objects = page.getByRole("region", { name: "개체 목록" });
  await expect(objects).toContainText("다른 칸·레이아웃에 1개");

  await cell(page, 2).click();
  await expect(objects.getByRole("region", { name: "이 칸" })).toBeVisible();
  await closeButton(page, "칸 2 삼성전자").click();
  await expect(cell(page, 2)).toHaveCount(0);
  await expect.poll(() => scenario.documents.drawings("005930")[0]?.scope).toEqual({ kind: "layout", layoutId: DEFAULT_LAYOUT_ID });
  await expect(objects.getByRole("region", { name: "이 레이아웃 공통" })).toContainText("1");
  await expect(objects).not.toContainText("다른 칸·레이아웃에");
  expectServerRules(saved(scenario));
});

const cellDrawing = (scenario: Scenario) => scenario.documents.saveDrawing({ id: "01900000-0000-7000-8000-0000000000d2", symbol: "005930", tool: "hline", points: [{ t: NOV9, price: 70_000 }], style: {}, text: null, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: "cell-1" }, revision: 3 });
const unavailable = { status: 503, body: { error: { code: "internal", message: "잠시 끊김", reason: null, retryAt: null, manualActionRequired: false } } };
const layoutScope = { kind: "layout", layoutId: DEFAULT_LAYOUT_ID };

test("재시도를 기다리는 드로잉 편집이 있는 차트 창을 닫아도 편집은 이 레이아웃 범위로 저장된다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  cellDrawing(scenario);
  let puts = 0;
  scenario.on((url, request) => url.pathname.startsWith("/api/drawings/") && request.method() === "PUT" && puts++ === 0, () => unavailable);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await tab(page, "개체 목록").click();
  await cell(page, 2).click();
  await page.getByRole("region", { name: "개체 목록" }).getByRole("region", { name: "이 칸" }).getByRole("button", { name: /잠그기$/ }).click();
  await expect.poll(() => puts).toBe(1);
  await closeButton(page, "칸 2 삼성전자").click();
  await expect.poll(() => scenario.documents.drawings("005930")[0], { timeout: 15_000 }).toMatchObject({ locked: true, scope: layoutScope });
  await expect(page.getByRole("status").filter({ hasText: "드로잉을 저장하지 못했습니다" })).toHaveCount(0);
});

test("저장 전에 차트 창을 닫고 새로고침해도 저장 뒤 그 드로잉이 이 레이아웃 범위로 보인다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  cellDrawing(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  scenario.reply((url, request) => url.pathname.startsWith("/api/layouts/") && request.method() === "PUT", unavailable);
  await closeButton(page, "칸 2 삼성전자").click();
  await expect(cell(page, 2)).toHaveCount(0);
  await page.reload();
  scenario.on((url, request) => url.pathname.startsWith("/api/layouts/") && request.method() === "PUT", (request) => ({ body: scenario.documents.saveLayout(request.postDataJSON()) }));
  await expect(cell(page, 1)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => scenario.documents.drawings("005930")[0]?.scope).toEqual(layoutScope);
  await tab(page, "개체 목록").click();
  await expect(page.getByRole("region", { name: "개체 목록" }).getByRole("region", { name: "이 레이아웃 공통" })).toContainText("1");
});

test("저장 전에 시작한 드로잉 읽기가 늦게 끝나도 저장 뒤 다시 읽어 이 레이아웃 범위로 보인다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  cellDrawing(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await tab(page, "개체 목록").click();
  const objects = page.getByRole("region", { name: "개체 목록" });
  await expect(objects).toContainText("다른 칸·레이아웃에 1개");
  const before = scenario.documents.drawings("005930");
  let reads = 0;
  const held = scenario.hold((url, request) => url.pathname === "/api/drawings" && request.method() === "GET" && reads++ === 0);
  await closeButton(page, "칸 2 삼성전자").click();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await held.received;
  await expect.poll(() => scenario.documents.drawings("005930")[0]?.scope).toEqual(layoutScope);
  held.reply({ body: before });
  await expect(objects.getByRole("region", { name: "이 레이아웃 공통" })).toContainText("1");
});

test("저장 전에 닫은 차트 창을 되돌리면 그 창의 드로잉 편집은 이 칸 범위로 저장된다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  cellDrawing(scenario);
  let puts = 0;
  scenario.on((url, request) => url.pathname.startsWith("/api/drawings/") && request.method() === "PUT" && puts++ === 0, () => unavailable);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await tab(page, "개체 목록").click();
  await cell(page, 2).click();
  await page.getByRole("region", { name: "개체 목록" }).getByRole("region", { name: "이 칸" }).getByRole("button", { name: /잠그기$/ }).click();
  await expect.poll(() => puts).toBe(1);
  await closeButton(page, "칸 2 삼성전자").click();
  await toast(page).getByRole("button", { name: "되돌리기" }).click();
  await expect(cell(page, 2)).toBeVisible();
  await expect.poll(() => scenario.documents.drawings("005930")[0], { timeout: 15_000 }).toMatchObject({ locked: true, scope: { kind: "cell", windowId: "cell-1" } });
  expect(saved(scenario).windows.filter((w) => w.kind === "chart").map((w) => w.id)).toEqual(["cell-0", "cell-1"]);
});

test("새 차트 창은 바로 저장해 그 창에 이 칸 범위로 바로 그린 드로잉도 서버가 받는다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, drawing: { ...scenario.documents.uiPrefs().drawing, newScope: "cell" }, revision: state.revision + 1 });
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await addWindow(page, "차트");
  await expect(cell(page, 3)).toHaveAttribute("aria-busy", "false");
  const bounds = await boxOf(cell(page, 3));
  await cell(page, 3).focus();
  await page.keyboard.press("H");
  await page.mouse.click(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.4);
  await expect.poll(() => scenario.documents.drawings("005930").length).toBe(1);
  const added = saved(scenario).windows.filter((w) => w.kind === "chart").at(-1)!;
  expect(scenario.documents.drawings("005930")[0]!.scope).toEqual({ kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: added.id });
  await expect(page.getByRole("status").filter({ hasText: "드로잉을 저장하지 못했습니다" })).toHaveCount(0);
});

test("좁은 데스크톱 폭에서도 창 더하기를 더한 위 막대의 버튼이 모두 막대 안에 있다", async ({ page }) => {
  for (const width of [768, 800, 1024]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const bar = await boxOf(topbar(page));
    await expect(addButton(page)).toBeVisible();
    for (const button of await topbar(page).getByRole("button").all()) {
      const box = await boxOf(button);
      expect(box.x + box.width, `${width}px ${await button.getAttribute("aria-label") ?? await button.textContent()}`).toBeLessThanOrEqual(bar.x + bar.width + 1);
    }
  }
});

test("닫기 버튼은 탭이나 연동 색 점에 가리지 않고 버튼 전체가 눌린다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  const buttons = groups(page).locator(".dock-tabs").getByRole("button", { name: /닫기$/ });
  await expect(buttons).toHaveCount(5);
  for (const button of await buttons.all()) {
    const box = await boxOf(button);
    for (const dx of [1, box.width / 2, box.width - 1]) {
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? null, { x: box.x + dx, y: box.y + box.height / 2 });
      expect(hit).toBe(await button.getAttribute("aria-label"));
    }
  }
});

function drawInCells(scenario: Scenario) {
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, drawing: { ...scenario.documents.uiPrefs().drawing, newScope: "cell" }, revision: state.revision + 1 });
}

async function drawLine(page: Page, n: number) {
  const bounds = await boxOf(cell(page, n));
  await cell(page, n).focus();
  await page.keyboard.press("H");
  await page.mouse.click(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.4);
}

const isPut = (prefix: string) => (url: URL, request: { method(): string }) => url.pathname.startsWith(prefix) && request.method() === "PUT";
const drawingFailed = (page: Page) => page.getByRole("status").filter({ hasText: "드로잉을 저장하지 못했습니다" });

test("앞 레이아웃 저장이 끝나기 전에 차트 창을 더하고 그 창에 그려도 드로잉이 저장된다", async ({ page, scenario }) => {
  drawInCells(scenario);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let layoutPuts = 0;
  scenario.on((url, request) => isPut("/api/layouts/")(url, request) && layoutPuts++ === 0, async (request) => { await gate; return { body: scenario.documents.saveLayout(request.postDataJSON()) }; });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await closeButton(page, "스크리너").click();
  await expect.poll(() => layoutPuts).toBe(1);
  await addWindow(page, "차트");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  release();
  await drawLine(page, 2);
  await expect.poll(() => scenario.documents.drawings("IDX:001").length, { timeout: 15_000 }).toBe(1);
  const added = saved(scenario).windows.filter((w) => w.kind === "chart").at(-1)!;
  expect(scenario.documents.drawings("IDX:001")[0]!.scope).toEqual({ kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: added.id });
  await expect(drawingFailed(page)).toHaveCount(0);
});

test("서버가 끊긴 동안 더한 차트 창에 그리고 새로고침해도 서버가 돌아오면 드로잉이 저장된다", async ({ page, scenario }) => {
  drawInCells(scenario);
  let down = false;
  scenario.on((url, request) => down && (isPut("/api/layouts/")(url, request) || isPut("/api/drawings/")(url, request)), () => unavailable);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  down = true;
  await addWindow(page, "차트");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await drawLine(page, 2);
  await expect.poll(() => scenario.requests.filter((r) => isPut("/api/drawings/")(new URL(r.url()), r)).length).toBeGreaterThan(0);
  down = false;
  await page.reload();
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => scenario.documents.drawings("IDX:001").length, { timeout: 20_000 }).toBe(1);
  expect(saved(scenario).windows.filter((w) => w.kind === "chart")).toHaveLength(2);
  await expect(drawingFailed(page)).toHaveCount(0);
});

test("드로잉 저장이 오가는 중에 그 차트 창을 닫아도 실패 알림 없이 이 레이아웃 범위로 저장된다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  cellDrawing(scenario);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let puts = 0;
  scenario.on((url, request) => isPut("/api/drawings/")(url, request) && puts++ === 0, async (request) => {
    await gate;
    const value: DrawingInput = request.postDataJSON();
    return scenario.documents.hasScope(value.scope) ? { body: scenario.documents.saveDrawing(value) } : { status: 400, body: { error: { code: "bad_request", message: "드로잉 범위의 차트 창이 없습니다", reason: null, retryAt: null, manualActionRequired: false } } };
  });
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await tab(page, "개체 목록").click();
  await cell(page, 2).click();
  await page.getByRole("region", { name: "개체 목록" }).getByRole("region", { name: "이 칸" }).getByRole("button", { name: /잠그기$/ }).click();
  await expect.poll(() => puts).toBe(1);
  await closeButton(page, "칸 2 삼성전자").click();
  await expect.poll(() => saved(scenario).windows.filter((w) => w.kind === "chart").length).toBe(1);
  release();
  await expect.poll(() => scenario.documents.drawings("005930")[0], { timeout: 15_000 }).toMatchObject({ locked: true, scope: layoutScope });
  await expect(drawingFailed(page)).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "저장하지 못했습니다" })).toHaveCount(0);
});

for (const edit of ["새 드로잉", "탭을 고른 뒤 잠그기"] as const) {
  test(`서버가 이미 아는 차트 창의 드로잉을 서버가 잘못된 요청으로 거절하면 다시 보내지 않고 알린다: ${edit}`, async ({ page, scenario }) => {
    twoSamsungCharts(scenario);
    cellDrawing(scenario);
    drawInCells(scenario);
    let drawingPuts = 0;
    scenario.on((url, request) => isPut("/api/drawings/")(url, request), () => {
      drawingPuts += 1;
      return { status: 400, body: { error: { code: "bad_request", message: "group: at most 100 characters", reason: null, retryAt: null, manualActionRequired: false } } };
    });
    await page.goto("/");
    await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
    if (edit === "새 드로잉") await drawLine(page, 2);
    else {
      await tab(page, "개체 목록").click();
      await cell(page, 2).click();
      await page.getByRole("region", { name: "개체 목록" }).getByRole("region", { name: "이 칸" }).getByRole("button", { name: /잠그기$/ }).click();
    }
    await expect(drawingFailed(page)).toHaveCount(1);
    await page.waitForTimeout(6_000);
    expect(drawingPuts).toBe(1);
  });
}

test("닫기 저장의 응답이 오기 전에 되돌리고 그 창에 그려도 드로잉이 그 창 범위로 저장된다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  drawInCells(scenario);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let layoutPuts = 0;
  scenario.on((url, request) => isPut("/api/layouts/")(url, request) && layoutPuts++ === 0, async (request) => {
    const body = scenario.documents.saveLayout(request.postDataJSON());
    await gate;
    return { body };
  });
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await closeButton(page, "칸 2 삼성전자").click();
  await expect.poll(() => saved(scenario).windows.filter((w) => w.kind === "chart").length).toBe(1);
  await toast(page).getByRole("button", { name: "되돌리기" }).click();
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await drawLine(page, 2);
  await expect.poll(() => scenario.requests.filter((r) => isPut("/api/drawings/")(new URL(r.url()), r)).length).toBeGreaterThan(0);
  release();
  await expect.poll(() => scenario.documents.drawings("005930").map((d) => d.scope), { timeout: 15_000 }).toEqual([{ kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: "cell-1" }]);
  await expect(drawingFailed(page)).toHaveCount(0);
});

test("저장하지 못한 레이아웃 사본으로 다시 열어도 서버가 아는 차트 창의 잘못된 드로잉은 바로 알린다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  drawInCells(scenario);
  scenario.on((url, request) => isPut("/api/layouts/")(url, request), () => unavailable);
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await closeButton(page, "스크리너").click();
  await expect.poll(() => scenario.requests.filter((r) => isPut("/api/layouts/")(new URL(r.url()), r)).length).toBeGreaterThan(0);
  let drawingPuts = 0;
  scenario.on((url, request) => isPut("/api/drawings/")(url, request), () => {
    drawingPuts += 1;
    return { status: 400, body: { error: { code: "bad_request", message: "group: at most 100 characters", reason: null, retryAt: null, manualActionRequired: false } } };
  });
  await page.reload();
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect(tab(page, "스크리너")).toHaveCount(0);
  await drawLine(page, 2);
  await expect(drawingFailed(page)).toHaveCount(1);
  await page.waitForTimeout(6_000);
  expect(drawingPuts).toBe(1);
});

const scopeRejected = { status: 400, body: { error: { code: "bad_request", message: "드로잉 범위의 레이아웃이나 차트 창이 없습니다", reason: null, retryAt: null, manualActionRequired: false } } };

test("새 창 레이아웃이 서버에 닿기 전에 거절된 드로잉은 그 응답이 레이아웃 저장 뒤에 와도 다시 보낸다", async ({ page, scenario }) => {
  drawInCells(scenario);
  let releaseLayout = () => {};
  const layoutGate = new Promise<void>((resolve) => { releaseLayout = resolve; });
  let releaseDrawing = () => {};
  const drawingGate = new Promise<void>((resolve) => { releaseDrawing = resolve; });
  let layoutPuts = 0;
  let layoutAnswered = false;
  scenario.on((url, request) => isPut("/api/layouts/")(url, request) && layoutPuts++ === 0, async (request) => {
    await layoutGate;
    const body = scenario.documents.saveLayout(request.postDataJSON());
    layoutAnswered = true;
    return { body };
  });
  let drawingPuts = 0;
  scenario.on((url, request) => isPut("/api/drawings/")(url, request), async (request) => {
    drawingPuts += 1;
    const value: DrawingInput = request.postDataJSON();
    const known = scenario.documents.hasScope(value.scope);
    if (drawingPuts === 1) await drawingGate;
    return known ? { body: scenario.documents.saveDrawing(value) } : scopeRejected;
  });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addWindow(page, "차트");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => layoutPuts).toBe(1);
  await drawLine(page, 2);
  await expect.poll(() => drawingPuts).toBe(1);
  releaseLayout();
  await expect.poll(() => layoutAnswered).toBe(true);
  releaseDrawing();
  await expect.poll(() => scenario.documents.drawings("IDX:001").length, { timeout: 15_000 }).toBe(1);
  await expect(drawingFailed(page)).toHaveCount(0);
});

test("서버가 반영하고 연결이 끊긴 닫기 저장 뒤 되돌려 그린 드로잉은 다시 보내 저장된다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  drawInCells(scenario);
  let layoutPuts = 0;
  let releaseSecond = () => {};
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  await page.route("**/api/layouts/**", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    layoutPuts += 1;
    if (layoutPuts === 1) {
      scenario.documents.saveLayout(route.request().postDataJSON());
      return route.abort("connectionreset");
    }
    if (layoutPuts === 2) await secondGate;
    return route.fallback();
  });
  let drawingPuts = 0;
  scenario.on((url, request) => isPut("/api/drawings/")(url, request), (request) => {
    drawingPuts += 1;
    const value: DrawingInput = request.postDataJSON();
    return scenario.documents.hasScope(value.scope) ? { body: scenario.documents.saveDrawing(value) } : scopeRejected;
  });
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await closeButton(page, "칸 2 삼성전자").click();
  await expect.poll(() => saved(scenario).windows.filter((w) => w.kind === "chart").length).toBe(1);
  await toast(page).getByRole("button", { name: "되돌리기" }).click();
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => layoutPuts).toBe(2);
  await drawLine(page, 2);
  await expect.poll(() => drawingPuts).toBe(1);
  await expect(drawingFailed(page)).toHaveCount(0);
  releaseSecond();
  await expect.poll(() => scenario.documents.drawings("005930").map((d) => d.scope), { timeout: 15_000 }).toEqual([{ kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: "cell-1" }]);
  await expect(drawingFailed(page)).toHaveCount(0);
});

test("드로잉이 서버에 머무는 사이 그 창을 닫았다 되돌려도 거절된 드로잉을 다시 보내 저장한다", async ({ page, scenario }) => {
  twoSamsungCharts(scenario);
  drawInCells(scenario);
  let layoutPuts = 0;
  let closeApplied = () => {};
  const closeOnServer = new Promise<void>((resolve) => { closeApplied = resolve; });
  let releaseClose = () => {};
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  let undoAnswered = false;
  scenario.on((url, request) => isPut("/api/layouts/")(url, request), async (request) => {
    layoutPuts += 1;
    const n = layoutPuts;
    const body = scenario.documents.saveLayout(request.postDataJSON());
    if (n === 1) { closeApplied(); await closeGate; }
    if (n === 2) undoAnswered = true;
    return { body };
  });
  let drawingPuts = 0;
  let drawingJudged = false;
  let releaseDrawing = () => {};
  const drawingGate = new Promise<void>((resolve) => { releaseDrawing = resolve; });
  scenario.on((url, request) => isPut("/api/drawings/")(url, request), async (request) => {
    drawingPuts += 1;
    const value: DrawingInput = request.postDataJSON();
    if (drawingPuts === 1) await closeOnServer;
    const known = scenario.documents.hasScope(value.scope);
    if (drawingPuts === 1) { drawingJudged = true; await drawingGate; }
    return known ? { body: scenario.documents.saveDrawing(value) } : scopeRejected;
  });
  await page.goto("/");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await drawLine(page, 2);
  await expect.poll(() => drawingPuts).toBe(1);
  await closeButton(page, "칸 2 삼성전자").click();
  await expect.poll(() => drawingJudged).toBe(true);
  await toast(page).getByRole("button", { name: "되돌리기" }).click();
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  releaseClose();
  await expect.poll(() => undoAnswered).toBe(true);
  releaseDrawing();
  await expect.poll(() => scenario.documents.drawings("005930").map((d) => d.scope), { timeout: 15_000 }).toEqual([{ kind: "cell", layoutId: DEFAULT_LAYOUT_ID, windowId: "cell-1" }]);
  await expect(drawingFailed(page)).toHaveCount(0);
});

test("창 더하기 메뉴와 탭의 닫기 버튼을 키보드만으로 쓴다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(kindItem(page, "차트")).toBeFocused();
  await page.keyboard.press("End");
  await expect(kindItem(page, "호가주문")).toBeFocused();
  for (let up = 0; up < 5; up++) await page.keyboard.press("ArrowUp");
  await expect(kindItem(page, "지표")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tab(page, "지표")).toHaveAttribute("aria-selected", "true");

  await tab(page, "지표").focus();
  await page.keyboard.press("Tab");
  await expect(closeButton(page, "지표")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tab(page, "지표")).toHaveCount(0);
  await expect(tab(page, "개체 목록")).toBeFocused();
  await expect(toast(page)).toContainText("지표 창을 닫았습니다");
});
