import type { Locator, Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Period } from "../src/api/generated/Period";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, pollSaved, test } from "./harness";
import { chartPoint, drawingDock, expandDock, settledMirror } from "./drawing-probe";

test.use({ clockStart: "20261109100000" });

const DAY = 86400;
const LAST = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 50 };
const bar = (t: number, i: number): Bar => ({ t, o: 50000 + i * 20, h: 50100 + i * 20, l: 49900 + i * 20, c: 50050 + i * 20, v: 1000 + i });
const daily = Array.from({ length: 80 }, (_, i) => bar(LAST - (79 - i) * DAY, i));

function seed(scenario: Scenario, first: Period, second: Period) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: first, chartSettings: SETTINGS },
    { id: "cell-1", link: "b", kind: "chart", symbol: "005930", venue: "combined", period: second, chartSettings: SETTINGS },
  ];
  const root = {
    kind: "split", dir: "row", ratio: 0.5,
    first: { kind: "group", id: "g1", tabs: ["cell-0"], active: "cell-0" },
    second: { kind: "group", id: "g2", tabs: ["cell-1"], active: "cell-1" },
  };
  scenario.documents.saveLayout({ ...layout, windows, placement: { v: 1, dock: { root, floats: [] }, canvas: null }, revision: layout.revision + 1 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.route("**/api/bars?**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { symbol: query.get("symbol"), venue: query.get("venue"), period: query.get("period"), bars: daily, current: null, nextBefore: null, seq: null } });
  });
});

async function ready(page: Page, scenario: Scenario, first: Period = "D", second: Period = "W") {
  seed(scenario, first, second);
  await page.goto("/");
  for (const n of [1, 2]) {
    await expect(cell(page, n)).toHaveAttribute("aria-busy", "false");
    await expect(chartOf(cell(page, n))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  }
}

const styleBar = (page: Page, n: number): Locator => cell(page, n).getByRole("toolbar", { name: "드로잉 스타일", exact: true });
const grip = (page: Page, n: number) => styleBar(page, n).getByRole("button", { name: "스타일 막대 옮기기", exact: true });
const dockOf = (page: Page, n: number): Locator => page.getByRole("tabpanel").filter({ has: cell(page, n) }).getByRole("navigation", { name: "드로잉 도구", exact: true });
const textBox = (page: Page) => page.getByRole("textbox", { name: "드로잉 글자" });
const barsPlaced = (page: Page, n: number) => styleBar(page, n).evaluate((el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)}`; });

async function trendline(page: Page, n: number, from: [number, number] = [0.3, 0.7], to: [number, number] = [0.6, 0.4]) {
  await cell(page, n).focus();
  await page.keyboard.press("T");
  const a = await chartPoint(page, ...from, n); const b = await chartPoint(page, ...to, n);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  await expect(styleBar(page, n)).toBeVisible();
}

async function lineMiddle(page: Page, n: number) {
  const [line] = await settledMirror(page, n);
  const box = (await chartOf(cell(page, n)).boundingBox())!;
  const [a, b] = line!.points;
  return { x: box.x + (a!.x + b!.x) / 2, y: box.y + (a!.y + b!.y) / 2 };
}

async function selectLine(page: Page, n: number) {
  const at = await lineMiddle(page, n);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await settledMirror(page, n)).map((m) => m.selected)).toEqual([true]);
}

test("칸 2에서 그린 추세선의 스타일 막대는 칸 2에만 뜨고 칸 1은 고르지 않은 채 선만 보인다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await trendline(page, 2);
  await expect(page.getByRole("toolbar", { name: "드로잉 스타일", exact: true })).toHaveCount(1);
  await expect(styleBar(page, 1)).toHaveCount(0);
  await expect.poll(async () => (await settledMirror(page, 1)).map((m) => [m.tool, m.selected])).toEqual([["trendline", false]]);
  await expect.poll(async () => (await settledMirror(page, 2)).map((m) => [m.tool, m.selected])).toEqual([["trendline", true]]);
});

test("스타일 막대를 끌면 그 칸의 막대만 움직인다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await trendline(page, 2);
  await selectLine(page, 1);
  await expect(styleBar(page, 1)).toBeVisible();
  await expect(styleBar(page, 2)).toBeVisible();
  const before = { first: await barsPlaced(page, 1), second: await barsPlaced(page, 2) };
  const handle = (await grip(page, 1).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 70, handle.y + handle.height / 2 + 50, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => barsPlaced(page, 1)).not.toBe(before.first);
  expect(await barsPlaced(page, 2)).toBe(before.second);
});

test("세부 설정 창과 글자 편집 상자는 그 칸에 하나만 뜬다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await trendline(page, 2);
  await styleBar(page, 2).getByRole("button", { name: "드로잉 세부 설정", exact: true }).click();
  const dialogs = page.getByRole("dialog", { name: /세부 설정$/ });
  await expect(dialogs).toHaveCount(1);
  await expect(cell(page, 2).getByRole("dialog", { name: /세부 설정$/ })).toHaveCount(1);
  await expect(cell(page, 1).getByRole("dialog", { name: /세부 설정$/ })).toHaveCount(0);
  await dialogs.getByRole("button", { name: "세부 설정 닫기", exact: true }).click();
  await expect(dialogs).toHaveCount(0);

  await cell(page, 2).focus(); await page.keyboard.press("X");
  const spot = await chartPoint(page, 0.3, 0.25, 2);
  await page.mouse.click(spot.x, spot.y);
  await expect(textBox(page)).toHaveCount(1);
  await textBox(page).fill("칸 2 메모"); await textBox(page).press("Enter");
  await expect(textBox(page)).toHaveCount(0);
  await expect.poll(async () => (await settledMirror(page, 2)).flatMap((m) => m.texts)).toContain("칸 2 메모");
  const note = (await settledMirror(page, 2)).find((m) => m.tool === "text")!;
  const box = (await chartOf(cell(page, 2)).boundingBox())!;
  await page.mouse.dblclick(box.x + note.points[0]!.x + 16, box.y + note.points[0]!.y + 8);
  await expect(textBox(page)).toHaveCount(1);
  await expect(cell(page, 2).getByRole("textbox", { name: "드로잉 글자" })).toHaveCount(1);
});

test("다른 칸을 누르면 고른 도구가 풀려 그 누름은 선택으로만 처리된다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await cell(page, 1).focus();
  await page.keyboard.press("T");
  const dock = await expandDock(page);
  await expect(dock.getByRole("button", { name: "추세선", exact: true })).toHaveAttribute("aria-pressed", "true");
  const at = await chartPoint(page, 0.5, 0.5, 2);
  await page.mouse.click(at.x, at.y);
  await expect(dockOf(page, 2)).toBeVisible();
  await expect(dockOf(page, 1)).toHaveCount(0);
  const active = await expandDock(page);
  await expect(active.getByRole("button", { name: "선택 도구", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(at.x + 60, at.y - 40);
  await expect.poll(async () => (await settledMirror(page, 2)).length).toBe(0);
  expect(scenario.documents.drawings("005930")).toEqual([]);
});

test("칸 1에서 첫 점만 찍고 칸 2를 누르면 그리던 것이 취소돼 다시 칸 1을 눌러도 이어 그려지지 않는다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await cell(page, 1).focus();
  await page.keyboard.press("T");
  const first = await chartPoint(page, 0.3, 0.6, 1);
  await page.mouse.click(first.x, first.y);
  await page.mouse.move(first.x + 80, first.y - 60, { steps: 4 });
  const other = await chartPoint(page, 0.5, 0.5, 2);
  await page.mouse.click(other.x, other.y);
  await expect(dockOf(page, 2)).toBeVisible();
  const again = await chartPoint(page, 0.6, 0.3, 1);
  await page.mouse.click(again.x, again.y);
  await expect(dockOf(page, 1)).toBeVisible();
  const dock = await expandDock(page);
  await expect(dock.getByRole("button", { name: "선택 도구", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await settledMirror(page, 1)).length).toBe(0);
  expect(scenario.documents.drawings("005930")).toEqual([]);
});

test("칸 1의 봉 주기를 바꿔도 칸 2의 선택과 스타일 막대는 남는다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await trendline(page, 2);
  const at = await chartPoint(page, 0.9, 0.1, 1);
  await page.mouse.click(at.x, at.y);
  await expect(dockOf(page, 1)).toBeVisible();
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "월", exact: true }).click();
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /월/);
  await expect(chartOf(cell(page, 1))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await expect.poll(async () => (await settledMirror(page, 2)).map((m) => m.selected)).toEqual([true]);
  await expect(styleBar(page, 2)).toBeVisible();
});

test("칸 2를 눌러도 칸 1의 선택은 남고 칸 2에서 Delete를 눌러도 칸 1의 드로잉은 지워지지 않는다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await trendline(page, 1);
  await expect(styleBar(page, 1)).toBeVisible();
  const at = await chartPoint(page, 0.9, 0.1, 2);
  await page.mouse.click(at.x, at.y);
  await expect(dockOf(page, 2)).toBeVisible();
  await expect(styleBar(page, 1)).toBeVisible();
  await expect.poll(async () => (await settledMirror(page, 1)).map((m) => m.selected)).toEqual([true]);
  await expect(styleBar(page, 2)).toHaveCount(0);
  await cell(page, 2).focus();
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await settledMirror(page, 1)).map((m) => [m.tool, m.selected])).toEqual([["trendline", true]]);
  await pollSaved(() => scenario.documents.drawings("005930").length).toBe(1);
});

test("레이아웃을 바꿨다 돌아오면 어느 칸에도 스타일 막대가 없다", async ({ page, scenario }) => {
  await ready(page, scenario);
  await trendline(page, 1);
  await pollSaved(() => scenario.documents.drawings("005930").length).toBe(1);
  const layoutButton = page.getByRole("button", { name: /^레이아웃:/ });
  const menu = page.getByRole("menu", { name: "레이아웃", exact: true });
  await layoutButton.click();
  await menu.getByRole("menuitem", { name: "새 이름으로 저장…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새 이름으로 저장", exact: true });
  await dialog.getByRole("textbox", { name: "레이아웃 이름" }).fill("복기");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(layoutButton).toHaveAccessibleName("레이아웃: 복기");
  await expect(page.getByRole("toolbar", { name: "드로잉 스타일", exact: true })).toHaveCount(0);
  await layoutButton.click();
  await menu.getByRole("menuitemradio", { name: "기본", exact: true }).click();
  await expect(layoutButton).toHaveAccessibleName("레이아웃: 기본");
  for (const n of [1, 2]) await expect(chartOf(cell(page, n))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await expect(page.getByRole("toolbar", { name: "드로잉 스타일", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await settledMirror(page, 1)).map((m) => m.selected)).toEqual([false]);
  await expect(drawingDock(page)).toHaveCount(1);
});
