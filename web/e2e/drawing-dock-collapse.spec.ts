import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test, type Scenario, pollSaved } from "./harness";
import { chartPoint, drawingDock as dock, expandDock } from "./drawing-probe";

test.use({ viewport: { width: 1440, height: 900 } });

const pill = (page: Page) => dock(page).locator(".draw-pill");
const expanded = (page: Page) => expect(pill(page)).toHaveAttribute("aria-expanded", "true");
const collapsed = (page: Page, timeout = 5000) => expect(pill(page)).toHaveAttribute("aria-expanded", "false", { timeout });
const menu = (page: Page) => page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
const keepSaved = (scenario: Scenario) => scenario.documents.uiPrefs().drawing.keepDrawing;

function preset(scenario: Scenario, patch: Record<string, unknown>) {
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, drawing: { ...scenario.documents.uiPrefs().drawing, ...patch }, revision: state.revision + 1 });
}

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await page.mouse.move(5, 5);
}

async function settledBox(page: Page) {
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await dock(page).boundingBox());
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
  return (await dock(page).boundingBox())!;
}

const centerOf = (box: { x: number; width: number }) => box.x + box.width / 2;

async function legendState(page: Page) {
  return cell(page).locator(".chart-legend").evaluate((legend) => {
    const range = document.createRange();
    const rows = Array.from(legend.children).flatMap((child) => getComputedStyle(child).flexDirection === "column" ? Array.from(child.children) : [child]).map((row) => {
      range.selectNodeContents(row);
      const { left, top, right, bottom } = range.getBoundingClientRect();
      return { left, top, right, bottom };
    });
    const host = legend.closest("[data-legend-density], [data-chart-host]") ?? legend.parentElement!;
    return { rows, shift: getComputedStyle(legend).top, density: host.getAttribute("data-legend-density"), beside: host.hasAttribute("data-legend-beside") };
  });
}

async function chartRightClick(page: Page) {
  const at = await chartPoint(page, 0.5, 0.6);
  await page.mouse.click(at.x, at.y, { button: "right" });
}

test("처음에는 접혀 있고 알약에 선택 도구 아이콘이 보이며 접힌 동안 도구 버튼은 Tab으로 닿지 않는다", async ({ page }) => {
  await open(page);
  await collapsed(page);
  await expect(pill(page)).toHaveAttribute("aria-label", /^드로잉 도구 펼치기/);
  await expect(pill(page)).toHaveAttribute("aria-label", /선택 도구/);
  await expect(pill(page)).not.toHaveAttribute("data-picked");
  await expect(pill(page).locator("svg")).toBeVisible();
  await expect(dock(page).getByRole("button")).toHaveCount(1);
  const box = await settledBox(page);
  expect(box.width).toBeLessThan(50);
  const reachable = await dock(page).evaluate((bar) => Array.from(bar.querySelectorAll("button")).filter((button) => getComputedStyle(button).visibility !== "hidden").map((button) => button.className));
  expect(reachable).toEqual(["draw-tool draw-pill"]);
});

test("포인터를 올리면 80ms 뒤 펼쳐지고, 벗어나면 0.4초 뒤 접히며, 그 안에 돌아오면 접히지 않는다", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await dock(page).hover();
  await expanded(page);
  await expect(dock(page).getByRole("button", { name: "추세선", exact: true })).toBeVisible();
  await page.mouse.move(5, 5);
  await page.clock.fastForward(150);
  await expanded(page);
  await dock(page).hover();
  await page.clock.fastForward(700);
  await expanded(page);
  await page.mouse.move(5, 5);
  await page.clock.fastForward(150);
  await expanded(page);
  await collapsed(page);
  await expect(dock(page).getByRole("button", { name: "추세선", exact: true })).toBeHidden();
});

for (const [name, dockAt] of [["기본 자리", null], ["옮긴 자리", { x: 0.3, y: 0.45 }], ["오른쪽으로 옮긴 자리", { x: 0.8, y: 0.2 }]] as const) {
  test(`펼칠 때 포인터가 막대 안에 남고 알약과 펼친 막대의 가로 가운데가 같다: ${name}`, async ({ page, scenario }) => {
    preset(scenario, { dockAt });
    await page.clock.install();
    await open(page);
    await collapsed(page);
    const small = await settledBox(page);
    const at = { x: centerOf(small), y: small.y + small.height / 2 };
    await page.mouse.move(at.x, at.y);
    await expanded(page);
    const wide = await settledBox(page);
    expect(wide.width).toBeGreaterThan(small.width * 4);
    expect(Math.abs(centerOf(wide) - centerOf(small))).toBeLessThanOrEqual(1);
    expect(wide.y).toBeCloseTo(small.y, 0);
    expect(at.x).toBeGreaterThan(wide.x);
    expect(at.x).toBeLessThan(wide.x + wide.width);
    await page.clock.fastForward(700);
    await expanded(page);
    await page.mouse.move(5, 5);
    await collapsed(page);
    const back = await settledBox(page);
    expect(Math.abs(centerOf(back) - centerOf(small))).toBeLessThanOrEqual(1);
  });
}

test("포인터를 올려 펼쳐도 범례의 자리와 밀도가 바뀌지 않는다", async ({ page }) => {
  await open(page);
  await collapsed(page);
  const before = await legendState(page);
  await dock(page).hover();
  await expanded(page);
  await page.waitForTimeout(300);
  expect(await legendState(page)).toEqual(before);
  await page.mouse.move(5, 5);
  await collapsed(page);
  await page.waitForTimeout(300);
  expect(await legendState(page)).toEqual(before);
});

test("도구 묶음 메뉴가 열려 있는 동안 포인터가 메뉴로 옮겨 가도 접히지 않고 닫으면 접힌다", async ({ page }) => {
  await page.clock.install();
  await open(page);
  const bar = await expandDock(page);
  await bar.getByRole("button", { name: "선 도구 펼치기", exact: true }).click();
  const list = page.getByRole("menu", { name: "선 도구", exact: true });
  await expect(list).toBeVisible();
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.clock.fastForward(900);
  await expanded(page);
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await page.mouse.move(5, 5);
  await cell(page).focus();
  await collapsed(page);
});

test("자석 세기 메뉴와 단축키 도움말이 열려 있는 동안 접히지 않는다", async ({ page }) => {
  await page.clock.install();
  await open(page);
  const bar = await expandDock(page);
  await bar.getByRole("button", { name: "자석", exact: true }).click({ button: "right" });
  const strength = page.getByRole("menu", { name: "자석 세기", exact: true });
  await expect(strength).toBeVisible();
  await page.mouse.move(5, 5);
  await page.clock.fastForward(900);
  await expanded(page);
  await page.keyboard.press("Escape");
  await expect(strength).toBeHidden();
  await page.mouse.move(5, 5);
  await cell(page).focus();
  await collapsed(page);
  await expandDock(page);
  await bar.getByRole("button", { name: "드로잉 단축키 도움말", exact: true }).click();
  const help = page.getByRole("dialog", { name: "드로잉 단축키", exact: true });
  await expect(help).toBeVisible();
  await page.mouse.move(5, 5);
  await page.clock.fastForward(900);
  await expanded(page);
  await help.getByRole("button", { name: "도움말 닫기", exact: true }).click();
  await expect(help).toBeHidden();
  await collapsed(page);
});

test("손잡이로 끄는 동안에는 접히지 않는다", async ({ page }) => {
  await page.clock.install();
  await open(page);
  const bar = await expandDock(page);
  const grip = (await bar.getByRole("button", { name: "드로잉 도구 막대 옮기기", exact: true }).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  const to = await chartPoint(page, 0.2, 0.5);
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.clock.fastForward(900);
  await expanded(page);
  await page.mouse.up();
  await page.mouse.move(5, 5);
  await collapsed(page);
});

test("Tab으로 들어오면 펼쳐지고 초점이 나가면 접힌다", async ({ page }) => {
  await open(page);
  await pill(page).evaluate((el: HTMLElement) => {
    const stops = Array.from(document.querySelectorAll<HTMLElement>("button, [href], input, select, [tabindex]")).filter((stop) => stop.tabIndex >= 0 && getComputedStyle(stop).visibility !== "hidden" && stop.getClientRects().length > 0);
    stops[stops.indexOf(el) - 1]?.focus();
  });
  await page.keyboard.press("Tab");
  await expanded(page);
  await expect(dock(page).getByRole("button", { name: "드로잉 도구 막대 옮기기", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dock(page).getByRole("button", { name: "선택 도구", exact: true })).toBeFocused();
  await expanded(page);
  for (let i = 0; i < 40 && await dock(page).evaluate((bar) => bar.contains(document.activeElement)); i++) await page.keyboard.press("Tab");
  await collapsed(page);
});

test("단축키로 도구를 고르면 접힌 알약의 아이콘이 바뀐다", async ({ page }) => {
  await open(page);
  await collapsed(page);
  const idle = await pill(page).innerHTML();
  await cell(page).focus();
  await page.keyboard.press("T");
  await expect(pill(page)).toHaveAttribute("aria-label", /지금 추세선/);
  await expect(pill(page)).toHaveAttribute("data-picked", "true");
  expect(await pill(page).innerHTML()).not.toBe(idle);
  await collapsed(page);
  await page.keyboard.press("R");
  await expect(pill(page)).toHaveAttribute("aria-label", /지금 사각형/);
  await page.keyboard.press("V");
  await expect(pill(page)).toHaveAttribute("aria-label", /지금 선택 도구/);
  await expect(pill(page)).not.toHaveAttribute("data-picked");
});

test("연속 그리기를 켜면 포인터가 벗어나도 펼친 채로 남고, 끄면 접힌다", async ({ page }) => {
  await page.clock.install();
  await open(page);
  const bar = await expandDock(page);
  await bar.getByRole("button", { name: "연속 그리기", exact: true }).click();
  await expect(bar.getByRole("button", { name: "연속 그리기", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(5, 5);
  await page.clock.fastForward(900);
  await expanded(page);
  await expandDock(page);
  await bar.getByRole("button", { name: "연속 그리기", exact: true }).click();
  await page.mouse.move(5, 5);
  await collapsed(page);
});

test("도구를 두 번 눌러 그 도구만 연속으로 두면 포인터가 벗어나도 펼친 채로 남는다", async ({ page }) => {
  await page.clock.install();
  await open(page);
  const bar = await expandDock(page);
  await bar.getByRole("button", { name: "추세선", exact: true }).dblclick();
  await page.mouse.move(5, 5);
  await page.clock.fastForward(900);
  await expanded(page);
  await page.keyboard.press("Escape");
});

test("연속 그리기를 켠 채 새로고침하면 막대는 펼친 채로 열린다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await page.clock.install();
  await open(page);
  await expanded(page);
  await page.clock.fastForward(900);
  await expanded(page);
});

test("연속 그리기가 켜진 채 차트에서 우클릭하면 연속 그리기가 꺼지고 선택 도구가 되고 막대가 접히며 차트 메뉴는 열리지 않는다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await open(page);
  await cell(page).focus();
  await page.keyboard.press("T");
  await expect(pill(page)).toHaveAttribute("aria-label", /지금 추세선/);
  await chartRightClick(page);
  await collapsed(page, 400);
  await expect(pill(page)).toHaveAttribute("aria-label", /지금 선택 도구/);
  await pollSaved(() => keepSaved(scenario)).toBe(false);
  await expect(menu(page)).toHaveCount(0);
  await chartRightClick(page);
  await expect(menu(page)).toBeVisible();
});

test("연속 그리기가 켜진 채 그리는 도중 우클릭하면 그리던 것을 취소하고 같은 해제가 일어난다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await open(page);
  await cell(page).focus();
  await page.keyboard.press("T");
  const start = await chartPoint(page, 0.4, 0.4);
  await page.mouse.click(start.x, start.y);
  await chartRightClick(page);
  await collapsed(page, 400);
  await pollSaved(() => keepSaved(scenario)).toBe(false);
  await expect(menu(page)).toHaveCount(0);
  expect(scenario.documents.drawings("005930")).toHaveLength(0);
});

test("해제한 순간 포인터가 막대 위에 있으면 벗어날 때 접힌다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await page.clock.install();
  await open(page);
  await expanded(page);
  await dock(page).hover();
  await cell(page).focus();
  await page.keyboard.press("Escape");
  await pollSaved(() => keepSaved(scenario)).toBe(false);
  await page.clock.fastForward(700);
  await expanded(page);
  await page.mouse.move(5, 5);
  await collapsed(page);
});

test("연속 그리기가 켜진 채 Esc를 누르면 같은 해제가 일어나고 그리던 것은 취소된다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await open(page);
  await cell(page).focus();
  await page.keyboard.press("T");
  const start = await chartPoint(page, 0.4, 0.4);
  await page.mouse.click(start.x, start.y);
  await page.keyboard.press("Escape");
  await collapsed(page, 400);
  await expect(pill(page)).toHaveAttribute("aria-label", /지금 선택 도구/);
  await pollSaved(() => keepSaved(scenario)).toBe(false);
  await expect(menu(page)).toHaveCount(0);
  expect(scenario.documents.drawings("005930")).toHaveLength(0);
});

test("연속 그리기가 꺼져 있으면 우클릭은 차트 메뉴를 열고 Esc는 도구를 푼다", async ({ page, scenario }) => {
  await open(page);
  await cell(page).focus();
  await page.keyboard.press("T");
  await expect(pill(page)).toHaveAttribute("aria-label", /지금 추세선/);
  await page.keyboard.press("Escape");
  await expect(pill(page)).toHaveAttribute("aria-label", /지금 선택 도구/);
  await expect(menu(page)).toHaveCount(0);
  await chartRightClick(page);
  await expect(menu(page)).toBeVisible();
  expect(keepSaved(scenario)).toBe(false);
});

test("막대 위에서의 우클릭은 연속 그리기를 풀지 않는다", async ({ page, scenario }) => {
  preset(scenario, { keepDrawing: true });
  await open(page);
  await dock(page).getByRole("button", { name: "자석", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menu", { name: "자석 세기", exact: true })).toBeVisible();
  expect(keepSaved(scenario)).toBe(true);
});

test.describe("터치와 마우스를 함께 쓰는 기기", () => {
  test.use({ hasTouch: true });

  test("터치로 알약을 눌러 펼친 뒤 마우스가 막대를 벗어나면 접힌다", async ({ page }) => {
    await open(page);
    await collapsed(page);
    const box = (await dock(page).boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expanded(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(5, 5);
    await collapsed(page);
  });

  test("터치로 펼친 막대는 바깥을 터치로 누르면 접힌다", async ({ page }) => {
    await open(page);
    const box = (await dock(page).boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expanded(page);
    const outside = await chartPoint(page, 0.5, 0.7);
    await page.touchscreen.tap(outside.x, outside.y);
    await collapsed(page);
  });
});
