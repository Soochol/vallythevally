import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { parsePlacement } from "../src/layout/placement";
import { cell, DEFAULT_LAYOUT_ID, expect, test, type Scenario, pollSaved } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });
const group = (page: Page, id: string) => page.locator(`[data-dock-group="${id}"]`);
const tab = (page: Page, id: string, name: string) => group(page, id).getByRole("tab", { name: new RegExp(`^${name}`) });
const preview = (page: Page) => page.locator("[data-dock-preview]");
const label = (page: Page) => page.locator("[data-dock-preview-label]");
const frame = (page: Page) => page.locator("[data-dock-level-frame]");
const steps = (page: Page) => page.locator("[data-dock-preview] .dock-drop-steps li");
const area = (page: Page) => page.getByRole("main", { name: "작업 영역" });
const saved = (scenario: Scenario) => parsePlacement(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement).dock;
const SMALL = "자리가 작아 나눌 수 없습니다. 가운데에 놓아 탭으로 넣으세요";

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

type Second = { id: string; window: LayoutWindow };
const TRADES: Second = { id: "trades", window: { id: "trades", link: null, kind: "trades" } };
const ORDER: Second = { id: "order", window: { id: "order", link: null, kind: "order", venue: "combined" } };

function leftSplitRightTabs(scenario: Scenario, second: Second = TRADES, floating = false) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [...layout.windows, second.window];
  const root = {
    kind: "split", dir: "row", ratio: 0.5,
    first: { kind: "split", dir: "column", ratio: 0.5, first: { kind: "group", id: "gA", tabs: ["cell-0"], active: "cell-0" }, second: { kind: "group", id: "gB", tabs: ["watchlist"], active: "watchlist" } },
    second: floating ? { kind: "group", id: "gC", tabs: ["screener"], active: "screener" } : { kind: "group", id: "gC", tabs: ["screener", second.id], active: "screener" },
  };
  const floats = floating ? [{ window: second.id, rect: { x: 0.55, y: 0.5, w: 0.3, h: 0.4 } }] : [];
  scenario.documents.saveLayout({ ...layout, windows, revision: layout.revision + 1, placement: { v: 1, canvas: null, dock: { root, floats } } });
}

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(group(page, "gC")).toBeVisible();
}

async function grab(page: Page, source: Locator, inset = 60) {
  const box = await boxOf(source);
  await page.mouse.move(box.x + Math.min(inset, box.width / 2), box.y + box.height / 2);
  await page.mouse.down();
}

const rightLine = async (page: Page, inset: number) => {
  const a = await boxOf(group(page, "gA"));
  return { x: a.x + a.width - inset, y: a.y + a.height / 2 };
};

test("나눔 전체의 오른쪽 선 가까이에 놓으면 C2가 전체 높이로 붙고 C는 그대로다", async ({ page, scenario }) => {
  leftSplitRightTabs(scenario);
  await open(page);
  const room = await boxOf(area(page));
  const c = await boxOf(group(page, "gC"));
  await grab(page, tab(page, "gC", "체결"));
  const point = await rightLine(page, 4);
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await expect(label(page)).toHaveText("묶음 2개 전체 오른쪽에 나눠 놓기");
  expect((await boxOf(preview(page))).height).toBe(room.height);
  expect((await boxOf(frame(page))).height).toBe(room.height);
  await expect(steps(page)).toHaveCount(2);
  await expect(steps(page).nth(1)).toHaveAttribute("aria-current", "step");
  await expect(steps(page).nth(0)).not.toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("status").filter({ hasText: "묶음 2개 전체 오른쪽에 나눠 놓기" })).toHaveCount(1);
  await page.mouse.up();
  await expect(preview(page)).toHaveCount(0);
  const moved = await boxOf(page.locator("[data-dock-group]").filter({ has: page.getByRole("tab", { name: /^체결/ }) }));
  expect(moved.height).toBe(room.height);
  const rest = await boxOf(group(page, "gC"));
  expect(rest.x).toBe(c.x);
  expect(rest.width).toBe(c.width);
  await pollSaved(() => JSON.stringify(saved(scenario)?.root)).toContain('"tabs":["trades"]');
  expect(saved(scenario)?.root).toMatchObject({ kind: "split", dir: "row", first: { kind: "split", dir: "row", first: { kind: "split", dir: "column" }, second: { kind: "group", tabs: ["trades"] } }, second: { kind: "group", id: "gC", tabs: ["screener"] } });
});

test("띠 바깥 단계를 지난 깊은 곳은 지금처럼 묶음 하나만 나눈다", async ({ page, scenario }) => {
  leftSplitRightTabs(scenario);
  await open(page);
  const a = await boxOf(group(page, "gA"));
  await grab(page, tab(page, "gC", "체결"));
  const point = await rightLine(page, a.width * 0.2);
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await expect(label(page)).toHaveText("오른쪽에 나눠 놓기");
  expect((await boxOf(preview(page))).height).toBe(a.height);
  await expect(steps(page).nth(0)).toHaveAttribute("aria-current", "step");
  await page.mouse.up();
  await pollSaved(() => JSON.stringify(saved(scenario)?.root)).toContain('"tabs":["trades"]');
  expect(saved(scenario)?.root).toMatchObject({ kind: "split", first: { kind: "split", dir: "column", first: { kind: "split", dir: "row", first: { kind: "group", id: "gA" }, second: { kind: "group", tabs: ["trades"] } } } });
});

test("A·B와 C 사이 틈 가운데는 나눔 전체의 오른쪽과 같다", async ({ page, scenario }) => {
  leftSplitRightTabs(scenario);
  await open(page);
  const room = await boxOf(area(page));
  const a = await boxOf(group(page, "gA"));
  const c = await boxOf(group(page, "gC"));
  await grab(page, tab(page, "gC", "체결"));
  await page.mouse.move((a.x + a.width + c.x) / 2, a.y + a.height / 2, { steps: 12 });
  await expect(label(page)).toHaveText("묶음 2개 전체 오른쪽에 나눠 놓기");
  expect((await boxOf(preview(page))).height).toBe(room.height);
  await page.mouse.up();
  await pollSaved(() => JSON.stringify(saved(scenario)?.root)).toContain('"tabs":["trades"]');
});

test("작업 영역 아래 가장자리 5px 안은 화면 전체 아래다", async ({ page, scenario }) => {
  leftSplitRightTabs(scenario);
  await open(page);
  const room = await boxOf(area(page));
  const b = await boxOf(group(page, "gB"));
  await grab(page, tab(page, "gC", "체결"));
  await page.mouse.move(b.x + b.width / 2, room.y + room.height - 5, { steps: 12 });
  await expect(label(page)).toHaveText("화면 전체 아래에 나눠 놓기");
  expect((await boxOf(preview(page))).width).toBe(room.width);
  await expect(steps(page)).toHaveText(["묶음", "화면 전체"]);
  await expect(steps(page).nth(1)).toHaveAttribute("aria-current", "step");
  await page.mouse.up();
});

test("바깥 단계가 들어가지 않는 자리는 경고 미리 보기로 거절하고 배치를 바꾸지 않는다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  leftSplitRightTabs(scenario, ORDER);
  await open(page);
  const before = saved(scenario);
  const boxes = await Promise.all(["gA", "gB", "gC"].map((id) => boxOf(group(page, id))));
  await grab(page, tab(page, "gC", "호가주문"));
  const point = await rightLine(page, 4);
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await expect(preview(page)).toHaveAttribute("data-dock-preview", "blocked");
  await expect(frame(page)).toHaveAttribute("data-dock-level-frame", "blocked");
  await expect(label(page)).toHaveText(SMALL);
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: SMALL })).toBeVisible();
  expect(await Promise.all(["gA", "gB", "gC"].map((id) => boxOf(group(page, id))))).toEqual(boxes);
  expect(saved(scenario)).toEqual(before);
});

test("바깥 단계 미리 보기 중 Esc는 미리 보기를 지우고 배치를 그대로 둔다", async ({ page, scenario }) => {
  leftSplitRightTabs(scenario);
  await open(page);
  const before = saved(scenario);
  const boxes = await Promise.all(["gA", "gB", "gC"].map((id) => boxOf(group(page, id))));
  await grab(page, tab(page, "gC", "체결"));
  const point = await rightLine(page, 4);
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await expect(label(page)).toHaveText("묶음 2개 전체 오른쪽에 나눠 놓기");
  await page.keyboard.press("Escape");
  await expect(preview(page)).toHaveCount(0);
  await expect(frame(page)).toHaveCount(0);
  await page.mouse.up();
  expect(await Promise.all(["gA", "gB", "gC"].map((id) => boxOf(group(page, id))))).toEqual(boxes);
  expect(saved(scenario)).toEqual(before);
});

test("떠 있는 창의 머리를 A의 오른쪽 선 가까이에 놓으면 같은 바깥 단계로 붙는다", async ({ page, scenario }) => {
  leftSplitRightTabs(scenario, TRADES, true);
  await open(page);
  const room = await boxOf(area(page));
  await grab(page, page.locator('[data-dock-float="trades"] [data-window-header]'), 6);
  const point = await rightLine(page, 4);
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await expect(label(page)).toHaveText("묶음 2개 전체 오른쪽에 나눠 놓기");
  expect((await boxOf(preview(page))).height).toBe(room.height);
  await page.mouse.up();
  await expect(page.locator('[data-dock-float="trades"]')).toHaveCount(0);
  await pollSaved(() => JSON.stringify(saved(scenario)?.root)).toContain('"tabs":["trades"]');
  expect(saved(scenario)?.floats).toEqual([]);
  expect(saved(scenario)?.root).toMatchObject({ kind: "split", first: { kind: "split", dir: "row", first: { kind: "split", dir: "column" }, second: { kind: "group", tabs: ["trades"] } }, second: { kind: "group", id: "gC" } });
});
