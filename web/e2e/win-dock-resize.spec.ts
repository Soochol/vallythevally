import type { Locator, Page } from "@playwright/test";
import { parsePlacement } from "../src/layout/placement";
import { cell, DEFAULT_LAYOUT_ID, expect, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 860 } });

const GAP = 6;
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const groups = (page: Page) => page.locator("[data-dock-group]");
const group = (page: Page, n: number) => groups(page).nth(n - 1);
const area = (page: Page) => page.getByRole("main", { name: "작업 영역" });
const menu = (page: Page) => page.getByRole("menu", { name: "창 배치" });
const sideways = (page: Page) => page.getByRole("separator", { name: "좌우 창 경계" });
const stacked = (page: Page) => page.getByRole("separator", { name: "위아래 창 경계" });
const balloon = (page: Page) => page.locator("[data-dock-balloon]");
const snapGuide = (page: Page) => page.locator("[data-dock-snap-guide]");
const saved = (scenario: Scenario) => parsePlacement(scenario.documents.layout(DEFAULT_LAYOUT_ID).placement).dock;
const savedRatio = (scenario: Scenario) => {
  const root = saved(scenario)?.root;
  return root?.kind === "split" ? root.ratio : null;
};

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

const widthOf = async (locator: Locator) => (await boxOf(locator)).width;
const heightOf = async (locator: Locator) => (await boxOf(locator)).height;
const center = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function grab(page: Page, at: { x: number; y: number }) {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
}

async function dragBy(page: Page, handle: Locator, delta: number, options: { alt?: boolean; down?: boolean } = {}) {
  const at = center(await boxOf(handle));
  if (options.alt) await page.keyboard.down("Alt");
  await grab(page, at);
  await page.mouse.move(at.x + (options.down ? 0 : delta), at.y + (options.down ? delta : 0), { steps: 8 });
  await page.mouse.up();
  if (options.alt) await page.keyboard.up("Alt");
}

async function undoLayout(page: Page, source: Locator) {
  await source.press("Shift+F10");
  await menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true }).click();
}

const halfLead = (room: Box) => Math.round(0.5 * (Math.floor(room.width) + GAP)) - GAP;

test("경계를 끄는 동안 두 쪽 크기 말풍선이 실제 묶음 폭과 같고 놓으면 사라진다", async ({ page }) => {
  await open(page);
  const handle = sideways(page);
  const at = center(await boxOf(handle));
  await expect(balloon(page)).toHaveCount(0);
  await grab(page, at);
  await page.mouse.move(at.x - 90, at.y, { steps: 6 });
  await expect(balloon(page)).toBeVisible();
  const first = Number(await balloon(page).locator('[data-balloon-side="first"]').getAttribute("data-px"));
  const second = Number(await balloon(page).locator('[data-balloon-side="second"]').getAttribute("data-px"));
  expect(first).toBe(await widthOf(group(page, 1)));
  expect(second).toBe(await widthOf(group(page, 2)));
  await expect(balloon(page)).toContainText("차트");
  await expect(balloon(page)).toContainText(/\d+%/);
  const room = await boxOf(area(page));
  const shown = await boxOf(balloon(page));
  expect(shown.x).toBeGreaterThanOrEqual(room.x);
  expect(shown.x + shown.width).toBeLessThanOrEqual(room.x + room.width + 1);
  await page.mouse.up();
  await expect(balloon(page)).toHaveCount(0);
});

test("1/2 자리에서 5px 떨어진 곳은 붙고 안내선이 보이며 Alt를 누르면 붙지 않는다", async ({ page }) => {
  await open(page);
  const room = await boxOf(area(page));
  const half = halfLead(room);
  const handle = sideways(page);
  const start = center(await boxOf(handle));
  const startLead = await widthOf(group(page, 1));
  await expect(snapGuide(page)).toHaveCount(0);
  await grab(page, start);
  await page.mouse.move(start.x + (half + 5 - startLead), start.y, { steps: 10 });
  await expect(snapGuide(page)).toBeVisible();
  expect(await widthOf(group(page, 1))).toBe(half);
  await page.mouse.up();
  await expect(snapGuide(page)).toHaveCount(0);
  expect(await widthOf(group(page, 1))).toBe(half);

  const back = center(await boxOf(handle));
  await page.keyboard.down("Alt");
  await grab(page, back);
  await page.mouse.move(back.x + (startLead - half), back.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect(await widthOf(group(page, 1))).toBe(startLead);

  const again = center(await boxOf(handle));
  await page.keyboard.down("Alt");
  await grab(page, again);
  await page.mouse.move(again.x + (half + 5 - startLead), again.y, { steps: 10 });
  await expect(snapGuide(page)).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect(await widthOf(group(page, 1))).toBe(half + 5);
});

test("끄는 중 Esc는 끌기 전 배치로 돌리고 저장도 배치 기록도 만들지 않는다", async ({ page, scenario }) => {
  await open(page);
  const before = [await widthOf(group(page, 1)), await widthOf(group(page, 2))];
  const at = center(await boxOf(sideways(page)));
  await page.keyboard.down("Alt");
  await grab(page, at);
  await page.mouse.move(at.x - 150, at.y, { steps: 6 });
  await expect.poll(() => widthOf(group(page, 1))).toBe(before[0]! - 150);
  await page.keyboard.press("Escape");
  await expect(balloon(page)).toHaveCount(0);
  await expect.poll(() => widthOf(group(page, 1))).toBe(before[0]);
  await page.mouse.move(at.x - 200, at.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect([await widthOf(group(page, 1)), await widthOf(group(page, 2))]).toEqual(before);
  expect(saved(scenario)).toBeNull();
  await tab(page, "관심종목").press("Shift+F10");
  await expect(menu(page).getByRole("menuitem", { name: "배치 되돌리기", exact: true })).toBeDisabled();
});

test("세로로 쌓은 차트 셋의 경계를 더블클릭하면 높이가 같아지고 배치 되돌리기 한 번으로 돌아온다", async ({ page }) => {
  await open(page);
  const chartGroups = page.locator('[data-dock-group][data-kind="chart"]');
  const splitDown = async () => {
    await group(page, 1).getByRole("button", { name: "이 묶음에 창 더하기" }).click();
    await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^차트/ }).click();
    await group(page, 1).getByRole("tab").last().click({ button: "right" });
    await menu(page).getByRole("menuitem", { name: "아래에 나눠 놓기", exact: true }).click();
  };
  await splitDown();
  await expect(chartGroups).toHaveCount(2);
  await dragBy(page, stacked(page).first(), 110, { alt: true, down: true });
  await splitDown();
  await expect(chartGroups).toHaveCount(3);
  const heights = async () => [await heightOf(chartGroups.nth(0)), await heightOf(chartGroups.nth(1)), await heightOf(chartGroups.nth(2))];
  const before = await heights();
  expect(Math.max(...before) - Math.min(...before)).toBeGreaterThan(20);
  await stacked(page).first().dblclick();
  await expect.poll(async () => {
    const now = await heights();
    return Math.max(...now) - Math.min(...now);
  }).toBeLessThanOrEqual(1);
  await undoLayout(page, tab(page, "관심종목"));
  await expect.poll(heights).toEqual(before);
});

test("바깥 경계를 오른쪽으로 끌면 안쪽 큰 묶음이 먼저 줄고 모두 최소에 닿으면 알리고 멈춘다", async ({ page, scenario }) => {
  await open(page);
  await dragBy(page, sideways(page), -350, { alt: true });
  await tab(page, "스크리너").press("Shift+F10");
  await menu(page).getByRole("menuitem", { name: "오른쪽에 나눠 놓기", exact: true }).click();
  await expect(groups(page)).toHaveCount(3);
  const watch = groups(page).filter({ has: tab(page, "관심종목") });
  const screener = groups(page).filter({ has: tab(page, "스크리너") });
  await dragBy(page, sideways(page).last(), -150, { alt: true });
  const watchWidth = await widthOf(watch);
  const screenerWidth = await widthOf(screener);
  expect(screenerWidth).toBeGreaterThan(watchWidth);
  const outerBefore = await widthOf(group(page, 1));
  const ratioBefore = savedRatio(scenario);

  await dragBy(page, sideways(page).first(), 150, { alt: true });
  expect(await widthOf(group(page, 1))).toBe(outerBefore + 150);
  expect(await widthOf(watch)).toBe(watchWidth);
  expect(await widthOf(screener)).toBe(screenerWidth - 150);

  await dragBy(page, sideways(page).first(), 600, { alt: true });
  await expect(page.getByRole("status").filter({ hasText: "오른쪽 창은 폭" })).toBeVisible();
  expect(await widthOf(watch)).toBe(220);
  expect(await widthOf(screener)).toBe(280);
  const stopped = await widthOf(group(page, 1));
  expect(stopped).toBeGreaterThan(outerBefore + 150);
  await expect.poll(() => savedRatio(scenario)).not.toBe(ratioBefore);
  await page.reload();
  await expect(groups(page)).toHaveCount(3);
  expect(await widthOf(group(page, 1))).toBe(stopped);
  expect(await widthOf(watch)).toBe(220);
  expect(await widthOf(screener)).toBe(280);
});

test("키보드는 Shift+화살표 1px, PageDown 다음 달라붙는 자리, Home·End 끝으로 옮기고 값 문구를 준다", async ({ page }) => {
  await open(page);
  const handle = sideways(page);
  const room = await boxOf(area(page));
  const start = await widthOf(group(page, 1));
  await expect(handle).toHaveAttribute("aria-valuetext", /차트 \d+픽셀, \d+퍼센트/);
  await handle.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => widthOf(group(page, 1))).toBe(start - 1);
  await expect(balloon(page)).toBeVisible();
  await expect(balloon(page)).toHaveCount(0);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => widthOf(group(page, 1))).toBe(start);

  await page.keyboard.press("PageDown");
  const threeQuarters = Math.round(0.75 * (Math.floor(room.width) + GAP)) - GAP;
  await expect.poll(() => widthOf(group(page, 1))).toBe(threeQuarters);
  await page.keyboard.press("PageUp");
  await expect.poll(() => widthOf(group(page, 1))).toBe(start);

  await page.keyboard.press("Home");
  await expect.poll(async () => String(await widthOf(group(page, 1)))).toBe(await handle.getAttribute("aria-valuemin"));
  await page.keyboard.press("End");
  await expect.poll(async () => String(await widthOf(group(page, 1)))).toBe(await handle.getAttribute("aria-valuemax"));
  expect(((await handle.getAttribute("aria-valuetext")) ?? "").length).toBeGreaterThan(0);
});

test("경계 중심에서 5px 떨어진 곳도 잡히고 떠 있는 창 머리와 탭 닫기 버튼은 가로채이지 않는다", async ({ page }) => {
  await open(page);
  const handle = sideways(page);
  const edge = await boxOf(handle);
  const body = await boxOf(group(page, 1));
  const start = await widthOf(group(page, 1));
  const point = { x: edge.x + edge.width / 2 - 5, y: body.y + body.height / 2 };
  await page.keyboard.down("Alt");
  await grab(page, point);
  await page.mouse.move(point.x - 40, point.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect(await widthOf(group(page, 1))).toBe(start - 40);

  const right = await boxOf(group(page, 2));
  const closeButton = group(page, 2).getByRole("button", { name: /닫기$/ }).first();
  const closeBox = await boxOf(closeButton);
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? null, center(closeBox));
  expect(hit).toBe(await closeButton.getAttribute("aria-label"));
  expect(closeBox.x).toBeGreaterThan(right.x + 3);

  await tab(page, "스크리너").press("Shift+F10");
  await page.getByRole("menuitem", { name: "띄우기", exact: true }).click();
  const floating = page.locator('[data-dock-float="screener"]');
  await expect(floating).toBeVisible();
  const header = floating.locator("[data-window-header]");
  const grip = await boxOf(header);
  const divider = await boxOf(handle);
  const over = { x: divider.x + divider.width / 2 - 60, y: grip.y + grip.height / 2 };
  await page.keyboard.down("Shift");
  await grab(page, { x: grip.x + 60, y: grip.y + grip.height / 2 });
  await page.mouse.move(over.x, over.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const placed = await boxOf(header);
  const groupBefore = await widthOf(group(page, 1));
  const edgeNow = await boxOf(handle);
  const strip = { x: edgeNow.x + edgeNow.width / 2 + 5, y: placed.y + placed.height / 2 };
  expect(strip.x).toBeGreaterThan(placed.x);
  expect(strip.x).toBeLessThan(placed.x + placed.width);
  await page.keyboard.down("Shift");
  await grab(page, strip);
  await page.mouse.move(strip.x + 30, strip.y + 30, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect(await widthOf(group(page, 1))).toBe(groupBefore);
  const moved = await boxOf(header);
  expect(moved.x).toBeGreaterThan(placed.x + 20);
});
