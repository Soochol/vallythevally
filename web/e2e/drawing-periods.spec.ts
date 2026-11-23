import type { Page } from "@playwright/test";
import type { Period } from "../src/api/generated/Period";
import { type Scenario, cell, expect, pollSaved, test } from "./harness";
import { chartPoint, drawings, foldedMenuItems, mirror, open } from "./drawing-probe";
import { selectMinute } from "./select-option";

const MINUTES: Period[] = ["1m", "3m", "5m", "10m", "15m", "30m", "60m"];
const DAILY_AND_UP: Period[] = ["D", "W", "M", "Q", "Y"];

const periodGroup = (page: Page) => page.getByRole("group", { name: "봉 주기" });

async function goTo(page: Page, period: "D" | "W" | "3m" | "60m") {
  if (period === "3m" || period === "60m") {
    const minutes = periodGroup(page).getByRole("button", { name: "분봉" });
    await selectMinute(minutes, period);
    await expect(minutes).toHaveAttribute("data-value", period);
  } else {
    const button = periodGroup(page).getByRole("button", { name: period === "D" ? "일" : "주", exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function drawHorizontalLine(page: Page, scenario: Scenario, count: number) {
  await cell(page).focus(); await page.keyboard.press("H");
  const at = await chartPoint(page, 0.7, 0.3); await page.mouse.click(at.x, at.y);
  await pollSaved(async () => (await drawings(scenario)).length).toBe(count);
  return (await drawings(scenario)).at(-1)!;
}

const shownIds = async (page: Page) => (await mirror(page)).map((d) => d.id);

type SeededDrawing = Parameters<Scenario["documents"]["saveDrawing"]>[0];
const seeded = (id: string, periods: Period[] | null): SeededDrawing => ({ id, symbol: "IDX:001", tool: "hline", points: [{ t: 1_700_000_000, price: 5_300 }], text: null, style: {}, locked: false, hidden: false, periods, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 });

test("분봉에서 그린 드로잉은 분봉 묶음에만 보인다", async ({ page, scenario }) => {
  await open(page); await goTo(page, "3m");
  const line = await drawHorizontalLine(page, scenario, 1);
  expect(line.periods).toEqual(MINUTES);
  await goTo(page, "60m"); await expect.poll(() => shownIds(page)).toEqual([line.id]);
  await goTo(page, "D"); await expect.poll(() => shownIds(page)).toEqual([]);
  await goTo(page, "3m"); await expect.poll(() => shownIds(page)).toEqual([line.id]);
});

test("일봉에서 그린 드로잉은 일 이상 묶음에만 보인다", async ({ page, scenario }) => {
  await open(page);
  const line = await drawHorizontalLine(page, scenario, 1);
  expect(line.periods).toEqual(DAILY_AND_UP);
  await goTo(page, "W"); await expect.poll(() => shownIds(page)).toEqual([line.id]);
  await goTo(page, "3m"); await expect.poll(() => shownIds(page)).toEqual([]);
});

test("일봉에서 복사해 분봉에 붙이면 분봉 묶음이다", async ({ page, scenario }) => {
  await open(page);
  const line = await drawHorizontalLine(page, scenario, 1);
  await page.keyboard.press("Control+c");
  await goTo(page, "3m");
  await cell(page).focus(); await page.keyboard.press("Control+v");
  await pollSaved(async () => (await drawings(scenario)).length).toBe(2);
  const pasted = (await drawings(scenario)).find((d) => d.id !== line.id)!;
  expect(pasted.periods).toEqual(MINUTES);
  await expect.poll(() => shownIds(page)).toEqual([pasted.id]);
});

test("봉 주기 제한이 없는 옛 드로잉은 모든 봉 주기에 보이고 그대로 저장된다", async ({ page, scenario }) => {
  const legacy = seeded("01900000-0000-7000-8000-0000000000a1", null);
  scenario.documents.saveDrawing(legacy);
  await open(page);
  for (const period of ["D", "3m", "W"] as const) {
    await goTo(page, period);
    await expect.poll(() => shownIds(page)).toEqual([legacy.id]);
  }
  expect((await drawings(scenario)).map((d) => d.periods)).toEqual([null]);
});

const dailyOnly = seeded("01900000-0000-7000-8000-0000000000b1", DAILY_AND_UP);
const minuteOnly = seeded("01900000-0000-7000-8000-0000000000b2", MINUTES);
const everywhere = seeded("01900000-0000-7000-8000-0000000000b3", null);

async function openEmptyMenu(page: Page) {
  const at = await chartPoint(page, 0.2, 0.15);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

test("빈 곳 메뉴는 이 봉 주기 묶음의 드로잉만 세고 그 묶음만 지운다", async ({ page, scenario }) => {
  for (const line of [dailyOnly, minuteOnly, everywhere]) scenario.documents.saveDrawing(line);
  await open(page);
  const menu = await openEmptyMenu(page);
  await expect(menu).toContainText("드로잉 2개 · 모든 봉 주기 3개");
  await expect(menu.getByRole("menuitem", { name: "이 종목 드로잉 모두 지우기…" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "일 이상 드로잉 모두 지우기…", exact: true }).click();
  await pollSaved(async () => (await drawings(scenario)).map((d) => d.id)).toEqual([minuteOnly.id]);
  await goTo(page, "3m");
  const minuteMenu = await openEmptyMenu(page);
  await expect(minuteMenu).toContainText("드로잉 1개");
  await expect(minuteMenu.getByRole("menuitem", { name: "분봉 드로잉 모두 지우기…", exact: true })).toBeEnabled();
});

test("분봉 칸의 빈 곳 메뉴에는 분봉 드로잉 모두 지우기가 있다", async ({ page, scenario }) => {
  for (const line of [dailyOnly, minuteOnly, everywhere]) scenario.documents.saveDrawing(line);
  await open(page); await goTo(page, "3m");
  const menu = await openEmptyMenu(page);
  await expect(menu).toContainText("드로잉 2개 · 모든 봉 주기 3개");
  await expect(menu.getByRole("menuitem", { name: "분봉 드로잉 모두 지우기…", exact: true })).toBeVisible();
});

test("고른 드로잉의 보이는 봉 주기를 모든 봉 주기와 일 이상만으로 바꾼다", async ({ page, scenario }) => {
  await open(page); await goTo(page, "3m");
  const line = await drawHorizontalLine(page, scenario, 1);
  const choose = async (name: string) => {
    await page.getByRole("button", { name: "드로잉 더 보기", exact: true }).click();
    await foldedMenuItems(page);
    await page.getByRole("menu", { name: "드로잉 메뉴", exact: true }).getByRole("menuitem", { name, exact: true }).click();
  };
  await choose("모든 봉 주기");
  await pollSaved(async () => (await drawings(scenario))[0]?.periods).toBeNull();
  await goTo(page, "D"); await expect.poll(() => shownIds(page)).toEqual([line.id]);
  await goTo(page, "3m");
  const box = (await chartPoint(page, 0, 0));
  const y = (await mirror(page))[0]!.points[0]!.y;
  const at = await chartPoint(page, 0.7, 0); await page.mouse.click(at.x, box.y + y);
  await choose("일 이상만");
  await pollSaved(async () => (await drawings(scenario))[0]?.periods).toEqual(DAILY_AND_UP);
});
