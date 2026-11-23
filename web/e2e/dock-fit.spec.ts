import type { Locator, Page, Request } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { countOverlaps } from "../src/layout/canvas/geometry";
import { listGroups } from "../src/layout/dock/tree";
import { WINDOW_HEAD_HEIGHT, WINDOW_KIND_LIST, WINDOW_KINDS, type WindowKind } from "../src/layout/kinds";
import { parsePlacement, type DockNode } from "../src/layout/placement";
import { cell, DEFAULT_LAYOUT_ID, expect, pollSaved, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });

const FOLD_NOTICE = "자리가 좁아 창 묶음 일부를 탭으로 접었습니다 · 창을 넓히면 돌아옵니다";
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const CHART: LayoutWindow = { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS };
const BROKERS: LayoutWindow = { id: "brokers", link: null, kind: "brokers" };
const ORDER: LayoutWindow = { id: "order", link: null, kind: "order", venue: "combined" };

const groups = (page: Page) => page.locator("[data-dock-group]");
const groupHolding = (page: Page, id: string) => groups(page).filter({ has: page.locator(`[role=tab][data-window-id="${id}"]`) });
const tabOf = (page: Page, id: string) => page.locator(`.dock-tab-scroll [role=tab][data-window-id="${id}"]`);
const foldNotices = (page: Page) => page.locator(".ui-toast-stack").getByText(FOLD_NOTICE);
const addButton = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" });
const kindItem = (page: Page, name: string) => page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: new RegExp(`^${name}`) });
const group = (id: string, tabs: string[]): DockNode => ({ kind: "group", id, tabs: tabs as never, active: tabs[0] as never });
const row = (ratio: number, first: DockNode, second: DockNode): DockNode => ({ kind: "split", dir: "row", ratio, first, second });
const layoutPuts = (scenario: Scenario): Request[] => scenario.requests.filter((request) => request.method() === "PUT" && new URL(request.url()).pathname.startsWith("/api/layouts/"));
const savedGroups = (placement: unknown) => {
  const dock = parsePlacement(placement).dock;
  return dock ? listGroups(dock.root).map((node) => node.tabs) : null;
};

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

async function shownGroups(page: Page): Promise<string[][]> {
  return groups(page).evaluateAll((nodes) => nodes.map((node) => Array.from(node.querySelectorAll(".dock-tab-scroll [role=tab]"), (tab) => tab.getAttribute("data-window-id") ?? "")));
}

async function groupSizes(page: Page) {
  return groups(page).evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { kind: node.getAttribute("data-kind") ?? "", w: Math.round(box.width), h: Math.round(box.height) };
  }));
}

function stubMarket(scenario: Scenario) {
  for (const code of ["005930", "000660"]) {
    scenario.reply((url) => url.pathname === `/api/symbols/${code}/order-book`, { body: { symbol: code, asks: [], bids: [], totalAskQuantity: 0, totalBidQuantity: 0, afterHoursAskQuantity: null, afterHoursBidQuantity: null, bookTime: null } });
    scenario.reply((url) => url.pathname === `/api/symbols/${code}/fundamentals`, { body: { symbol: code, upperLimit: null, lowerLimit: null } });
    scenario.reply((url) => url.pathname === `/api/symbols/${code}/trades`, { body: { symbol: code, venue: "combined", trades: [], skippedRows: 0 } });
    scenario.reply((url) => url.pathname === `/api/symbols/${code}/program-trades`, { body: { symbol: code, points: [], skippedRows: 0 } });
  }
}

function seed(scenario: Scenario, windows: LayoutWindow[], root: DockNode | null) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, windows, placement: root ? { v: 1, dock: { root, floats: [] }, canvas: null } : {}, revision: layout.revision + 1 });
}

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test.beforeEach(({ scenario }) => stubMarket(scenario));

test("차트와 호가주문을 나란히 둔 배치를 1024로 줄여도 호가주문 묶음 폭이 420px 아래로 내려가지 않고 넓히면 그대로 돌아온다", async ({ page, scenario }) => {
  seed(scenario, [CHART, ORDER], row(0.6, group("g1", ["cell-0"]), group("g2", ["order"])));
  await open(page);
  const initial = await shownGroups(page);
  expect(initial).toEqual([["cell-0"], ["order"]]);
  const wideOrder = (await boxOf(groupHolding(page, "order"))).width;

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(async () => (await boxOf(groupHolding(page, "order"))).width).toBeLessThan(wideOrder);
  expect((await boxOf(groupHolding(page, "order"))).width).toBeGreaterThanOrEqual(WINDOW_KINDS.order.minSize.w);
  expect(await shownGroups(page)).toEqual(initial);
  await expect(foldNotices(page)).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await boxOf(groupHolding(page, "order"))).width).toBe(wideOrder);
  expect(await shownGroups(page)).toEqual(initial);
  expect(layoutPuts(scenario)).toHaveLength(0);
});

test("세 묶음을 다 담을 수 없으면 호가주문을 탭으로 접고 한 번 알리며, 그 사이 저장에는 접힌 배치가 실리지 않고 넓히면 처음 묶음이 돌아온다", async ({ page, scenario }) => {
  const root = row(0.35, group("g1", ["cell-0"]), row(0.45, group("g2", ["brokers"]), group("g3", ["order"])));
  seed(scenario, [CHART, BROKERS, ORDER], root);
  await open(page);
  const initial = await shownGroups(page);
  expect(initial).toEqual([["cell-0"], ["brokers"], ["order"]]);

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0"], ["brokers", "order"]]);
  await expect(foldNotices(page)).toHaveCount(1);
  for (const size of await groupSizes(page)) expect(size.w).toBeGreaterThanOrEqual(WINDOW_KINDS[size.kind as WindowKind].minSize.w);
  expect((await boxOf(groupHolding(page, "order"))).width).toBeGreaterThanOrEqual(WINDOW_KINDS.order.minSize.w);

  await tabOf(page, "order").click();
  await expect(groupHolding(page, "order")).toHaveAttribute("data-kind", "order");
  await page.locator('[role=tab][data-window-id="brokers"] + .link-dot').click();
  await page.getByRole("menu", { name: "연동 색" }).getByRole("menuitemradio", { name: /^B/ }).click();
  await pollSaved(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((window) => window.id === "brokers")?.link).toBe("b");
  expect(layoutPuts(scenario).length).toBeGreaterThan(0);
  for (const put of layoutPuts(scenario)) expect(savedGroups((put.postDataJSON() as { placement: unknown }).placement)).toEqual([["cell-0"], ["brokers"], ["order"]]);
  expect(savedGroups(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement)).toEqual([["cell-0"], ["brokers"], ["order"]]);
  await expect(foldNotices(page)).toHaveCount(1);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => shownGroups(page)).toEqual(initial);
  expect(parsePlacement(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement).dock?.root).toEqual(root);
});

test("빈 레이아웃에 창 열 가지를 차례로 더해도 어느 묶음도 고른 탭 창 종류의 최소 높이보다 낮지 않다", async ({ page, scenario }) => {
  seed(scenario, [CHART], null);
  await open(page);
  for (const kind of WINDOW_KIND_LIST) {
    await addButton(page).click();
    await kindItem(page, WINDOW_KINDS[kind].name).click();
    await expect(page.getByRole("menu", { name: "창 더하기" })).toHaveCount(0);
    const low = (await groupSizes(page)).filter((size) => size.h < WINDOW_KINDS[size.kind as WindowKind].minSize.h + WINDOW_HEAD_HEIGHT);
    expect({ kind, low }).toEqual({ kind, low: [] });
  }
  await expect(groups(page).locator(".dock-tab-scroll [role=tab]")).toHaveCount(11);
});

test("창 더하기로 연 호가주문 창은 1440×900에서 높이 520px 이상을 받는다", async ({ page }) => {
  await open(page);
  await addButton(page).click();
  await kindItem(page, "호가주문").click();
  const panel = page.locator('[role=tabpanel][data-window-id="order"]');
  await expect(panel).toBeVisible();
  expect((await boxOf(panel)).height).toBeGreaterThanOrEqual(WINDOW_KINDS.order.minSize.h);
});

test("탭 여섯 개가 한 묶음에 있는 도킹에서 처음 캔버스로 바꾸면 겹친 창 쌍이 없다", async ({ page, scenario }) => {
  const windows: LayoutWindow[] = [CHART, { id: "watchlist", link: null, kind: "watchlist" }, { id: "screener", link: null, kind: "screener" }, { id: "trades", link: null, kind: "trades" }, { id: "book", link: null, kind: "book" }, { id: "program", link: null, kind: "program" }];
  seed(scenario, windows, group("g1", windows.map((window) => window.id)));
  await open(page);
  await page.getByRole("button", { name: /^레이아웃:/ }).click();
  const canvas = page.getByRole("group", { name: "창 배치 방식" }).getByRole("button", { name: "캔버스", exact: true });
  await canvas.click();
  await expect(canvas).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  const frames = page.locator("[data-canvas-window]");
  await expect(frames).toHaveCount(6);
  const rects = await frames.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  }));
  expect(countOverlaps(rects)).toBe(0);
  await pollSaved(() => Object.keys(parsePlacement(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement).canvas?.rects ?? {}).length).toBe(6);
});

const WATCH: LayoutWindow = { id: "watchlist", link: null, kind: "watchlist" };
const savedPuts = (scenario: Scenario) => layoutPuts(scenario).map((put) => parsePlacement((put.postDataJSON() as { placement: unknown }).placement).dock?.root);
const savedRoot = (scenario: Scenario) => parsePlacement(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement).dock?.root;
const ratioOf = (node: DockNode | undefined) => (node?.kind === "split" ? node.ratio : null);

test("접힌 동안 경계선을 화살표 키로 옮기면 저장에는 세 묶음과 옮긴 경계의 비율만 실리고 넓히면 세 묶음이 돌아온다", async ({ page, scenario }) => {
  const inner = row(0.45, group("g2", ["brokers"]), group("g3", ["order"]));
  seed(scenario, [CHART, BROKERS, ORDER], row(0.35, group("g1", ["cell-0"]), inner));
  await open(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0"], ["brokers", "order"]]);
  const divider = page.getByRole("separator", { name: "좌우 창 경계" });
  await expect(divider).toHaveCount(1);
  const before = Number(await divider.getAttribute("aria-valuenow"));

  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", String(before - 16));
  await pollSaved(() => layoutPuts(scenario).length).toBeGreaterThan(0);
  for (const root of savedPuts(scenario)) {
    expect(root && listGroups(root).map((node) => node.tabs)).toEqual([["cell-0"], ["brokers"], ["order"]]);
    expect(root?.kind === "split" && root.second).toEqual(inner);
  }
  expect(ratioOf(savedRoot(scenario))).toBeLessThan(0.35);
  expect(await shownGroups(page)).toEqual([["cell-0"], ["brokers", "order"]]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0"], ["brokers"], ["order"]]);
  expect(savedRoot(scenario)?.kind === "split" && (savedRoot(scenario) as Extract<DockNode, { kind: "split" }>).second).toEqual(inner);
});

test("접힌 묶음에서 탭 메뉴로 탭 순서를 바꾸면 그 탭의 원래 묶음 안에서만 바뀌어 저장되고 넓히면 세 묶음과 비율이 돌아온다", async ({ page, scenario }) => {
  seed(scenario, [CHART, BROKERS, WATCH, ORDER], row(0.35, group("g1", ["cell-0"]), row(0.45, group("g2", ["brokers", "watchlist"]), group("g3", ["order"]))));
  await open(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0"], ["brokers", "watchlist", "order"]]);

  await tabOf(page, "brokers").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: /^뒤로 옮기기/ }).click();
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0"], ["watchlist", "brokers", "order"]]);
  await pollSaved(() => layoutPuts(scenario).length).toBeGreaterThan(0);
  const expected = row(0.35, group("g1", ["cell-0"]), row(0.45, { kind: "group", id: "g2", tabs: ["watchlist", "brokers"] as never, active: "brokers" as never }, group("g3", ["order"])));
  for (const root of savedPuts(scenario)) expect(root).toEqual(expected);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0"], ["watchlist", "brokers"], ["order"]]);
  expect(savedRoot(scenario)).toEqual(expected);
});

test("비율만 눌린 동안 탭 메뉴로 탭 순서를 바꾸면 저장 비율은 그대로이고 넓히면 호가주문 묶음 폭이 돌아온다", async ({ page, scenario }) => {
  seed(scenario, [CHART, WATCH, ORDER], row(0.6, group("g1", ["cell-0", "watchlist"]), group("g2", ["order"])));
  await open(page);
  const wideOrder = (await boxOf(groupHolding(page, "order"))).width;
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(async () => (await boxOf(groupHolding(page, "order"))).width).toBe(WINDOW_KINDS.order.minSize.w);

  await tabOf(page, "cell-0").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: /^뒤로 옮기기/ }).click();
  await expect.poll(() => shownGroups(page)).toEqual([["watchlist", "cell-0"], ["order"]]);
  await pollSaved(() => layoutPuts(scenario).length).toBeGreaterThan(0);
  for (const root of savedPuts(scenario)) expect(ratioOf(root)).toBe(0.6);
  expect((await boxOf(groupHolding(page, "order"))).width).toBe(WINDOW_KINDS.order.minSize.w);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await boxOf(groupHolding(page, "order"))).width).toBe(wideOrder);
  expect(ratioOf(savedRoot(scenario))).toBe(0.6);
});

const FOLDED_ORDER_REASON = "자리가 좁아 접혀 들어온 탭과는 순서를 바꿀 수 없습니다";

test("저장 묶음에 혼자인 탭은 접힌 묶음 안에서 순서를 바꿀 수 없고 저장에는 세 묶음과 비율이 남아 넓히면 돌아온다", async ({ page, scenario }) => {
  const root = row(0.35, group("g1", ["cell-0"]), row(0.45, group("g2", ["brokers"]), group("g3", ["order"])));
  seed(scenario, [CHART, BROKERS, ORDER], root);
  await open(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0"], ["brokers", "order"]]);

  await tabOf(page, "brokers").click({ button: "right" });
  const later = page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "뒤로 옮기기" });
  await expect(later).toBeDisabled();
  await expect(later).toHaveAccessibleDescription(FOLDED_ORDER_REASON);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "창 배치" })).toHaveCount(0);

  await tabOf(page, "brokers").focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(tabOf(page, "brokers")).toBeFocused();
  await page.locator('[role=tab][data-window-id="brokers"] + .link-dot').click();
  await page.getByRole("menu", { name: "연동 색" }).getByRole("menuitemradio", { name: /^B/ }).click();
  await pollSaved(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((window) => window.id === "brokers")?.link).toBe("b");
  expect(layoutPuts(scenario).length).toBeGreaterThan(0);
  for (const saved of savedPuts(scenario)) expect(saved).toEqual(root);
  expect(await shownGroups(page)).toEqual([["cell-0"], ["brokers", "order"]]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0"], ["brokers"], ["order"]]);
  const saved = savedRoot(scenario);
  expect(saved).toEqual(root);
  expect(ratioOf(saved)).toBe(0.35);
  expect(ratioOf(saved?.kind === "split" ? saved.second : undefined)).toBe(0.45);
});

test("접힌 동안 탭을 끌어 접힌 묶음에 놓으면 저장에는 창이 모두 남고 접히지 않은 묶음 구성과 비율이 실려 넓히면 그대로 돌아온다", async ({ page, scenario }) => {
  seed(scenario, [CHART, WATCH, BROKERS, ORDER], row(0.35, { kind: "group", id: "g1", tabs: ["cell-0", "watchlist"] as never, active: "cell-0" as never }, row(0.45, group("g2", ["brokers"]), group("g3", ["order"]))));
  await open(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0", "watchlist"], ["brokers", "order"]]);

  const source = await boxOf(tabOf(page, "watchlist"));
  const target = await boxOf(groupHolding(page, "order"));
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await expect(page.locator("[data-dock-preview-label]")).toHaveText("이 묶음에 탭으로 넣기");
  await page.mouse.up();
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0"], ["brokers", "order", "watchlist"]]);

  const expected = row(0.35, group("g1", ["cell-0"]), row(0.45, group("g2", ["brokers"]), { kind: "group", id: "g3", tabs: ["order", "watchlist"] as never, active: "watchlist" as never }));
  await pollSaved(() => savedRoot(scenario)).toEqual(expected);
  for (const saved of savedPuts(scenario)) {
    const tabs = saved ? listGroups(saved).map((node) => node.tabs) : [];
    expect(tabs.flat().sort()).toEqual(["brokers", "cell-0", "order", "watchlist"]);
    expect(tabs).toContainEqual(["brokers"]);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => shownGroups(page)).toEqual([["cell-0"], ["brokers"], ["order", "watchlist"]]);
  expect(savedRoot(scenario)).toEqual(expected);
});
