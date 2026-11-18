import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Drawing } from "../src/api/generated/Drawing";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import { cell, chartOf, expect, test, type Scenario, pollSaved } from "./harness";
import { selectOption } from "./select-option";
import { expandDock, mirror, settledMirror } from "./drawing-probe";

const drawings = async (scenario: Scenario): Promise<Drawing[]> => scenario.documents.drawings("IDX:001");

test("추세선 작은 막대의 색·굵기·잠금·복제·삭제 되돌리기를 사용한다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  const chart = await chartOf(cell(page)).boundingBox();
  if (!chart) throw new Error("차트가 없습니다");
  await cell(page).focus();
  await page.keyboard.press("T");
  await page.mouse.move(chart.x + chart.width * 0.76, chart.y + chart.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(chart.x + chart.width * 0.86, chart.y + chart.height * 0.25, { steps: 10 });
  await page.mouse.up();
  await pollSaved(async () => (await drawings(scenario)).length).toBe(1);
  const original = (await drawings(scenario))[0]!;
  const bar = page.getByRole("toolbar", { name: "드로잉 스타일" });
  await bar.getByRole("button", { name: "선 색 선택", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "선 색", exact: true });
  await expect(picker.getByRole("group", { name: "기본 색상", exact: true }).getByRole("button")).toHaveCount(40);
  await expect(picker.getByRole("group", { name: "테마 색", exact: true })).toHaveCount(0);
  await picker.getByRole("tab", { name: "사용자 지정", exact: true }).click();
  await picker.getByRole("textbox", { name: "HEX", exact: true }).fill("#224466");
  await picker.getByRole("button", { name: "선택", exact: true }).click();
  await selectOption(bar.getByLabel("선 굵기", { exact: true }), "4");
  await selectOption(bar.getByLabel("선 모양", { exact: true }), "dashed");
  await pollSaved(async () => (await drawings(scenario))[0]?.style).toMatchObject({ line: { color: "#224466", width: 4, dash: "dashed" } });
  await mkdir(resolve("../target/ux-screens"), { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await expect(bar).toBeInViewport();
    await page.screenshot({ path: resolve(`../target/ux-screens/drawing-toolbar-${size.width}x${size.height}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await bar.getByRole("button", { name: "잠금", exact: true }).click();
  await pollSaved(async () => (await drawings(scenario))[0]?.locked).toBe(true);
  await bar.getByRole("button", { name: "잠금 풀기", exact: true }).click();
  await bar.getByRole("button", { name: "드로잉 복제", exact: true }).click();
  await pollSaved(async () => (await drawings(scenario)).length).toBe(2);
  const cloned = (await drawings(scenario)).find((d) => d.id !== original.id)!;
  expect(cloned.style).toEqual((await drawings(scenario)).find((d) => d.id === original.id)!.style);
  await bar.getByRole("button", { name: "드로잉 지우기", exact: true }).click();
  await pollSaved(async () => (await drawings(scenario)).map((d) => d.id)).toEqual([original.id]);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await pollSaved(async () => (await drawings(scenario)).map((d) => d.id).sort()).toEqual([original.id, cloned.id].sort());
  await mkdir(resolve("../target/ux-screens"), { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: resolve(`../target/ux-screens/drawings-${size.width}x${size.height}.png`) });
  }
});

test("드로잉 그룹의 별표 고정은 새로고침 뒤 도구와 메뉴에 복원된다", async ({ scenario, page }) => {
  await page.goto("/");
  await expandDock(page);
  await page.getByRole("button", { name: "선 도구 펼치기", exact: true }).click();
  const pinned = page.getByRole("menuitemcheckbox", { name: "수평선 막대에 고정", exact: true });
  await pinned.click();
  await expect(pinned).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expandDock(page);
  await expect(page.getByRole("button", { name: "수평선 고정 도구", exact: true })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("자동 저장됨");
  await pollSaved(async () => scenario.documents.uiPrefs().drawing.pinnedTools).toContain("hline");
  await page.reload();
  await expandDock(page);
  await page.getByRole("button", { name: "수평선 고정 도구", exact: true }).click();
  await expect(page.getByRole("button", { name: "수평선 고정 도구", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expandDock(page);
  await page.getByRole("button", { name: "선 도구 펼치기", exact: true }).click();
  await expect(pinned).toHaveAttribute("aria-checked", "true");
});

const SYMBOL = "IDX:001";

async function seedTrend(scenario: Scenario, hidden: boolean) {
  const bars = scenario.market.page({ symbol: SYMBOL }).bars;
  const [from, to] = [bars.at(-30)!, bars.at(-10)!];
  const input: DrawingInput = { id: "01900000-0000-7000-8000-0000000000c1", symbol: SYMBOL, tool: "trendline", points: [{ t: from.t, price: from.c }, { t: to.t, price: to.c }], style: {}, text: null, locked: false, hidden, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 0 };
  scenario.documents.saveDrawing(input);
  return input;
}

async function bodyOf(page: Page, id: string) {
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  const frame = (await chartOf(cell(page)).boundingBox())!;
  const [from, to] = (await settledMirror(page)).find((m) => m.id === id)!.points;
  return { x: frame.x + (from!.x + to!.x) / 2, y: frame.y + (from!.y + to!.y) / 2 };
}

const drawingMenu = (page: Page) => page.getByRole("menu", { name: "드로잉 메뉴", exact: true });

test("고른 드로잉의 우클릭 메뉴에는 숨기기가 없고 잠금과 지우기가 있다", async ({ page, scenario }) => {
  const trend = await seedTrend(scenario, false);
  await page.goto("/");
  const at = await bodyOf(page, trend.id);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(drawingMenu(page)).toBeVisible();
  await expect(drawingMenu(page).getByRole("menuitem", { name: "잠금", exact: true })).toBeVisible();
  await expect(drawingMenu(page).getByRole("menuitem", { name: "지우기", exact: true })).toBeVisible();
  await expect(drawingMenu(page).getByRole("menuitem", { name: /숨기기/ })).toHaveCount(0);
});

test("차트 빈 곳 우클릭 메뉴의 모든 드로잉 숨기기를 켜고 끄면 드로잉이 숨었다 돌아온다", async ({ page, scenario }) => {
  const trend = await seedTrend(scenario, false);
  await page.goto("/");
  await bodyOf(page, trend.id);
  const frame = (await chartOf(cell(page)).boundingBox())!;
  const openMenu = async () => {
    await page.mouse.click(frame.x + frame.width * 0.4, frame.y + frame.height * 0.6, { button: "right" });
    await expect(drawingMenu(page)).toContainText("드로잉 1개");
  };
  const hideAll = () => drawingMenu(page).getByRole("menuitemcheckbox", { name: "모든 드로잉 숨기기", exact: true });
  await openMenu();
  await hideAll().click();
  await expect.poll(async () => (await mirror(page)).length).toBe(0);
  await page.keyboard.press("Escape");
  await openMenu();
  await expect(hideAll()).toHaveAttribute("aria-checked", "true");
  await hideAll().click();
  await expect.poll(async () => (await mirror(page)).map((m) => m.id)).toEqual([trend.id]);
});

test("서버가 hidden이 true로 내려준 드로잉도 차트에 그려지고 고를 수 있다", async ({ page, scenario }) => {
  const trend = await seedTrend(scenario, true);
  await page.goto("/");
  const at = await bodyOf(page, trend.id);
  await expect.poll(async () => (await mirror(page)).map((m) => m.id)).toEqual([trend.id]);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await mirror(page)).find((m) => m.id === trend.id)?.selected).toBe(true);
});
